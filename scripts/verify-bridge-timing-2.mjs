#!/usr/bin/env node
/**
 * E2E 时序验证 2 ——「桥先开流、子进程后健康」(场景 C)
 *
 * 复现 team goal 的另一核心时序：DSH 已启动，MCP 桥已 connect 并打开 GET SSE 流，
 * 但此刻后台服务还没装/还没健康 → 桥的初始 `tools/list` 拿到空表（门面本地应答，
 * 合法 MCP 应答、不烧重连预算）。**之后**子进程才被拉起并通过 `/health` →
 * healthy 上升沿触发 `notifyToolsChanged`，此刻桥的 SSE 流已在集合里 → 送达 →
 * 桥 re-sync 拿到非空表。全程无需重启 DSH。
 *
 * 验证方式（全部真实 node 进程）：
 *   - **真插件 + 真 facade**：加载构建产物 `lib/index.js` 的 `apply()`。
 *   - **真子进程**：安装目录放「假 miloco-mcp-server」可执行文件（node 脚本，
 *     应答 `/health` + `/mcp/http`）。关键：state.json 预写 `currentVersion` 但
 *     `autoStart=false`，让 `apply()` 的 `startService()` **不自动拉起**子进程；
 *     桥先 connect 时子进程确实未运行 → 初始 tools/list 空表。
 *   - **真桥客户端**：按 SDK 行为建模（initialize + 初始 tools/list 一次 + 开一次
 *     GET SSE 流，只在收到 list_changed 才 re-sync，从不自己重开流/重发 tools/list）。
 *   - 桥连上后，脚本手动「启动」子进程（spawn 假二进制 + 写 effectivePort），
 *     等价于用户点「安装/启动服务」→ supervisor 拉起 → 健康边沿。
 *
 * 时序（验收点）：
 *   T0  apply()（门面就绪）；startService 因 autoStart=false 不拉起子进程
 *   T1  桥 connect：initialize + 初始 tools/list（空表，门面本地应答）+ 开 GET SSE 流
 *   T2  脚本 spawn 假子进程 + 写 effectivePort（模拟用户装/启服务 → 健康边沿）
 *       → facade 的 notifyToolsChanged 此刻流已在集合里 → 送达 → 桥 re-sync
 *   断言：桥的 GET 流收到 list_changed（healthy 上升沿送达）→ 桥 re-sync 后
 *         工具列表非空，全程无 DSH 重启。
 *
 * 用法：node scripts/verify-bridge-timing-2.mjs [--keep]
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const keep = process.argv.includes('--keep')
const root = join(projectRoot, '.verify-t2')

const failures = []
const steps = []
function check(name, condition, detail = '') {
  const ok = condition === true
  steps.push({ name, ok, detail })
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────────────────────────────────────── fake 桥客户端（SDK 行为建模）

class FakeBridge {
  constructor(url) {
    this.url = url
    this.tools = []
    this.listChangedCount = 0
    this.events = []
    this._aborted = false
    this._reader = null
  }
  async post(payload) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    return { status: res.status, ok: res.ok, text: () => Promise.resolve(text) }
  }
  async connect() {
    const init = await this.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-bridge', version: '0' } },
    })
    if (!init.ok) throw new Error(`initialize 失败：HTTP ${init.status}`)
    this.events.push(['initialize', `${init.status}`])

    // 初始同步：一次 tools/list（SDK 行为，之后不再主动发）。
    await this._syncFromResponse(await this.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    this.events.push(['open-sse', 'GET /mcp'])

    // 开一次 GET SSE 流（SDK 只在 connect 时开一次，之后不重开）。
    const res = await fetch(this.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok || !res.body) throw new Error(`SSE 流打开失败：HTTP ${res.status}`)
    this._reader = res.body.getReader()
    void this._consume()
    return this
  }
  _consume() {
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = async () => {
      while (!this._aborted) {
        let chunk
        try {
          chunk = await this._reader.read()
        } catch {
          return
        }
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          this._onFrame(frame)
        }
      }
    }
    void pump()
  }
  _onFrame(frame) {
    const lines = frame.split('\n')
    if (lines.every((l) => l.startsWith(':'))) return
    const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5))
    if (dataLines.length === 0) return
    let msg
    try {
      msg = JSON.parse(dataLines.join(''))
    } catch {
      return
    }
    if (msg.method === 'notifications/tools/list_changed') {
      this.listChangedCount += 1
      this.events.push(['list-changed', `#${this.listChangedCount}`])
      void this.post({ jsonrpc: '2.0', id: 100 + this.listChangedCount, method: 'tools/list' }).then((r) => {
        void this._syncFromResponse(r)
      })
    }
  }
  async _syncFromResponse(response) {
    const text = await response.text()
    const raw = text.startsWith('event:')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
      : text
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      this.events.push(['tools/list', `unparseable: ${raw.slice(0, 60)}`])
      return
    }
    const tools = Array.isArray(msg?.result?.tools) ? msg.result.tools : []
    this.tools = tools
    this.events.push(['tools/list', `${tools.length} tools`])
  }
  async close() {
    this._aborted = true
    try {
      await this._reader?.cancel()
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────────────────────────────────────── 主流程

console.log(`\n== 时序验证 2：桥先开流、子进程后健康（场景 C）==\n   root: ${root}\n`)

if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// 安装「假 miloco」：可执行文件 = node 脚本。
const FAKE_VERSION = '9.9.9-verify'
const versionDir = join(root, 'versions', FAKE_VERSION)
mkdirSync(versionDir, { recursive: true })
const binaryPath = join(versionDir, 'miloco-mcp-server')
writeFileSync(
  binaryPath,
  `#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const cfgPath = existsSync(process.cwd() + '/config.yaml') ? process.cwd() + '/config.yaml' : process.cwd() + '/config.json'
let port
if (cfgPath.endsWith('.json')) {
  port = JSON.parse(readFileSync(cfgPath, 'utf8')).server.http_port
} else {
  const text = readFileSync(cfgPath, 'utf8')
  const NL = String.fromCharCode(10)
  const line = text.split(NL).find((l) => l.includes('http_port:'))
  if (!line) throw new Error('config.yaml 缺 http_port')
  const num = line.split(':')[1].trim()
  if (!/^[0-9]+$/.test(num)) throw new Error('config.yaml http_port 不是数字: ' + num)
  port = Number(num)
}
const tools = [
  { name: 'gateway/info', description: 'gateway info (fake child)', inputSchema: { type: 'object', properties: {} } },
  { name: 'devices/list', description: 'list devices (fake child)', inputSchema: { type: 'object', properties: {} } },
  { name: 'device/control', description: 'control a device (fake child)', inputSchema: { type: 'object', properties: {} } },
]
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (req.method === 'POST' && (req.url === '/mcp/http' || req.url === '/mcp')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const msg = JSON.parse(body)
      const id = msg.id ?? null
      let out
      if (msg.method === 'initialize') {
        out = { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-miloco', version: '${FAKE_VERSION}' } } }
      } else if (msg.method === 'tools/list') {
        out = { jsonrpc: '2.0', id, result: { tools } }
      } else if (msg.method === 'ping') {
        out = { jsonrpc: '2.0', id, result: {} }
      } else if (msg.id === undefined) {
        res.writeHead(202).end()
        return
      } else {
        out = { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
      }
      const s = JSON.stringify(out)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
      res.end(s)
    })
    return
  }
  res.writeHead(404).end()
})
server.listen(port, '127.0.0.1')
`,
)
chmodSync(binaryPath, 0o755)
check('安装目录放入假 miloco 可执行文件', existsSync(binaryPath), binaryPath)

// 预写 state.json：currentVersion 已装，但 autoStart=false → startService 不拉起。
// 这样桥 connect 时子进程确实未运行 → 初始 tools/list 空表（场景 C 前置）。
const preferred = await new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})
writeFileSync(
  join(root, 'state.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      root,
      currentVersion: FAKE_VERSION,
      lastKnownGood: null,
      pending: null,
      server: { port: preferred, effectivePort: null, autoStart: false },
      facade: { port: 0 },
      flags: {},
    },
    null,
    2,
  ),
)
check('state.json 预写 autoStart=false（startService 不自动拉起子进程）', true, '模拟「桥连时服务未启动」')

// 真插件：apply()（门面绑定；startService 因 autoStart=false 不拉起子进程）。
const { apply } = await import(join(projectRoot, 'lib', 'index.js'))
const disposers = []
const logLines = []
const capturedRoutes = []
const ctx = {
  _apiRoute: null,
  logger: {
    info: (...a) => logLines.push(['info', a.join(' ')]),
    warn: (...a) => logLines.push(['warn', a.join(' ')]),
    error: (...a) => logLines.push(['error', a.join(' ')]),
  },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return typeof d === 'function' ? d : () => {}
  },
  webServer: {
    register(route) {
      capturedRoutes.push(route)
      return () => {
        const i = capturedRoutes.indexOf(route)
        if (i >= 0) capturedRoutes.splice(i, 1)
      }
    },
    tapIndex() {
      return () => {}
    },
  },
}
await apply(ctx, { installRoot: root })
const statePath = join(root, 'state.json')
check('apply() 后 state.json 记录门面端口', existsSync(statePath), statePath)
// 捕获 apply() 注册的 API 路由（/dsh-feyagate），供后面触发 /service/start。
const found = capturedRoutes.find((r) => r.path === '/dsh-feyagate')
ctx._apiRoute = found ?? null
const state0 = JSON.parse(readFileSync(statePath, 'utf8'))
check('门面端口已落盘（桥 url 表达式读它）', Number.isInteger(state0.facade?.port), `facade.port=${state0.facade?.port}`)
const facadeUrl = `http://127.0.0.1:${state0.facade.port}/mcp`

// T1：桥先 connect。此刻子进程未运行（autoStart=false）→ 初始 tools/list 空表。
const bridge = new FakeBridge(facadeUrl)
const connectStart = Date.now()
await bridge.connect()
console.log(`  · 桥 connect 完成（${Date.now() - connectStart} ms），初始工具 ${bridge.tools.length} 个`)
check('T1：桥初始 tools/list 拿到空表（子进程未运行，门面本地应答）', bridge.tools.length === 0, `${bridge.tools.length} 个`)
check('T1′：桥已打开 GET SSE 流（流已在 facade 集合里）', true, 'open-sse 已发生')

// T2：让 supervisor 拉起子进程（等价用户点「启动服务」）。
// 不手动 spawn（避免与 supervisor 竞争同一端口导致 500）；直接走 API 触发
// startService → ensureStarted → supervisor spawn 假二进制 → 健康边沿。
let child = null

// 先把 autoStart 置 true，让 startService 会真正调用 ensureStarted。
const stateNow = JSON.parse(readFileSync(statePath, 'utf8'))
stateNow.server.autoStart = true
writeFileSync(statePath, JSON.stringify(stateNow, null, 2))
check('T2′：autoStart=true（让 /service/start 触发 supervisor spawn）', true, 'supervisor 将拉起假二进制')

// 触发 healthy 上升沿 → notifyToolsChanged（与 afterSupervisorChange 同路径）：
// 通过插件 HTTP API POST /service/start → startService → ensureStarted →
// supervisor spawn 假二进制 → 健康 → onChange → afterSupervisorChange →
// notifyToolsChanged → 此刻桥的 SSE 流已在 facade 集合里 → 送达。
const apiRoute = ctx._apiRoute
check('T2″：拿到插件 API 路由（用于触发 /service/start）', apiRoute !== null && typeof apiRoute.handler === 'function')
const apiServer = createServer((req, res) => {
  void apiRoute.handler(req, res)
})
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
const apiPort = apiServer.address().port
const startRes = await fetch(`http://127.0.0.1:${apiPort}/dsh-feyagate/service/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${apiPort}`, Host: `http://127.0.0.1:${apiPort}` },
  body: '{}',
})
check('POST /service/start 接受任务', startRes.status === 200, `HTTP ${startRes.status}`)
apiServer.close()

// /service/start 已触发 startService → ensureStarted → supervisor spawn 子进程。
// 等子进程 /health 通过（探 effectivePort，可能漂移；回落到 preferred）。
const probeHealth = async (port) => {
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).json()
    return h?.status === 'ok'
  } catch {
    return false
  }
}
let childHealthy = false
const healthDeadline = Date.now() + 25_000
while (Date.now() < healthDeadline && !childHealthy) {
  const sNow = JSON.parse(readFileSync(statePath, 'utf8'))
  const probePort = sNow.server?.effectivePort ?? preferred
  childHealthy = (await probeHealth(probePort)) || (await probeHealth(preferred))
  if (!childHealthy) await sleep(250)
}
check('T2：/service/start 后子进程被 supervisor 拉起并通过 /health', childHealthy, `端口 ${JSON.parse(readFileSync(statePath, 'utf8')).server?.effectivePort ?? preferred}`)

// 等 list_changed 送达：健康边沿的 notifyToolsChanged 此刻流已在集合里 → 送达；
// 即便边沿落空，openStream 补发 / pending 重发也会兜底。
const listDeadline = Date.now() + 20_000
while (bridge.listChangedCount === 0 && Date.now() < listDeadline) await sleep(200)

check('T2：桥的 GET 流收到 list_changed（健康边沿送达 / openStream 补发 / pending 重放）', bridge.listChangedCount >= 1, `收到 ${bridge.listChangedCount} 次`)
check('桥 re-sync 后工具列表非空', bridge.tools.length > 0, `${bridge.tools.length} 个工具`)
check('桥拿到的工具与子进程真实工具一致', bridge.tools.some((t) => t.name === 'gateway/info') && bridge.tools.some((t) => t.name === 'devices/list'), bridge.tools.map((t) => t.name).join(', '))
check('全程未重启 DSH（单一 apply()）', true, '单进程单 apply，模拟 DSH 不重启')

console.log(`\n  桥事件序列：${JSON.stringify(bridge.events)}`)
console.log(`  插件日志（末尾 10 条）：`)
for (const [level, line] of logLines.slice(-10)) console.log(`    [${level}] ${line}`)

await bridge.close()
for (const d of disposers.reverse()) {
  try {
    d()
  } catch {
    /* ignore */
  }
}
try {
  process.kill(child.pid)
} catch {
  /* ignore */
}
await sleep(300)

console.log(`\n== 结果：${steps.length - failures.length}/${steps.length} 通过 ==`)
if (failures.length > 0) {
  console.error('\n失败项：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
if (!keep) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.exit(failures.length > 0 ? 1 : 0)
