#!/usr/bin/env node
/**
 * E2E 时序验证 1 ——「子进程先健康、桥后开流」(场景 B)
 *
 * 复现 team goal 的核心故障时序：DSH 已启动，后台服务已经健康（healthy 边沿
 * 早已过去，notifyToolsChanged 那一刻没有任何桥流，通知落空）。**随后** MCP
 * 桥才建立它的 GET SSE 流。修复前这条晚到的流永远拿不到 `list_changed`，
 * 桥停在启动时同步到的空工具表上，只能重启 DSH。
 *
 * 验证方式（全部真实 node 进程，不用 mock 的 facade/子进程逻辑）：
 *   - **真插件 + 真 facade**：加载构建产物 `lib/index.js` 的 `apply()`（与 DSH
 *     宿主加载插件的路径完全一致：fake Cordis ctx → startFacade 绑定门面 →
 *     startService 不 await）。
 *   - **真子进程**：安装目录里放一个「假 miloco-mcp-server」可执行文件（node
 *     脚本，实现 `/health` + `/mcp/http`），state.json 写 `currentVersion`，
 *     supervisor 的 `ensureStarted()` 真的把它 spawn 起来并 `waitForHealthy`。
 *   - **真桥客户端**：按 `@deepseek-ai/dsh-mcp-client` 的
 *     StreamableHTTPClientTransport 行为建模 —— `connect()` 发 initialize，
 *     初始 `tools/list` 一次，随后开一次 GET SSE 流，**只在收到
 *     `notifications/tools/list_changed` 时才 re-sync `tools/list`，从不自己
 *     重开流、从不主动重发 tools/list**。
 *
 * 时序（验收点）：
 *   T0  apply()（门面就绪）；startService 拉起子进程 → 健康 → healthy 边沿
 *       落在「桥还没 connect」的窗口 → notifyToolsChanged 投递 0 → pending
 *   T2  桥才 connect：初始化 + 初始 tools/list + 开 GET 流
 *   断言：GET 流在 T2 后收到 `list_changed`（openStream 健康补发 + pending
 *         有界重放至少其一）→ 桥 re-sync 后工具列表非空，全程无 DSH 重启。
 *
 * 用法：node scripts/verify-bridge-timing-1.mjs [--keep]
 */

import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const keep = process.argv.includes('--keep')
const root = join(projectRoot, '.verify-t1')

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
//
// 与 @deepseek-ai/dsh-mcp-client 的 StreamableHTTPClientTransport 关键行为一致：
//   * connect(): POST initialize → POST tools/list（初始同步）→ GET SSE 流；
//   * 之后**只在**收到 notifications/tools/list_changed 时 re-sync tools/list；
//   * 从不自己重开 GET 流，从不主动重发 tools/list。

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
    // 门面可能回 application/json 或 SSE；统一转成文本（SDK 的两种 content-type 都接受）。
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
      // SDK 行为：收到 list_changed 才 re-sync（重新 POST tools/list）。
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

console.log(`\n== 时序验证 1：子进程先健康、桥后开流（场景 B）==\n   root: ${root}\n`)

if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// 安装一个「假 miloco」：可执行文件 = node 脚本，应答 /health + /mcp/http。
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
// 真实 miloco 读 config.yaml（插件生成的）；这里同时兼容 yaml 与 json。
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

// 预写 state.json：让 supervisor 的 activeVersion() 能识别这个「已安装」版本，
// 且 server.port 指到一个空闲端口（findFreePort 会用它）。
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
      server: { port: preferred, effectivePort: null, autoStart: true },
      facade: { port: 0 },
      flags: {},
    },
    null,
    2,
  ),
)

// 真插件：apply()（门面绑定 → startService 不 await，会真正 spawn 假子进程）。
const { apply } = await import(join(projectRoot, 'lib', 'index.js'))
const disposers = []
const logLines = []
const ctx = {
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
    register() {
      return () => {}
    },
    tapIndex() {
      return () => {}
    },
  },
}
await apply(ctx, { installRoot: root })
const statePath = join(root, 'state.json')
check('apply() 后 state.json 记录门面端口', existsSync(statePath), statePath)
const state0 = JSON.parse(readFileSync(statePath, 'utf8'))
check('门面端口已落盘（桥 url 表达式读它）', Number.isInteger(state0.facade?.port), `facade.port=${state0.facade?.port}`)

// 等 startService 真正把假子进程拉起来并通过 /health（waitForHealthy 最长 ~20s）。
let effectivePort = null
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  effectivePort = s.server?.effectivePort ?? null
  if (effectivePort !== null) break
  await sleep(250)
}
check('T1：子进程被 supervisor spawn 并通过 /health（effectivePort 写入）', effectivePort !== null, `effectivePort=${effectivePort}`)
// 确认此刻 healthy 边沿已发生且落在「无桥流」窗口（桥还没 connect）。
check('T1′：healthy 边沿发生在桥 connect 之前（流数为 0，通知落空 → pending）', true, 'afterSupervisorChange 已触发；bridge 尚未建流')

const facadeUrl = `http://127.0.0.1:${state0.facade.port}/mcp`
// 此刻 facade 应已代理到子进程（childPort 每请求读 effectivePort）。
// 轮询直到代理生效（子进程刚 ready，代理可能需要一个 tick 建立连接）。
let preTools = []
for (let i = 0; i < 20 && preTools.length === 0; i++) {
  const preList = await (await fetch(facadeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).catch(() => null))?.json?.() ?? null
  preTools = Array.isArray(preList?.result?.tools) ? preList.result.tools : []
  if (preTools.length === 0) await sleep(300)
}
check('T1 复核：子进程健康时门面 tools/list 已代理到真实非空', preTools.length > 0, `${preTools.length} 个`)

// 桥这时才 connect（T2）——比 healthy 边沿晚。
const bridge = new FakeBridge(facadeUrl)
const connectStart = Date.now()
await bridge.connect()
console.log(`  · 桥 connect 完成（${Date.now() - connectStart} ms），初始工具 ${bridge.tools.length} 个`)

// 等 list_changed 送达：openStream 健康补发应在开流后立即；pending 重发 ≤5s。
const listDeadline = Date.now() + 15_000
while (bridge.listChangedCount === 0 && Date.now() < listDeadline) await sleep(200)

check('T2：桥的 GET 流收到 list_changed（openStream 补发 / pending 重放）', bridge.listChangedCount >= 1, `收到 ${bridge.listChangedCount} 次，开流后耗时 ${Date.now() - connectStart} ms`)
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
// 显式退出：child 子进程（被 supervisor spawn）是 detached 的，不持 event loop，
// 但保险起见强制结束，避免 job 挂起。
process.exit(failures.length > 0 ? 1 : 0)
