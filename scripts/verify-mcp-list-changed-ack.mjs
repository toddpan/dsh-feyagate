#!/usr/bin/env node
/**
 * 一次性验证：门面必须把「客户端真的重新 list」当作 `list_changed` 的送达确认。
 *
 * 被验证的故障（验收测试工程师实测的盲区）：
 *
 *   门面原来把 `stream.write()` 当作送达 —— 只要有一条 GET 流活着，就
 *   `clearListChangedPending()` 并停手。但写进 socket ≠ 客户端处理：
 *   桥的 GET 流在握手中打开，处理器要等 `initialize` 落定才装上；被吞掉的那一次
 *   通知就此永久失效，而日志看起来完全健康（"已通知工具列表变化（1 个客户端流）"，
 *   随后没有任何重新 list）。线上 11:52:13 / 11:54:09 那两次通知正是这个签名。
 *
 * 本脚本用**裸 SSE 客户端**（不装任何处理器，只收不答）把这件事变成可判定断言：
 *
 *   A1 推一次通知，客户端不重新 list → 门面必须在重试周期后**再推一次**
 *      （修复前这里永远只有 1 次，A1 会失败 —— 这正是它要复现的故障）
 *   A2 客户端终于 POST `tools/list` → 门面必须**立即停手**，不再重发
 *   A3 两次行为都必须在日志里说得出口（等待确认 / 已确认），而不是静默
 *
 * 断言失败即退出码 1。
 *
 * 运行：npm run build && node scripts/verify-mcp-list-changed-ack.mjs
 */

import { createServer } from 'node:http'

import { McpFacade } from '../lib/mcp/facade.js'
import { LogBuffer } from '../lib/log.js'

/** 门面端口，避开真实宿主占用的 38081–38083。 */
const FACADE_PORT = 38902
/** 与 `facade.ts` 的 LIST_CHANGED_RETRY_MS 对齐，多留 1.5s 余量。 */
const RETRY_MS = 5000
const WAIT_FOR_REPLAY_MS = RETRY_MS + 1500

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** 桩子进程：健康，`tools/list` 返回一个工具。 */
async function startStubChild() {
  const seen = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const answer = (payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
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
        answer({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        return
      }
      seen.push(message.method)
      switch (message.method) {
        case 'initialize':
          answer({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              capabilities: { resources: {}, tools: {} },
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'miloco-mcp-server', version: '1.0.0' },
            },
          })
          return
        case 'tools/list':
          answer({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'device/list', description: '列出设备', inputSchema: { type: 'object' } }] },
          })
          return
        default:
          answer({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } })
      }
    })
  })
  await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * 裸 SSE 客户端：只收、只数 `list_changed` 帧，**不**做任何 react
 * —— 这正是"客户端没装处理器 / 装了也不处理"的最小模型。
 */
async function openPassiveStream(port) {
  const counted = { notifications: 0 }
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          if (frame.includes('notifications/tools/list_changed')) counted.notifications += 1
        }
      }
    } catch {
      // 流被主动关闭：正常收尾。
    }
  })()
  return {
    counted,
    close: async () => {
      controller.abort()
      await pump
    },
  }
}

async function post(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 也照原样报出来 */
  }
  return { status: response.status, text, json }
}

async function main() {
  const log = new LogBuffer()
  const stub = await startStubChild()
  // 子进程是否可用：A4 要用它模拟"客户端重新 list 了、但拿不到工具"。
  let childPort = stub.port
  const facade = new McpFacade({
    state: { get: () => ({ facade: { port: FACADE_PORT }, server: { effectivePort: stub.port } }), patch: () => {} },
    log,
    version: '0.3.2-verify-ack',
    childPort: () => childPort,
    isChildHealthy: async () => childPort !== null,
  })
  const port = await facade.start()
  console.log(`门面: http://127.0.0.1:${port}/mcp   桩子进程: 127.0.0.1:${stub.port}\n`)

  // 一个真实转发过的握手，顺带确认 A3 的日志前提。
  const init = await post(port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'verify-ack', version: '1.0' } },
  })
  check('前置：转发路径的 initialize 仍被补上 tools.listChanged',
    init.json?.result?.capabilities?.tools?.listChanged === true,
    JSON.stringify(init.json?.result?.capabilities))

  const stream = await openPassiveStream(port)
  // 先等「流打开时的立即补推」自己落定，否则它会把基线抬高，
  // A1 就不再只反映 notify 之后的重发（那会让修复前也"看着通过"）。
  let base = stream.counted.notifications
  for (let i = 0; i < 12; i += 1) {
    await sleep(400)
    if (stream.counted.notifications === base) break
    base = stream.counted.notifications
  }
  console.log(`  基线：流建立后已收到 ${base} 次通知（立即补推已结算）`)

  console.log('A1 推送一次通知，客户端收而不答')
  facade.notifyToolsChanged()
  await sleep(400)
  const afterNotify = stream.counted.notifications
  check('A1 notify 后送达一次', afterNotify === base + 1, `${base} → ${afterNotify} 次`)
  await sleep(WAIT_FOR_REPLAY_MS)
  const afterWait = stream.counted.notifications
  check('A1 客户端不重新 list 时，门面在重试周期后重发（写成功 ≠ 送达）',
    afterWait >= afterNotify + 1,
    `${afterNotify} → ${afterWait} 次；修复前 notify 那一次之后恒无重发`)

  console.log('A2 客户端终于 POST tools/list（= 送去确认）')
  const relist = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  check('A2 重新 list 拿到了工具', Array.isArray(relist.json?.result?.tools) && relist.json.result.tools.length === 1)
  const beforeAckSettled = stream.counted.notifications
  await sleep(WAIT_FOR_REPLAY_MS)
  const afterAckSettled = stream.counted.notifications
  check('A2 收到确认后门面停止重发',
    afterAckSettled === beforeAckSettled,
    `${beforeAckSettled} → ${afterAckSettled} 次`)

  const texts = log.tail(200).map((line) => line.text)
  check('A3 日志说明在等待确认', texts.some((t) => t.includes('等待客户端重新列举工具')), '')
  check('A3 日志说明确认已到', texts.some((t) => t.includes('工具列表变化投递确认')), '')

  console.log('A4 空表不能算确认（验收第二轮 M1：假确认）')
  const ackCount = () => log.tail(500).filter((line) => line.text.includes('工具列表变化投递确认')).length
  const beforeA4 = stream.counted.notifications
  facade.notifyToolsChanged()
  await sleep(400)
  childPort = null // 后台服务此刻不可用：客户端重新 list 只会拿到空表
  // 比较点必须夹住那一次空表 POST —— 拿"等待窗口之后"和"POST 之后"比是恒真的，
  // 测不出该次 POST 是否被记成确认（第三轮验收 F1）。
  const ackBeforeEmpty = ackCount()
  const emptyList = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const ackAfterEmpty = ackCount()
  check('A4 客户端此时确实拿到空表', Array.isArray(emptyList.json?.result?.tools) && emptyList.json.result.tools.length === 0)
  check('A4 空表没有被记为投递确认（夹住该次 POST 的前后）',
    ackAfterEmpty === ackBeforeEmpty, `${ackBeforeEmpty} → ${ackAfterEmpty}`)
  check('A4 空表没有清掉 pending（白盒）', facade.listChangedPending === true)
  await sleep(WAIT_FOR_REPLAY_MS)
  const afterEmptyWait = stream.counted.notifications
  check('A4 空表没有终止重发（还要继续推）',
    afterEmptyWait >= beforeA4 + 2,
    `${beforeA4} → ${afterEmptyWait} 次；空表 list 之后仍应至少再推一次`)

  console.log('A5 子进程恢复后重新 list 拿到工具 → 才确认并停手')
  childPort = stub.port
  const ackBeforeGood = ackCount()
  const goodList = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/list' })
  check('A5 恢复后重新 list 拿到工具', Array.isArray(goodList.json?.result?.tools) && goodList.json.result.tools.length === 1)
  await sleep(400)
  const ackAfterGood = ackCount()
  // 用差值断言：`.some()` 会被 A2 早先那条确认行满足，即使 A5 的确认没发生也通过（第三轮验收 F2）。
  check('A5 拿到工具后才记为投递确认', ackAfterGood === ackBeforeGood + 1, `${ackBeforeGood} → ${ackAfterGood}`)
  const beforeA5Quiet = stream.counted.notifications
  await sleep(WAIT_FOR_REPLAY_MS)
  check('A5 确认后不再重发', stream.counted.notifications === beforeA5Quiet,
    `${beforeA5Quiet} → ${stream.counted.notifications} 次`)

  await stream.close()
  await facade.stop()
  await stub.close()

  console.log(
    failures === 0
      ? '\n全部断言通过。'
      : `\n${failures} 条断言失败（本脚本修复前必然失败：A1 就是被吞掉的那一次通知）。`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

await main()
