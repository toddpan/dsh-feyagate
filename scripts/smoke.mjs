#!/usr/bin/env node
/**
 * End-to-end smoke test against the **built** host half.
 *
 * Type-checking proves the modules agree with each other; it proves nothing about
 * whether the thing works. This script therefore loads `lib/index.js` exactly as
 * the loader would, fakes the two Cordis services it injects, and then walks the
 * real path:
 *
 *   1. `apply()` binds the MCP facade and writes `state.json` (the contract the
 *      profile patch depends on).
 *   2. The facade answers `initialize` and `tools/list` while no server is
 *      installed — the behaviour the whole bridge design rests on.
 *   3. The HTTP API answers status / settings / catalog.
 *   4. A **real install** runs: download the published archive from GitHub
 *      Releases, verify its sha256, extract it, activate it, spawn it, and wait
 *      for `/health`.
 *   5. The facade then proxies that same child, and `tools/list` returns the
 *      real tool set.
 *
 * Step 4 needs the network and downloads ~10 MB. Skip it with `--offline`.
 *
 * Usage: node scripts/smoke.mjs [--offline] [--root <dir>] [--keep]
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const offline = argv.includes('--offline')
const keep = argv.includes('--keep')
const rootIndex = argv.indexOf('--root')
const smokeRoot = rootIndex >= 0 ? argv[rootIndex + 1] : join(projectRoot, '.smoke')

const failures = []
const steps = []

function check(name, condition, detail = '') {
  const ok = condition === true
  steps.push({ name, ok, detail })
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ───────────────────────────────────────────────────────── fake Cordis context

const disposers = []
const routes = []
let indexTap = null
const logLines = []

const ctx = {
  logger: {
    info: (...args) => logLines.push(['info', args.join(' ')]),
    warn: (...args) => logLines.push(['warn', args.join(' ')]),
    error: (...args) => logLines.push(['error', args.join(' ')]),
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    tapIndex(transform) {
      indexTap = transform
      return () => {
        indexTap = null
      }
    },
  },
}

console.log(`\n== Feyagate 冒烟测试 ==\n   root: ${smokeRoot}\n   模式: ${offline ? 'offline（跳过下载安装）' : 'online（会真实下载并启动）'}\n`)

if (!keep && existsSync(smokeRoot)) rmSync(smokeRoot, { recursive: true, force: true })
mkdirSync(smokeRoot, { recursive: true })

// ────────────────────────────────────────────────────────── 1. apply()

const { apply } = await import(join(projectRoot, 'lib', 'index.js'))

const started = Date.now()
await apply(ctx, { installRoot: smokeRoot })
console.log(`  · apply() 用时 ${Date.now() - started} ms`)

const statePath = join(smokeRoot, 'state.json')
check('state.json 已写入', existsSync(statePath), statePath)
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
check('state.json 记录了门面端口', Number.isInteger(state.facade?.port), `facade.port=${state.facade?.port}`)
check('settings 尚未安装任何版本', state.currentVersion === null)

const apiRoute = routes.find((route) => route.path === '/dsh-feyagate')
check('注册了 /dsh-feyagate 前缀路由', apiRoute !== undefined && apiRoute.kind === 'prefix')

// ────────────────────────────────────────────── 2. facade answers with no child

const facadePort = state.facade?.port
const facadeUrl = `http://127.0.0.1:${facadePort}/mcp`

const init = await fetchJson(facadeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }),
})
check(
  '门面在未装服务时即可应答 initialize',
  init.body?.result?.serverInfo?.name === 'dsh-feyagate-gateway',
  JSON.stringify(init.body?.result?.serverInfo ?? init.body),
)
check('initialize 声明 tools.listChanged 能力', init.body?.result?.capabilities?.tools?.listChanged === true)

const list = await fetchJson(facadeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
})
check('未装服务时 tools/list 返回空数组（不烧重连预算）', Array.isArray(list.body?.result?.tools) && list.body.result.tools.length === 0)

const call = await fetchJson(facadeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gateway/info', arguments: {} } }),
})
check('未装服务时 tools/call 明确报错而不是假装成功', typeof call.body?.error?.message === 'string' && call.body.error.message.includes('未运行'))

const notification = await fetch(facadeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})
check('通知（无 id）返回 202', notification.status === 202, `HTTP ${notification.status}`)

// ───────────────────────────────────────────────────────── 3. HTTP API

const apiServer = createServer((req, res) => {
  void apiRoute.handler(req, res)
})
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const apiPort = apiServer.address().port
const apiBase = `http://127.0.0.1:${apiPort}/dsh-feyagate`

const health = await fetchJson(`${apiBase}/health`)
check('GET /health 返回插件与平台信息', health.body?.ok === true && health.body.data.platform === 'mac-arm64', JSON.stringify(health.body?.data ?? health.body))

const status = await fetchJson(`${apiBase}/status`)
check('GET /status 报告未安装', status.body?.ok === true && status.body.data.state === 'not-installed', JSON.stringify(status.body?.data?.state))

const settings = await fetchJson(`${apiBase}/settings`)
check('GET /settings 返回默认设置（仅本机监听）', settings.body?.data?.settings?.bindAddress === '127.0.0.1')

const badSettings = await fetchJson(`${apiBase}/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
  body: JSON.stringify({ mirrorBase: 'http://insecure.example' }),
})
check('PUT /settings 拒绝跨站来源', badSettings.status === 403, `HTTP ${badSettings.status}`)

const badMirror = await fetchJson(`${apiBase}/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${apiPort}`, Host: `127.0.0.1:${apiPort}` },
  body: JSON.stringify({ mirrorBase: 'http://insecure.example' }),
})
check('PUT /settings 拒绝非 https 镜像地址', badMirror.status === 400 && typeof badMirror.body?.error === 'string', badMirror.body?.error)

const catalog = await fetchJson(`${apiBase}/install/catalog`)
const catalogVersions = catalog.body?.data?.versions ?? []
check('GET /install/catalog 列出本平台版本', catalog.body?.ok === true && catalogVersions.length > 0, `${catalogVersions.length} 个版本`)
check('目录中至少一个版本带校验值', catalogVersions.some((entry) => entry.sha256 !== null))

const badOrigin = await fetchJson(`${apiBase}/service/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
  body: '{}',
})
check('POST 动作同样拒绝跨站来源', badOrigin.status === 403)

check('index 注入了浏览器全局', indexTap !== null && indexTap('</head>').includes('window.__DSH_FEYAGATE__'))

// ──────────────────────────────────────────────────── 4. real install + start

if (offline) {
  console.log('\n  · 跳过真实下载安装（--offline）')
} else {
  const recommended = catalog.body?.data?.recommended ?? null
  console.log(`\n  · 开始真实安装：v${recommended}（下载 + sha256 校验 + 解压 + 启动）`)
  const installStart = Date.now()

  const started2 = await fetchJson(`${apiBase}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${apiPort}`, Host: `127.0.0.1:${apiPort}` },
    body: JSON.stringify({}),
  })
  check('POST /install 接受任务', started2.body?.ok === true, JSON.stringify(started2.body?.error ?? started2.body?.data?.phase))

  let job = null
  const deadline = Date.now() + 240_000
  let lastPhase = ''
  while (Date.now() < deadline) {
    const current = await fetchJson(`${apiBase}/jobs/current`)
    job = current.body?.data?.job ?? null
    if (job !== null && job.phase !== lastPhase) {
      lastPhase = job.phase
      const percent = job.percent === null ? '' : ` ${job.percent}%`
      console.log(`    · ${job.phase}${percent}${job.message === null ? '' : ` — ${job.message}`}`)
    }
    if (job !== null && (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled')) break
    await sleep(1000)
  }

  check('安装任务成功完成', job?.phase === 'done', job?.error ?? `phase=${job?.phase}`)
  check(`安装用时在 4 分钟内`, Date.now() - installStart < 240_000, `${((Date.now() - installStart) / 1000).toFixed(1)} s`)

  const running = await fetchJson(`${apiBase}/status`)
  const runningStatus = running.body?.data
  check('状态变为运行中', runningStatus?.state === 'running', `state=${runningStatus?.state} detail=${runningStatus?.detail ?? ''}`)
  check('健康检查通过', runningStatus?.healthy === true)
  check('子进程有 pid', typeof runningStatus?.pid === 'number', `pid=${runningStatus?.pid}`)
  check('已安装版本被记录', runningStatus?.installed === true, `current=${runningStatus?.currentVersion}`)

  const childPort = runningStatus?.effectivePort
  check('子进程真实监听端口与配置一致', childPort === runningStatus?.port || typeof childPort === 'number', `port=${childPort}`)

  // The facade must now be a real proxy: the same endpoint that answered an
  // empty list a moment ago must return the child's actual tools.
  const proxied = await fetchJson(facadeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
  })
  const tools = proxied.body?.result?.tools ?? []
  check('门面已转发到子进程，tools/list 返回真实工具', tools.length > 0, `${tools.length} 个工具`)
  check(
    '工具名与上游一致（含 gateway/info）',
    tools.some((tool) => tool.name === 'gateway/info'),
    tools.slice(0, 5).map((tool) => tool.name).join(', '),
  )

  // The plugin's own API must be able to read through to the child as well.
  const overview = await fetchJson(`${apiBase}/account/overview`)
  check('GET /account/overview 读到子进程自述版本', overview.body?.data?.info?.version === recommended, `子进程自述 v${overview.body?.data?.info?.version}`)
  check('overview 报告摄像头能力', typeof overview.body?.data?.cameraSupported === 'boolean', `camera_supported=${overview.body?.data?.cameraSupported}`)

  const stop = await fetchJson(`${apiBase}/service/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${apiPort}`, Host: `127.0.0.1:${apiPort}` },
    body: '{}',
  })
  check('POST /service/stop 停止成功', stop.body?.ok === true)

  const stopped = await fetchJson(`${apiBase}/status`)
  check('停止后状态为已停止', stopped.body?.data?.state === 'stopped', `state=${stopped.body?.data?.state}`)
}

// ───────────────────────────────────────────────────────────── 5. dispose

for (const disposer of disposers.reverse()) {
  try {
    disposer()
  } catch (error) {
    check('disposer 正常执行', false, String(error))
  }
}
const facadeAfterDispose = await fetch(facadeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
}).catch(() => null)
check('卸载后门面已停止监听', facadeAfterDispose === null)

apiServer.close()

console.log('\n== 插件日志 ==')
for (const [level, line] of logLines.slice(-25)) console.log(`  [${level}] ${line}`)

console.log(`\n== 结果：${steps.length - failures.length}/${steps.length} 通过 ==`)
if (failures.length > 0) {
  console.error('\n失败项：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
if (!keep) console.log(`（临时目录 ${smokeRoot} 保留供检查，可手动删除）`)
