#!/usr/bin/env node
/**
 * 一次性验证：MCP 门面必须让 `initialize` 响应 advertise `tools.listChanged`。
 *
 * 被验证的故障（用户报「AI 会话里拿不到任何 mcp__feyagate__* 工具」）：
 *
 *   门面对 `initialize` 是**逐字转发**的，只有 `tools/list` 做了修复。子进程
 *   `miloco-mcp-server` 回的是 `capabilities:{resources:{},tools:{}}` —— tools 里
 *   **没有** `listChanged:true`。DSH 的桥（`@deepseek-ai/dsh-mcp-client`）确实注册了
 *   `listChanged:{tools:{autoRefresh:false,onChanged:refreshTools}}`，但
 *   `@modelcontextprotocol/client@2.0.0` 只在服务端广告了该能力时才装处理器
 *   （dist/index.mjs:3091 注释、:3095 门控）。能力被子进程的响应覆盖掉之后，
 *   门面推的 `notifications/tools/list_changed` 被客户端静默忽略，工具列表就永远
 *   停在 connect 那一刻拿到的样子。
 *
 * 本脚本用**真实的 SDK 2.0.0**（绝对路径 import，不写进 package.json）把因果链跑通：
 *
 *   S1 子进程缺席 → 门面本地合成应答（一直是对的）→ 处理器装上 → 通知真的触发重新 list
 *     （对照组：证明「通知链路本身没坏」，缺的只有能力位）
 *   S2 子进程健康 → 走 proxy 转发（**原来坏掉的情形**）
 *      · 修复前：能力丢失 → 处理器被跳过 → 通知被忽略 → 工具列表冻结
 *      · 修复后：能力被补全 → 处理器装上 → 通知触发重新 list
 *
 * 断言失败即退出码 1。修复前运行会失败（这是故意的：它就是要复现故障）。
 *
 * 运行：node scripts/verify-mcp-initialize-capability.mjs
 *   （先 npm run build，脚本加载的是 lib/mcp/facade.js）
 *
 * 环境变量 DSH_MCP_SDK 可覆盖 SDK 入口路径。
 */

import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'

import { McpFacade } from '../lib/mcp/facade.js'

/**
 * 宿主里真实安装的 MCP 客户端 SDK；绝不出现在 package.json 依赖里。
 *
 * DSH 升级会清掉旧运行时目录（本机已从 0.1.7-rc.2 换到 0.2.0-rc.2），写死路径会
 * 在下一次升级后直接 ERR_MODULE_NOT_FOUND，所以这里扫描已安装运行时，取版本号
 * 最大的那个；`DSH_MCP_SDK` 仍可直接指定入口，`DSH_VERSIONS_DIR` 可换扫描目录。
 */
function discoverSdkEntry() {
  if (process.env.DSH_MCP_SDK) return process.env.DSH_MCP_SDK
  const versionsDir = process.env.DSH_VERSIONS_DIR
    ?? path.join(homedir(), 'Library', 'Application Support', 'DSH', 'data', 'versions')
  let versions = []
  try {
    versions = readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    versions = []
  }
  for (const version of versions) {
    const entry = path.join(versionsDir, version, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')
    if (existsSync(entry)) return entry
  }
  console.error(`找不到 @modelcontextprotocol/client：已在 ${versionsDir} 下扫描不到，请用 DSH_MCP_SDK=<dist/index.mjs 路径> 指定。`)
  process.exit(2)
}

const SDK_ENTRY = discoverSdkEntry()

/** 门面首选端口，刻意避开真实宿主占用的 38081–38083。 */
const FACADE_PORT = 38900

/** 子进程真实的 `initialize` result，逐字节抄自线上日志抓到的响应。 */
const CHILD_INITIALIZE_RESULT = {
  capabilities: { resources: {}, tools: {} },
  protocolVersion: '2025-03-26',
  serverInfo: { name: 'miloco-mcp-server', version: '1.0.0' },
}

/**
 * 子进程的 `tools/list`：故意带上 2 个缺 `type:"object"` 的工具，用来回归
 * `repairToolsList`（线上 93 个工具里有 2 个是这个形状）。
 */
const CHILD_TOOLS = [
  { name: 'device/list', description: '列出设备', inputSchema: {} },
  { name: 'auth/tuya_qr', description: '生成涂鸦二维码', inputSchema: { type: 'object', properties: { user_code: { type: 'string' } } } },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (label, ok, detail = '') => {
  const mark = ok ? '  ✓' : '  ✗'
  console.log(`${mark} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** 桩子进程：形状与 miloco-mcp-server 一致（未知方法回 -32601）。 */
async function startStubChild() {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const answer = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        answer(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        return
      }
      const { method, id } = message
      seen.push(method)
      switch (method) {
        case 'initialize':
          answer(200, { jsonrpc: '2.0', id, result: CHILD_INITIALIZE_RESULT })
          return
        case 'tools/list':
          answer(200, { jsonrpc: '2.0', id, result: { tools: CHILD_TOOLS } })
          return
        case 'tools/call':
          answer(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })
          return
        case 'notifications/initialized':
        case 'notifications/cancelled':
          res.writeHead(202).end()
          return
        default:
          // 与线上子进程一致：不支持 `server/discover`，于是 SDK 回退到 legacy 握手。
          answer(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } })
      }
    })
  })
  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  return {
    port: server.address().port,
    seen,
    reset: () => { seen.length = 0 },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 只记住日志行；不落盘，绝不碰 ~/.dsh。 */
function fakeLog(lines) {
  const record = (level) => (text) => lines.push(`${level}: ${text}`)
  return { info: record('info'), warn: record('warn'), error: record('error') }
}

/** 门面只用到 state.get() / state.patch()，用内存对象即可（不会写 state.json）。 */
function fakeState(port) {
  return { get: () => ({ facade: { port } }), patch: () => {} }
}

/** 一个 POST 到门面，返回 { status, json }。 */
async function post(port, payload) {
  const body = JSON.stringify(payload)
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 保留 text */
  }
  return { status: response.status, json, text }
}

/** 用真实的 SDK 建一个与桥同配置的客户端（选项逐项抄自 dsh-mcp-client lib/index.js:595-608）。 */
async function connectBridgeLikeClient(facadePort) {
  const { Client, StreamableHTTPClientTransport } = await import(SDK_ENTRY)
  const state = { onChanged: 0, reListedTools: null, reListError: null }
  const client = new Client(
    { name: 'dsh-mcp-client', version: '0.0.1' },
    {
      capabilities: {},
      versionNegotiation: { mode: 'auto' },
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          // 桥的 onChanged 就是 refreshTools()：重新 list 一遍并重注册工具。
          onChanged: () => {
            state.onChanged += 1
            client
              .listTools(undefined, { cacheMode: 'refresh' })
              .then((result) => { state.reListedTools = result.tools })
              .catch((error) => { state.reListError = String(error) })
          },
        },
      },
    },
  )
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${facadePort}/mcp`))
  await client.connect(transport)
  return { client, state, close: () => client.close() }
}

async function main() {
  console.log(`SDK: ${SDK_ENTRY}`)
  const lines = []
  const log = fakeLog(lines)
  const stub = await startStubChild()

  // 门面持有的两个探针：脚本按场景改写，模拟「子进程缺席 / 健康」。
  let childPort = null
  let childHealthy = false
  const facade = new McpFacade({
    state: fakeState(FACADE_PORT),
    log,
    version: '0.3.2-verify',
    childPort: () => childPort,
    isChildHealthy: async () => childHealthy,
  })
  const port = await facade.start()
  console.log(`门面: http://127.0.0.1:${port}/mcp   桩子进程: 127.0.0.1:${stub.port}\n`)

  // ───────────────────────── S1：子进程缺席 ─────────────────────────
  console.log('S1 子进程缺席（门面本地合成应答，对照组）')
  const ac1 = await post(port, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } },
  })
  check('AC1 initialize 响应 advertise tools.listChanged === true',
    ac1.json?.result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(ac1.json?.result?.capabilities))

  const ac4Empty = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  check('AC4 子进程缺席时 tools/list 仍返回合法空列表（不烧重连预算）',
    ac4Empty.status === 200 && Array.isArray(ac4Empty.json?.result?.tools) && ac4Empty.json.result.tools.length === 0,
    `HTTP ${ac4Empty.status} ${ac4Empty.text.slice(0, 80)}`)

  const ac4Call = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'device/list', arguments: {} } })
  check('AC4 子进程缺席时 tools/call 仍显式报错',
    typeof ac4Call.json?.error?.code === 'number' && typeof ac4Call.json.error.message === 'string',
    JSON.stringify(ac4Call.json?.error))

  const s1 = await connectBridgeLikeClient(port)
  const s1Tools = (await s1.client.listTools()).tools
  check('S1 客户端连上后拿到空工具列表（子进程真的不在）', s1Tools.length === 0, `${s1Tools.length} 个`)

  // 子进程起来了：门面的健康边沿推 list_changed。
  stub.reset()
  const s1Before = s1.state.onChanged
  childPort = stub.port
  childHealthy = true
  facade.notifyToolsChanged()
  await sleep(800)
  check('S1 对照组：能力位在（本地应答本来就广告）→ 处理器装上 → 通知触发重新 list',
    s1.state.onChanged > s1Before && stub.seen.filter((m) => m === 'tools/list').length >= 1,
    `onChanged ${s1Before}→${s1.state.onChanged} 子进程收到=[${stub.seen.join(', ')}] 工具=${s1.state.reListedTools?.length ?? 'null'}`)
  await s1.close()
  await sleep(200) // 让门面把 S1 的 GET 流摘掉，免得后来的通知也写给它

  // ───────────────────────── S2：子进程健康（原来坏掉的情形）─────────────────────────
  console.log('\nS2 子进程健康（走 proxy 逐字转发，原来坏掉的情形）')
  stub.reset()
  const ac2 = await post(port, {
    jsonrpc: '2.0', id: 4, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } },
  })
  const ac2Result = ac2.json?.result
  check('AC2 转发路径也 advertise tools.listChanged === true',
    ac2Result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(ac2Result?.capabilities))
  check('AC2 其余字段原样透传（serverInfo / protocolVersion / resources）',
    JSON.stringify(ac2Result?.serverInfo) === JSON.stringify(CHILD_INITIALIZE_RESULT.serverInfo)
    && ac2Result?.protocolVersion === CHILD_INITIALIZE_RESULT.protocolVersion
    && JSON.stringify(ac2Result?.capabilities?.resources) === JSON.stringify(CHILD_INITIALIZE_RESULT.capabilities.resources),
    `serverInfo=${JSON.stringify(ac2Result?.serverInfo)} protocolVersion=${ac2Result?.protocolVersion}`)

  const ac4Schema = await post(port, { jsonrpc: '2.0', id: 5, method: 'tools/list' })
  const repairedTools = ac4Schema.json?.result?.tools ?? []
  check('AC4 inputSchema 归一化仍生效（子进程那 2 个工具都被补成 object + properties）',
    repairedTools.length === CHILD_TOOLS.length
    && repairedTools.every((tool) => tool.inputSchema?.type === 'object' && tool.inputSchema.properties !== undefined),
    repairedTools.map((tool) => `${tool.name}:${JSON.stringify(tool.inputSchema)}`).join(' | '))
  check('AC4 门面留下了 inputSchema 修复日志',
    lines.some((line) => /已修正 \d+ 个工具的 inputSchema/.test(line)),
    lines.filter((line) => line.includes('inputSchema')).slice(-1)[0] ?? '(无)')

  const s2 = await connectBridgeLikeClient(port)
  const s2Tools = (await s2.client.listTools()).tools
  check('S2 客户端连上后拿到 2 个工具', s2Tools.length === 2, `${s2Tools.length} 个`)
  console.log(`  · 客户端连上期间子进程实际收到的方法：[${stub.seen.join(', ')}]`)
  console.log('    （`server/discover` 先探一次、被子进程以 -32601 拒掉 → SDK 回退 legacy 握手，正是线上路径）')

  stub.reset()
  const s2Before = s2.state.onChanged
  facade.notifyToolsChanged()
  await sleep(800)
  check('AC3 门面推 notifications/tools/list_changed 后，客户端真的重新 list（处理器已装上）',
    s2.state.onChanged > s2Before && stub.seen.filter((m) => m === 'tools/list').length >= 1,
    `onChanged ${s2Before}→${s2.state.onChanged} 子进程收到=[${stub.seen.join(', ')}] 工具=${s2.state.reListedTools?.length ?? 'null'}`)
  check('AC3 重新 list 拿到了工具（不是空表）',
    (s2.state.reListedTools?.length ?? 0) === 2,
    `${s2.state.reListedTools?.length ?? 'null'} 个${s2.state.reListError === null ? '' : `，错误：${s2.state.reListError}`}`)
  await s2.close()

  console.log('\n── 子进程侧看到的完整方法序列（S2，最后一段）──')
  console.log(`  [${stub.seen.join(', ')}]`)
  console.log('\n── 门面日志 ──')
  for (const line of lines) console.log(`  ${line}`)

  await facade.stop()
  await stub.close()

  console.log(failures === 0 ? '\n全部断言通过。' : `\n${failures} 条断言失败。`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
