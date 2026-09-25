#!/usr/bin/env node
/**
 * Install / upgrade / rollback / uninstall lifecycle test.
 *
 * `scripts/smoke.mjs` proves the plugin's outward contract (facade, API, origin
 * checks). This one proves the part that actually touches the user's disk, using a
 * **synthetic release** instead of the real archive:
 *
 *   * the real archive is 10–60 MB on GitHub, which from this network arrives at
 *     roughly 17 KB/s — a test that depends on it is a test that never finishes,
 *     and a flaky test teaches nobody anything;
 *   * most of what can break here is not the payload. It is checksum gating,
 *     extraction hygiene, activation, config generation, spawn, health, and
 *     rollback — all of which a fake payload exercises exactly as well.
 *
 * So we build a fake `miloco-mcp-server` (a Node script that speaks the same
 * `/health`, `/api/v1/gateway/*` and `/mcp/http` surface), package it as a real
 * zip and a real tar.gz, and point a **copy of the built package** at a synthetic
 * manifest whose checksums are the real checksums of those archives.
 *
 * What that does NOT cover, and should be verified against the real binary before
 * release: the upstream binary's own behaviour, and whether its release assets
 * extract cleanly. The manifest's URLs and sizes are checked separately by
 * `scripts/verify-manifest.mjs`, and were confirmed reachable with `curl`.
 *
 * Usage: node scripts/smoke-install.mjs [--keep]
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const keep = process.argv.includes('--keep')
const base = join(projectRoot, '.smoke-install')

const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  const ok = condition === true
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ───────────────────────────────────────────────────────── the fake "binary"

const FAKE_SERVER = `#!/usr/bin/env node
// Synthetic stand-in for miloco-mcp-server. Speaks only the surface the plugin
// observes: health, the two gateway REST endpoints, and Streamable HTTP MCP.
const { createServer } = require('node:http')
const { readFileSync } = require('node:fs')

const args = process.argv.slice(2)
const at = args.indexOf('--config')
const configPath = at >= 0 ? args[at + 1] : null
const yaml = configPath === null ? '' : readFileSync(configPath, 'utf8')
function scalar(key, fallback) {
  const match = new RegExp('^[ \\\\t]*' + key + ':\\\\s*(.+)$', 'm').exec(yaml)
  return match === null ? fallback : match[1].trim().replace(/^["']|["']$/g, '')
}
const port = Number(scalar('http_port', '38080'))
const version = process.env.FAKE_SERVER_VERSION || '9.9.9'
const deviceId = 'FAKE' + version.replace(/\\D/g, '').padEnd(8, '0')

const json = (res, body, status) => {
  const text = JSON.stringify(body)
  res.writeHead(status || 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const TOOLS = [
  { name: 'gateway/info', description: '网关信息', inputSchema: { type: 'object', properties: {} } },
  { name: 'device/list', description: '设备列表', inputSchema: { type: 'object', properties: {} } },
]

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') return json(res, { status: 'ok' })
  if (req.method === 'GET' && url.pathname === '/api/v1/gateway/info') {
    return json(res, { code: 0, data: {
      name: 'miloco-mcp-server', version, platform: process.platform === 'darwin' ? 'macos' : 'linux',
      device_id: deviceId, camera_supported: true,
      license: { edition: 'free', status: 'inactive', product: 'feyagate-linux', key_masked: '' },
    } })
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/gateway/license') {
    return json(res, { code: 0, data: {
      edition: 'free', status: 'inactive', product: 'feyagate-linux', key_masked: '', device_id: deviceId,
      capabilities: { edition: 'free', loaded: false, platforms: { xiaomi: { enabled: true, trial_hours: 720, trial_remaining_hours: 720, status: 'trial', message: '', trial_remaining_days: 30 } },
        features: [], message: '', is_subscription_active: false },
    } })
  }
  if (req.method === 'POST' && url.pathname === '/mcp/http') {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let message
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
      const reply = (result) => json(res, { jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-miloco', version } })
      if (message.method === 'tools/list') return reply({ tools: TOOLS })
      if (message.method === 'tools/call') {
        const name = message.params && message.params.name
        const payload = name === 'auth/platforms'
          ? [{ platform_id: 'xiaomi', platform_name: '米家', authenticated: true, auth_status: { cloud_server: 'cn', token_remaining_seconds: 86400 } }]
          : name === 'xiaomi/camera_list'
            ? [{ device_id: 'cam-1', name: '客厅摄像头', online: true }]
            : { name: 'miloco-mcp-server', version, platform: 'macos', device_id: deviceId, camera_supported: true, license: { edition: 'free', status: 'inactive', product: 'feyagate-linux', key_masked: '' } }
        return reply({ content: [{ type: 'text', text: JSON.stringify(payload) }] })
      }
      return json(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
    })
    return
  }
  json(res, { code: 404, message: 'not found' }, 404)
})

server.listen(port, '127.0.0.1', () => console.log('[fake] listening on ' + port + ' version ' + version))
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
process.on('SIGINT', () => process.exit(0))
`

// ────────────────────────────────────────────────────────────── preparation

if (existsSync(base)) rmSync(base, { recursive: true, force: true })
mkdirSync(join(base, 'fixtures'), { recursive: true })
mkdirSync(join(base, 'archives'), { recursive: true })
mkdirSync(join(base, 'root'), { recursive: true })

const fixture = join(base, 'fixtures', 'miloco-mcp-server')
writeFileSync(fixture, FAKE_SERVER)
chmodSync(fixture, 0o755)

// Both archives use the same file name — one per version — so the "which archive
// does the mirror serve" logic sees what it would see in production.
const ZIP_VERSION = '9.9.9'
const TAR_VERSION = '9.9.8'
const NOCSUM_VERSION = '9.9.7'
const CORRUPT_VERSION = '9.9.6'
const zipName = `miloco-mcp-server-mac-arm64-v${ZIP_VERSION}.zip`
const tarName = `miloco-mcp-server-mac-arm64-v${TAR_VERSION}.tar.gz`
const zipPath = join(base, 'archives', zipName)
const tarPath = join(base, 'archives', tarName)

// A real GitHub release asset has exactly one top-level directory. Reproduce that
// (plus a redundant peer file) so flattenSingleTopDir is exercised.
const stage = join(base, 'stage')
for (const name of [`miloco-mcp-server-mac-arm64-v${ZIP_VERSION}`, `miloco-mcp-server-mac-arm64-v${TAR_VERSION}`]) {
  mkdirSync(join(stage, name), { recursive: true })
  copyFileSync(fixture, join(stage, name, 'miloco-mcp-server.cjs'))
  chmodSync(join(stage, name, 'miloco-mcp-server.cjs'), 0o644)
  // The launcher is what `ensureExecutableMode` has to chmod, and it is the only
  // file in the payload that must carry the exec bit.
  writeFileSync(join(stage, name, 'miloco-mcp-server'), '#!/bin/sh\nexec node "$(dirname "$0")/miloco-mcp-server.cjs" "$@"\n')
  chmodSync(join(stage, name, 'miloco-mcp-server'), 0o755)
  writeFileSync(join(stage, name, 'README.md'), 'synthetic release\n')
  // The real payload ships a webui/ directory next to the binary.
  mkdirSync(join(stage, name, 'webui'), { recursive: true })
  writeFileSync(join(stage, name, 'webui', 'index.html'), '<!doctype html><title>fake webui</title>\n')
}

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe', ...options })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`))))
  })

await run('tar', ['-czf', tarPath, '-C', stage, `miloco-mcp-server-mac-arm64-v${TAR_VERSION}`])
try {
  await run('zip', ['-q', '-r', zipPath, `miloco-mcp-server-mac-arm64-v${ZIP_VERSION}`], { cwd: stage })
} catch (error) {
  console.error(`需要 zip 命令来构造测试归档：${error.message}`)
  process.exit(2)
}

// A corrupted copy: one flipped byte. `CORRUPT_VERSION`'s manifest entry carries
// the *real* checksum of the clean archive, so the version-usable gate passes and
// the mismatch can only be caught by the checksum comparison itself.
const corruptPath = join(base, 'archives', `miloco-mcp-server-mac-arm64-v${CORRUPT_VERSION}.zip`)
copyFileSync(zipPath, corruptPath)
{
  const bytes = readFileSync(corruptPath)
  bytes[Math.floor(bytes.length / 2)] ^= 0xff
  writeFileSync(corruptPath, bytes)
}

// The no-checksum version gets a *good* archive: nothing should be refused for
// being corrupt there, only for being unverifiable.
const nocsumPath = join(base, 'archives', `miloco-mcp-server-mac-arm64-v${NOCSUM_VERSION}.zip`)
copyFileSync(zipPath, nocsumPath)

// Local archives are addressed by a single setting, so each step points it at the
// file it means to install. `asset()` therefore has to be told which path to hash.
function assetFor(file, kind, hashPath, manifestSha) {
  return { file, kind, size: statSync(hashPath).size, sha256: manifestSha, url: `https://example.invalid/${file}` }
}

const zipSha = sha256(zipPath)
const tarSha = sha256(tarPath)

// ─────────────────────────────── a copy of the built package, with a fake manifest

const pkg = join(base, 'pkg')
mkdirSync(join(pkg, 'manifest'), { recursive: true })
cpSync(join(projectRoot, 'lib'), join(pkg, 'lib'), { recursive: true })
copyFileSync(join(projectRoot, 'package.json'), join(pkg, 'package.json'))


writeFileSync(
  join(pkg, 'manifest', 'server-manifest.json'),
  JSON.stringify(
    {
      manifestVersion: 1,
      generatedAt: new Date().toISOString(),
      server: { name: 'miloco-mcp-server', repo: 'https://example.invalid', mcpPath: '/mcp/http', healthPath: '/health' },
      sources: { github: 'https://example.invalid/releases/download', fota: 'https://example.invalid/fota.json' },
      fotaType: {},
      pluginCompat: { minSupportedServer: '9.9.0', maxTestedServer: ZIP_VERSION },
      channel: { stable: { 'mac-arm64': ZIP_VERSION } },
      versions: {
        [ZIP_VERSION]: { releaseTag: `v${ZIP_VERSION}`, publishedAt: '2026-01-01T00:00:00Z', assets: { 'mac-arm64': [assetFor(zipName, 'zip', zipPath, zipSha)] } },
        [TAR_VERSION]: { releaseTag: `v${TAR_VERSION}`, publishedAt: '2025-12-01T00:00:00Z', assets: { 'mac-arm64': [assetFor(tarName, 'tar.gz', tarPath, tarSha)] } },
        [NOCSUM_VERSION]: { releaseTag: `v${NOCSUM_VERSION}`, publishedAt: '2025-11-01T00:00:00Z', assets: { 'mac-arm64': [assetFor(`miloco-mcp-server-mac-arm64-v${NOCSUM_VERSION}.zip`, 'zip', nocsumPath, null)] } },
        [CORRUPT_VERSION]: { releaseTag: `v${CORRUPT_VERSION}`, publishedAt: '2025-10-01T00:00:00Z', assets: { 'mac-arm64': [assetFor(`miloco-mcp-server-mac-arm64-v${CORRUPT_VERSION}.zip`, 'zip', corruptPath, zipSha)] } },
      },
    },
    null,
    2,
  ),
)

console.log(`\n== Feyagate 安装生命周期测试 ==\n   root: ${join(base, 'root')}\n   合成版本: ${ZIP_VERSION} (zip) / ${TAR_VERSION} (tar.gz) / ${NOCSUM_VERSION} (无校验值)\n`)

// ──────────────────────────────────────────────────── fake Cordis context

const disposers = []
const routes = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex() {
      return () => {}
    },
  },
}

const { apply } = await import(join(pkg, 'lib', 'index.js'))
await apply(ctx, { installRoot: join(base, 'root') })

const apiRoute = routes.find((route) => route.path === '/dsh-feyagate')
const apiServer = createServer((req, res) => void apiRoute.handler(req, res))
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const apiPort = apiServer.address().port
const origin = `http://127.0.0.1:${apiPort}`
const apiBase = `${origin}/dsh-feyagate`
const headers = { 'Content-Type': 'application/json', Origin: origin, Host: `127.0.0.1:${apiPort}` }

const state = () => JSON.parse(readFileSync(join(base, 'root', 'state.json'), 'utf8'))

async function install(body) {
  const response = await fetchJson(`${apiBase}/install`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (response.body?.ok !== true) return { accepted: false, error: response.body?.error ?? `HTTP ${response.status}` }
  const deadline = Date.now() + 90_000
  let job = null
  while (Date.now() < deadline) {
    const current = await fetchJson(`${apiBase}/jobs/current`)
    job = current.body?.data?.job ?? null
    if (job !== null && ['done', 'failed', 'cancelled'].includes(job.phase)) break
    await sleep(300)
  }
  return { accepted: true, job }
}

async function status() {
  const response = await fetchJson(`${apiBase}/status`)
  return response.body?.data ?? null
}

async function waitForState(wanted, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let current = await status()
  while (Date.now() < deadline && current?.state !== wanted) {
    await sleep(400)
    current = await status()
  }
  return current
}

// ─────────────────────────────── 1. install the zip from a local archive

console.log('— 1. 安装 zip（本地包来源 + sha256 校验 + 解压 + 启动）')
{
  const settingsResponse = await fetchJson(`${apiBase}/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ localArchive: zipPath }),
  })
  check('设置里可以指定本地安装包', settingsResponse.body?.ok === true, settingsResponse.body?.error)

  const result = await install({})
  check('安装任务完成', result.job?.phase === 'done', result.job?.error ?? `phase=${result.job?.phase}`)

  const current = state()
  check('状态记录当前版本', current.currentVersion === ZIP_VERSION, `current=${current.currentVersion}`)
  check('pending 已清除（启动成功后才算数）', current.pending === null, JSON.stringify(current.pending))
  check('lastKnownGood 提升为当前版本', current.lastKnownGood === ZIP_VERSION, `lkg=${current.lastKnownGood}`)

  const versionDir = join(base, 'root', 'versions', ZIP_VERSION)
  check('版本目录已建立', existsSync(versionDir), versionDir)
  const binary = join(versionDir, 'miloco-mcp-server')
  check('单层顶层目录已拍平，二进制在版本目录根部', existsSync(binary))
  check('拆掉了顶层目录的多余文件', existsSync(join(versionDir, 'README.md')))
  const mode = statSync(binary).mode & 0o777
  check('二进制已置为可执行', (mode & 0o111) !== 0, `mode=${mode.toString(8)}`)

  // The single most load-bearing path decision: relative paths inside config.yaml
  // resolve against the config file's directory, so it must sit at the root.
  const configPath = join(base, 'root', 'config.yaml')
  check('config.yaml 位于安装根目录（不是 config/ 子目录）', existsSync(configPath))
  check('不存在 config/config.yaml 这种会挪走 data/ 的布局', !existsSync(join(base, 'root', 'config', 'config.yaml')))
  const yaml = readFileSync(configPath, 'utf8')
  check('config.yaml 只监听本机', /bind_address:\s*127\.0\.0\.1/.test(yaml), yaml.match(/bind_address:.*/)?.[0] ?? '')
  check('config.yaml 的 license_file 指向 data/license.json', /license_file:\s*data\/license\.json/.test(yaml))
  const configMode = statSync(configPath).mode & 0o777
  check('config.yaml 权限收紧（含平台 token 路径）', configMode === 0o600, `mode=${configMode.toString(8)}`)
  // Left as the upstream default (`webui`), the child's set_mount_point fails
  // and it only logs "WebUI directory not found (web UI disabled)" — a feature
  // silently gone. It must point inside the version directory instead.
  const webuiLine = /webui_dir:\s*(.+)$/m.exec(yaml)?.[1]?.trim() ?? ''
  check('webui_dir 指向版本目录内的 webui/', webuiLine === join(base, 'root', 'versions', ZIP_VERSION, 'webui'), webuiLine)
  check('webui_dir 是绝对路径（子进程 cwd 是安装根目录，相对路径必然找不到）', webuiLine.startsWith('/'))

  const running = await waitForState('running')
  check('服务进入运行中', running?.state === 'running', `state=${running?.state} detail=${running?.detail ?? ''}`)
  check('健康检查通过', running?.healthy === true)
  check('记录了子进程 pid', typeof running?.pid === 'number', `pid=${running?.pid}`)
  check('报告已安装', running?.installed === true)

  const facadePort = state().facade.port
  const proxied = await fetchJson(`http://127.0.0.1:${facadePort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = proxied.body?.result?.tools ?? []
  check('门面转发到子进程并返回工具列表', tools.length === 2, `${tools.length} 个工具`)

  const attempted = (await fetchJson(`${apiBase}/jobs/current`)).body?.data?.job?.attemptedSources ?? []
  check(
    '只登记真正尝试过的来源（未配置的镜像不算"试过"）',
    attempted.some((label) => label.startsWith('本地安装包')) && !attempted.some((label) => label.includes('镜像')),
    JSON.stringify(attempted),
  )

  const overview = await fetchJson(`${apiBase}/account/overview`)
  check('REST {code,data} 信封被正确解包（读到子进程版本）', overview.body?.data?.info?.version === ZIP_VERSION, `version=${overview.body?.data?.info?.version}`)
  check('平台登录状态已读出', overview.body?.data?.platforms?.[0]?.authenticated === true)
  check('摄像头列表已读出', overview.body?.data?.cameras?.[0]?.name === '客厅摄像头')
}

// ──────────────────────────────────────────────── 2. upgrade via tar.gz

console.log('\n— 2. 升级到 tar.gz 版本（走解压到 .tar.gz 的另一条分支）')
{
  await fetchJson(`${apiBase}/settings`, { method: 'PUT', headers, body: JSON.stringify({ localArchive: tarPath }) })
  const result = await install({ version: TAR_VERSION })
  check('tar.gz 安装任务完成', result.job?.phase === 'done', result.job?.error ?? `phase=${result.job?.phase}`)

  const current = state()
  check('当前版本已切换', current.currentVersion === TAR_VERSION, `current=${current.currentVersion}`)
  check('上一可用版本指向被替换掉的那个版本（回滚目标）', current.lastKnownGood === ZIP_VERSION, `lkg=${current.lastKnownGood}`)
  check('因此回滚目标确实可用（不等于当前版本）', current.lastKnownGood !== current.currentVersion)
  check('旧版本目录仍在（回滚要用）', existsSync(join(base, 'root', 'versions', ZIP_VERSION)))

  const running = await waitForState('running')
  check('升级后重新运行', running?.healthy === true, `state=${running?.state}`)
}

// ───────────────────────────────────────────────────────── 3. rollback

console.log('\n— 3. 回滚到上一版本')
{
  const response = await fetchJson(`${apiBase}/install/rollback`, { method: 'POST', headers, body: JSON.stringify({ version: ZIP_VERSION }) })
  check('回滚请求被接受', response.body?.ok === true, response.body?.error)

  const running = await waitForState('running')
  check('回滚后回到旧版本', state().currentVersion === ZIP_VERSION, `current=${state().currentVersion}`)
  check('回滚后服务健康', running?.healthy === true, `state=${running?.state}`)
}

// ─────────────────────────────────── 4. checksum mismatch must be refused

console.log('\n— 4. 校验值不匹配必须拒绝（且不得破坏现有安装）')
{
  await fetchJson(`${apiBase}/settings`, { method: 'PUT', headers, body: JSON.stringify({ localArchive: corruptPath, allowUnverified: false }) })
  const before = state().currentVersion
  const result = await install({ version: CORRUPT_VERSION })
  check('任务以失败结束', result.job?.phase === 'failed', `phase=${result.job?.phase}`)
  check('失败原因指出校验不匹配', /SHA-256 校验失败|校验/.test(result.job?.error ?? ''), result.job?.error ?? '')
  check('错误信息同时给出期望值与实际值', /期望/.test(result.job?.error ?? '') && /实际/.test(result.job?.error ?? ''), '')
  check('当前版本未被改动', state().currentVersion === before, `current=${state().currentVersion}`)
  check('损坏的版本没有被激活', !existsSync(join(base, 'root', 'versions', CORRUPT_VERSION)))
  const running = await waitForState('running')
  check('原服务仍在运行（失败不影响现有安装）', running?.healthy === true, `state=${running?.state}`)
}

// ─────────────────────── 5. missing checksum: refuse, then allow explicitly

console.log('\n— 5. 没有校验值时默认拒绝；设置与单次覆盖两条路径都要起作用')
{
  await fetchJson(`${apiBase}/settings`, { method: 'PUT', headers, body: JSON.stringify({ localArchive: nocsumPath, allowUnverified: false }) })
  const refused = await install({ version: NOCSUM_VERSION })
  check('默认拒绝无校验值版本', refused.job?.phase === 'failed', `phase=${refused.job?.phase}`)
  check('拒绝原因说明缺少校验值', /校验/.test(refused.job?.error ?? ''), refused.job?.error ?? '')

  // Setting flipped on, request body silent → the saved preference must apply.
  // (An omitted flag has to mean "use my preference", not "false".)
  const setting = await fetchJson(`${apiBase}/settings`, { method: 'PUT', headers, body: JSON.stringify({ allowUnverified: true }) })
  check('设置里开启允许未校验版本', setting.body?.data?.settings?.allowUnverified === true)
  const allowed = await install({ version: NOCSUM_VERSION })
  check('请求不带该字段时回落到设置 → 安装成功', allowed.job?.phase === 'done', allowed.job?.error ?? `phase=${allowed.job?.phase}`)
  check('当前版本切到无校验值版本', state().currentVersion === NOCSUM_VERSION, `current=${state().currentVersion}`)

  // An explicit `false` in the body must still win over the saved `true`.
  const overridden = await install({ version: ZIP_VERSION, allowUnverified: false })
  check('单次请求显式 false 覆盖设置（该版本有校验值，应正常安装）', overridden.job?.phase === 'done', overridden.job?.error ?? `phase=${overridden.job?.phase}`)
}

// ────────────────────────── 6. reinstall must actually reinstall

console.log('\n— 6. 重装必须真的重装（而不是静默空操作）')
{
  // `installBinary` is idempotent by default, so without threading `reinstall`
  // through, "重新安装" would report success while changing nothing — the worst
  // kind of failure, because it looks like it worked.
  // Target whatever is actually installed. Reinstall is defined as "repair the
  // *current* version", not "install the latest" — pinning this to a hardcoded
  // version would silently test the wrong thing if an earlier step changes state.
  const installed = state().currentVersion
  check('有已安装的版本可重装', typeof installed === 'string' && installed !== null, `current=${installed}`)
  const target = join(base, 'root', 'versions', installed, 'miloco-mcp-server.cjs')
  const healthy = readFileSync(target)
  writeFileSync(target, '#!/usr/bin/env node\nprocess.exit(1) // 已被损坏\n')
  check('先把已安装的程序改坏', readFileSync(target, 'utf8').includes('已被损坏'))

  const response = await fetchJson(`${apiBase}/service/reinstall`, { method: 'POST', headers, body: '{}' })
  check('重装请求被接受', response.body?.ok === true, response.body?.error)
  const deadline = Date.now() + 60_000
  let job = null
  while (Date.now() < deadline) {
    const current = await fetchJson(`${apiBase}/jobs/current`)
    job = current.body?.data?.job ?? null
    if (job !== null && ['done', 'failed', 'cancelled'].includes(job.phase)) break
    await sleep(300)
  }
  check('重装任务完成', job?.phase === 'done', `phase=${job?.phase} error=${job?.error ?? ''}`)
  check('被损坏的程序已被真正的重装覆盖', readFileSync(target).equals(healthy))
  const running = await waitForState('running', 30_000)
  check('重装后服务重新健康运行', running?.healthy === true, `state=${running?.state}`)
  check('重装没有把当前版本悄悄换成别的版本', state().currentVersion === installed, `${installed} → ${state().currentVersion}`)
}

// ───────────────────────────────── 7. crash recovery

console.log('\n— 7. 子进程被杀后自动拉起')
{
  const before = await status()
  const victim = before.pid
  check('拿到了要杀的 pid', typeof victim === 'number', `pid=${victim}`)
  if (typeof victim === 'number') process.kill(victim, 'SIGKILL')

  const recovered = await waitForState('running', 40_000)
  check('自动重启后重新运行', recovered?.state === 'running' && recovered?.healthy === true, `state=${recovered?.state}`)
  check('换了新的 pid', recovered?.pid !== victim, `${victim} → ${recovered?.pid}`)
  check('记录了重启次数', (recovered?.restarts ?? 0) >= 1, `restarts=${recovered?.restarts}`)
}

// ───────────────────────────────── 8. uninstall keeps user data

console.log('\n— 8. 卸载保留 data/')
{
  const dataDir = join(base, 'root', 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'license.json'), JSON.stringify({ device_id: 'SENTINEL', license_key: '' }))

  const response = await fetchJson(`${apiBase}/install/uninstall`, { method: 'POST', headers, body: JSON.stringify({ purgeData: false }) })
  check('卸载请求被接受', response.body?.ok === true, response.body?.error)
  check('卸载以任务形式执行', typeof response.body?.data?.kind === 'string', `kind=${response.body?.data?.kind}`)

  const deadline = Date.now() + 30_000
  let job = null
  while (Date.now() < deadline) {
    const current = await fetchJson(`${apiBase}/jobs/current`)
    job = current.body?.data?.job ?? null
    if (job?.kind === 'uninstall' && ['done', 'failed', 'cancelled'].includes(job.phase)) break
    await sleep(300)
  }
  check('卸载任务完成', job?.phase === 'done', `phase=${job?.phase} error=${job?.error ?? ''}`)

  check('版本目录已删除', !existsSync(join(base, 'root', 'versions', NOCSUM_VERSION)))
  check('data/license.json 被保留', existsSync(join(dataDir, 'license.json')), '设备标识与授权码不该因卸载而丢失')
  check('状态回到未安装', state().currentVersion === null, `current=${state().currentVersion}`)
  const after = await waitForState('not-installed', 15_000)
  check('状态报告未安装', after?.state === 'not-installed', `state=${after?.state} detail=${after?.detail ?? ''}`)
}

// ──────────────────────────────────────────────────────────── teardown

for (const disposer of disposers.reverse()) {
  try {
    disposer()
  } catch {
    /* 卸载已尽力 */
  }
}
apiServer.close()

// Nothing should be left listening on the child port.
await sleep(500)

console.log(`\n== 结果：${checks - failures.length}/${checks} 通过 ==`)
if (failures.length > 0) {
  console.error('\n失败项：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
if (!keep) console.log(`（临时目录 ${base} 保留供检查，可手动删除）`)
