/**
 * The always-on loopback MCP facade.
 *
 * This exists because of one measured constraint: `@deepseek-ai/dsh-mcp-client`
 * retries a failed connection 10 times with exponential backoff (500ms doubling
 * to 30s, roughly 2.5 minutes of budget) and then **unregisters the server's
 * tools for the rest of the session**. Pointing it straight at the child process
 * means that any user who installs the gateway after DSH has booted — or whose
 * first download takes longer than that budget — ends up with no tools and a
 * plugin that looks broken, with no way back short of restarting the host.
 *
 * So the bridge talks to this instead. The facade:
 *
 *   * answers `initialize` immediately, always, so the connection never fails;
 *   * answers `tools/list` with an empty list while the child is absent, which
 *     is a *valid* MCP answer and therefore does not consume any retry budget;
 *   * proxies everything to the child verbatim as soon as it is healthy,
 *     keeping the official bridge's tool naming, timeouts, and result
 *     projection (`mcp__feyagate__<rawName>`) exactly as upstream ships them;
 *   * pushes `notifications/tools/list_changed` over the GET event stream when
 *     the child appears, so the tool list fills in without a host restart.
 *
 * Delivery is *eventual*, not fire-and-forget. The bridge's Streamable HTTP
 * transport opens its GET stream exactly once and only reacts to
 * `list_changed`; it never re-lists on its own. The child's health edge and
 * the stream's establishment are two independent timelines, and either can
 * miss the other, so the facade reconciles: a stream that opens while the
 * child is already healthy is sent an immediate `list_changed`, and a change
 * notified while no stream is open is marked pending and replayed (bounded,
 * every five seconds) until some stream receives it or the child goes down.
 *
 * Proxying the *raw* body rather than re-encoding each JSON-RPC message is
 * deliberate: batches, extra params, and future protocol revisions pass through
 * untouched, and the child stays the single source of truth for tool schemas.
 *
 * The child's own port never appears here. It is read from the state store on
 * every request, which is what makes the port configurable without touching
 * `cordis.patch.yml` or restarting DSH.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { DEFAULT_FACADE_PORT, PORT_SCAN_RANGE, TUYA_STATUS_LONG_POLL_MS, TUYA_STATUS_POLL_INTERVAL_MS } from '../constants.js'
import {
  TUYA_QR_STATUS_TOOL_NOTE,
  TUYA_QR_TOOL_NOTE,
  TUYA_WAITING_MSG_RE,
  isTuyaToken,
  tuyaQrChatDisplay,
  tuyaQrImagePath,
  tuyaQrNextAction,
  tuyaQrTextPath,
} from '../tuya-qr.js'
import { type LogBuffer } from '../log.js'
import { type StateStore } from '../state.js'
import { findFreePort } from '../supervise/health.js'

/** Same protocol revision the child advertises, so nothing has to downgrade. */
const PROTOCOL_VERSION = '2025-03-26'

/** Request bodies we are willing to buffer (a tools/call with a big payload). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** How long a single proxied call may take; camera + VLM round trips are slow. */
const PROXY_TIMEOUT_MS = 180_000

/** SSE keep-alive comment interval, so idle connections are not reaped. */
const SSE_KEEPALIVE_MS = 15_000

/** Retry interval for a `list_changed` that found no open stream to deliver to. */
const LIST_CHANGED_RETRY_MS = 5_000

/**
 * 涂鸦网关（apigw.iotbing.com）会间歇 5xx：一次 `auth/tuya_qr_status` 可能正好
 * 撞上。长轮询里给这类网关层失败（上游没有带任何说明的 error）最多 3 次重试，
 * 一条好好的扫码就不会被一次 502 打断；真正的终态（token 无效，上游带 msg）照旧
 * 立即返回。
 */
const TUYA_GATEWAY_RETRIES = 3

/** Bound on retry attempts; gives the bridge roughly a minute to open its stream. */
const LIST_CHANGED_MAX_RETRIES = 12

export interface FacadeOptions {
  state: StateStore
  log: LogBuffer
  /** Plugin version, reported in `serverInfo` while the child is absent. */
  version: string
  /** Resolves the child's current HTTP port, or null when it is not running. */
  childPort: () => number | null
  /**
   * Live health probe, resolved from the supervisor (`healthy()`). Consulted
   * when a stream opens, so a late bridge reconnect gets an immediate
   * `list_changed` instead of waiting for the next (possibly never) edge.
   */
  isChildHealthy: () => Promise<boolean>
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  /** Present on responses; typed loosely because we only ever read into it. */
  result?: unknown
  error?: unknown
}

/**
 * The answers we give while the child is absent: enough of MCP to satisfy a
 * client handshake and an initial `tools/list`, and an explicit error — never a
 * silent success — for anything that actually needs the gateway.
 */
function localAnswer(message: JsonRpcMessage, version: string, reason: string): unknown | null {
  const id = message.id ?? null
  if (id === null) return null // a notification: nothing to answer
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'dsh-feyagate-gateway', version },
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      // An empty list is the honest answer: there is no gateway yet. It is also
      // what keeps the bridge's reconnect budget intact.
      return { jsonrpc: '2.0', id, result: { tools: [] } }
    case 'tools/call':
    case 'resources/list':
    case 'resources/read':
    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `FeyaGate 后台服务未运行：${reason}` },
      }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(message.method)}（后台服务未运行）` },
      }
  }
}

/**
 * A tool's `inputSchema` must be an object schema. Upstream builds ship `{}` for
 * zero-argument tools — 7 of 76 in v1.2.19/v1.2.20 (`auth/platforms`,
 * `tuya/refresh`, `ewelink/refresh`, `midea/refresh`, `auth/*_logout`) — and a
 * strict client rejects the **whole** `tools/list` response over it: DSH's bridge
 * validates `ListToolsResult`, `syncTools` throws before registering anything, and
 * the model ends up with zero tools from a server that looks perfectly connected.
 * The facade is the side that speaks MCP to the bridge, so it repairs the shape
 * here — one fix that covers every upstream version already released.
 */
function normalizedInputSchema(schema: unknown): { schema: Record<string, unknown>; changed: boolean } {
  const source = schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {}
  const next: Record<string, unknown> = { ...source }
  let changed = false
  if (next.type !== 'object') {
    next.type = 'object'
    changed = true
  }
  const properties = next.properties
  if (properties === undefined || properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    next.properties = {}
    changed = true
  }
  return { schema: next, changed }
}

/**
 * Descriptions the facade appends to upstream tools.
 *
 * The upstream text describes *what* a tool does; a chat client additionally has
 * to know **how the conversation is supposed to proceed** — that the QR has to be
 * handed to the user as an image, and that the status tool already waits so it
 * must not be interleaved with "are you done yet?". Upstream cannot say this
 * (the desktop app has its own UI for the same tools), so the facade — the side
 * that talks to a chat client — says it.
 */
const TOOL_DESCRIPTION_NOTES: Record<string, string> = {
  'auth/tuya_qr': TUYA_QR_TOOL_NOTE,
  'auth/tuya_qr_status': TUYA_QR_STATUS_TOOL_NOTE,
}

/**
 * Repair every `tools/list` result in a parsed JSON-RPC payload (single message
 * or batch). Returns how many tools actually changed (schema repaired and/or
 * description annotated), so callers can leave an unchanged response
 * byte-identical.
 */
function repairToolsListResult(payload: unknown): number {
  const messages = Array.isArray(payload) ? payload : [payload]
  let repaired = 0
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const result = (message as { result?: unknown }).result
    if (result === null || typeof result !== 'object' || Array.isArray(result)) continue
    const tools = (result as { tools?: unknown }).tools
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) continue
      const entry = tool as { name?: unknown; description?: unknown; inputSchema?: unknown }
      let changed = false
      const { schema, changed: schemaChanged } = normalizedInputSchema(entry.inputSchema)
      if (schemaChanged) {
        entry.inputSchema = schema
        changed = true
      }
      const note = typeof entry.name === 'string' ? TOOL_DESCRIPTION_NOTES[entry.name] : undefined
      if (note !== undefined && !(typeof entry.description === 'string' && entry.description.includes('DSH 聊天内授权流程'))) {
        entry.description = `${typeof entry.description === 'string' ? entry.description : ''}${note}`
        changed = true
      }
      if (changed) repaired += 1
    }
  }
  return repaired
}

/** One `tools/call` found in a request body (single message or batch). */
interface ToolCallRequest {
  name: string
  arguments: Record<string, unknown>
}

/** The `tools/call` a request body asks for, or null when it asks for anything else. */
function requestedToolCall(body: string): ToolCallRequest | null {
  try {
    const parsed: unknown = JSON.parse(body)
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      const envelope = message as JsonRpcMessage
      if (envelope.method !== 'tools/call') continue
      const params = envelope.params
      if (params === null || typeof params !== 'object' || Array.isArray(params)) continue
      const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
      if (typeof name !== 'string') continue
      const parsedArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      return { name, arguments: parsedArgs }
    }
    return null
  } catch {
    return null
  }
}

/**
 * The JSON object the child put in its first text content item.
 *
 * Upstream answers every tool with `result.content[0].text` holding a stringified
 * JSON object (see `McpServer::handle_tool_call`), so adapting a result means
 * reading that string, adding fields, and writing it back.
 */
function parseToolPayload(responseBody: string): { message: JsonRpcMessage; content: Record<string, unknown>; payload: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseBody)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const message = parsed as JsonRpcMessage
  const result = message.result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const first = content[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return null
  const item = first as { type?: unknown; text?: unknown }
  if (item.type !== 'text' || typeof item.text !== 'string') return null
  let payload: unknown
  try {
    payload = JSON.parse(item.text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return { message, content: item as Record<string, unknown>, payload: payload as Record<string, unknown> }
}

/** The `status` field of an upstream Tuya status answer, when it has one. */
function tuyaStatusOf(responseBody: string): string | null {
  const parsed = parseToolPayload(responseBody)
  if (parsed === null) return null
  const status = parsed.payload.status
  return typeof status === 'string' ? status : null
}

/**
 * 网关层失败：子服务回 error，但上游没有给出任何说明（无 `msg`）——涂鸦的
 * 网关 5xx 就是这个形状。带 `msg` 的 error 是涂鸦的明确答复，不属于这类。
 */
function tuyaErrorIsGatewayLevel(responseBody: string): boolean {
  const parsed = parseToolPayload(responseBody)
  if (parsed === null) return false
  return parsed.payload.status === 'error' && parsed.payload.msg === undefined && parsed.payload.message === undefined
}

/**
 * 「还没扫」的 waiting 答复：涂鸦 apigw 对未扫码的 token 回的不是 pending，
 * 而是 `status:"error"` + `msg:"Login failed, please scan and try again!"`。
 * 不识别它，二维码就会在生成几秒后被当成「已失效」。
 */
function tuyaStatusIsWaitingReply(responseBody: string): boolean {
  const parsed = parseToolPayload(responseBody)
  if (parsed === null) return false
  return parsed.payload.status === 'error' && typeof parsed.payload.msg === 'string' && TUYA_WAITING_MSG_RE.test(parsed.payload.msg)
}

/** 把 waiting 答复改写成一行干净的 `pending`，模型按工具说明继续轮询。 */
function rewriteTuyaWaitingToPending(responseBody: string): string {
  const parsed = parseToolPayload(responseBody)
  if (parsed === null) return responseBody
  if (!(parsed.payload.status === 'error' && typeof parsed.payload.msg === 'string' && TUYA_WAITING_MSG_RE.test(parsed.payload.msg))) {
    return responseBody
  }
  const pendingPayload: Record<string, unknown> = { ...parsed.payload, status: 'pending', success: true }
  delete pendingPayload.msg
  parsed.content.text = JSON.stringify(pendingPayload)
  return JSON.stringify(parsed.message)
}

/** What to tell the model about an upstream Tuya status answer. */
function tuyaStatusExtras(payload: Record<string, unknown>): Record<string, unknown> | null {
  const status = typeof payload.status === 'string' ? payload.status : null
  if (status === 'authorized') {
    return {
      note: '涂鸦授权成功，token 已保存在后台服务里。可以调用 device_list 或 tuya/refresh 查看设备；写操作需要授权版或有效试用，见 license/status。',
    }
  }
  if (status === 'pending') {
    return { note: '用户还没扫码：立即再次调用 auth/tuya_qr_status（服务端会继续等待），不要反问用户"扫好了吗"，也不要自己 sleep。' }
  }
  if (status === 'error' || payload.success === false) {
    return { note: '扫码授权失败或二维码已失效：重新调用 auth/tuya_qr 生成新二维码，再按 chat_display 引导用户扫一次。' }
  }
  return null
}

/** True when the request body asks for `tools/list` (single message or batch). */
function requestsToolsList(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    return messages.some((message) => message !== null && typeof message === 'object' && (message as JsonRpcMessage).method === 'tools/list')
  } catch {
    return false
  }
}

export class McpFacade {
  private readonly state: StateStore
  private readonly log: LogBuffer
  private readonly version: string
  private readonly childPort: () => number | null
  private readonly isChildHealthy: () => Promise<boolean>

  private server: Server | null = null
  private port: number | null = null
  /** Open server→client SSE streams (the GET side of Streamable HTTP). */
  private readonly streams = new Set<ServerResponse>()
  private keepalive: NodeJS.Timeout | null = null
  /**
   * Set when a `list_changed` was raised but no stream was open to receive
   * it. Cleared on the first successful delivery, on the next health edge,
   * or when the bounded retry timer expires.
   */
  private listChangedPending = false
  private listChangedRetries = 0
  private retryTimer: NodeJS.Timeout | null = null

  constructor(options: FacadeOptions) {
    this.state = options.state
    this.log = options.log
    this.version = options.version
    this.childPort = options.childPort
    this.isChildHealthy = options.isChildHealthy
  }

  get listeningPort(): number | null {
    return this.port
  }

  /**
   * Bind the facade and persist the port.
   *
   * The port must be written to `state.json` **before** this promise resolves:
   * `cordis.patch.yml` derives the bridge URL from that file, and the loader
   * evaluates the bridge row only after this plugin's `apply()` has settled.
   */
  async start(): Promise<number> {
    const preferred = this.state.get().facade.port || DEFAULT_FACADE_PORT
    const port = await findFreePort(preferred, PORT_SCAN_RANGE)
    if (port === null) throw new Error(`无法为 MCP 门面找到可用端口（从 ${preferred} 起尝试 ${PORT_SCAN_RANGE + 1} 个）`)

    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ port, host: '127.0.0.1' }, () => resolve())
    })

    this.server = server
    this.port = port
    if (port !== preferred) {
      this.log.warn(`MCP 门面端口 ${preferred} 已被占用，改用 ${port}`)
    }
    this.state.patch({ facade: { port } })
    this.log.info(`MCP 门面已就绪：http://127.0.0.1:${port}/mcp`)

    this.keepalive = setInterval(() => {
      for (const stream of this.streams) {
        try {
          stream.write(': keepalive\n\n')
        } catch {
          this.streams.delete(stream)
        }
      }
    }, SSE_KEEPALIVE_MS)
    this.keepalive.unref?.()

    return port
  }

  async stop(): Promise<void> {
    if (this.keepalive !== null) clearInterval(this.keepalive)
    this.keepalive = null
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.listChangedPending = false
    this.listChangedRetries = 0
    for (const stream of this.streams) {
      try {
        stream.end()
      } catch {
        /* ignore */
      }
    }
    this.streams.clear()
    const server = this.server
    this.server = null
    this.port = null
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /**
   * Tell the connected client that the tool list changed.
   *
   * Called when the child transitions to healthy and when a stream opens
   * while the child is already healthy. If no stream is open when the change
   * happens, the notification is marked pending and replayed on a bounded
   * retry interval until some stream receives it — the bridge never re-opens
   * its GET stream or re-issues `tools/list` on its own, so a dropped
   * one-shot notification would leave it on an empty tool list for the rest
   * of the session.
   */
  notifyToolsChanged(): void {
    if (this.deliverListChanged() > 0) {
      this.log.info('已通知工具列表变化')
      return
    }
    this.markListChangedPending()
  }

  /** Write `list_changed` to every open stream. Returns how many received it. */
  private deliverListChanged(): number {
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    let delivered = 0
    for (const stream of this.streams) {
      try {
        stream.write(`event: message\ndata: ${payload}\n\n`)
        delivered += 1
      } catch {
        this.streams.delete(stream)
      }
    }
    if (delivered > 0) {
      this.clearListChangedPending()
      this.log.info(`已通知工具列表变化（${delivered} 个客户端流）`)
    }
    return delivered
  }

  /** Remember a missed notification and arm the bounded retry timer. */
  private markListChangedPending(): void {
    this.listChangedPending = true
    if (this.retryTimer !== null) return // a retry is already in flight
    if (this.listChangedRetries >= LIST_CHANGED_MAX_RETRIES) {
      this.listChangedPending = false
      this.listChangedRetries = 0
      this.log.warn('工具列表变化未送达（无客户端流，重试次数已用尽）')
      return
    }
    this.listChangedRetries += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.listChangedPending) return
      if (this.deliverListChanged() === 0) this.markListChangedPending()
    }, LIST_CHANGED_RETRY_MS)
    this.retryTimer.unref?.()
    this.log.info(`工具列表变化暂无客户端流，${LIST_CHANGED_RETRY_MS / 1000}s 后重试（第 ${this.listChangedRetries}/${LIST_CHANGED_MAX_RETRIES} 次）`)
  }

  /** Drop a pending `list_changed` (e.g. the child went unhealthy again). */
  clearListChangedPending(): void {
    this.listChangedPending = false
    this.listChangedRetries = 0
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Accept both `/mcp` (what cordis.patch.yml points at) and `/mcp/http`
    // (what the child itself serves) so either can be configured by hand.
    if (url.pathname !== '/mcp' && url.pathname !== '/mcp/http') {
      json(res, 404, { error: 'not found' })
      return
    }

    if (req.method === 'GET') {
      this.openStream(req, res)
      return
    }
    if (req.method === 'DELETE') {
      // Session termination: nothing to tear down, we hold no session state.
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
      return
    }

    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String((error as Error).message) } })
      return
    }

    const port = this.childPort()
    if (port !== null) {
      let proxied = await this.proxy(port, body)
      if (proxied !== null) {
        // Tuya authorization is the one flow that needs two calls to feel like
        // one: the model shows the QR, then asks for the status until the user
        // scans. The waiting happens here so the model never has to sleep.
        if (requestedToolCall(body)?.name === 'auth/tuya_qr_status') {
          proxied = await this.longPollTuyaStatus(port, body, proxied)
        }
        proxied = { ...proxied, body: this.adaptToolResult(body, proxied.body, proxied.contentType) }
      }
      if (proxied !== null) {
        if (proxied.body === '') {
          // The child answered a notification with an empty 202.
          res.writeHead(proxied.status === 200 ? 202 : proxied.status).end()
          return
        }
        res.writeHead(proxied.status, {
          'Content-Type': proxied.contentType,
          'Content-Length': Buffer.byteLength(proxied.body),
        })
        res.end(proxied.body)
        return
      }
      // Fall through to the local answers: the child died between the health
      // check and this request, and a valid empty answer beats a broken socket.
    }

    this.answerLocally(body, res)
  }

  /**
   * Repair a `tools/list` response on its way through the facade.
   *
   * This is the one response a strict client validates as a whole, so a single
   * non-conforming `inputSchema` costs the model every tool the gateway has.
   * Anything unexpected (non-JSON content type, unparsable body) is passed
   * through untouched and logged rather than guessed at.
   */
  private repairToolsList(requestBody: string, responseBody: string, contentType: string): string {
    if (responseBody === '' || !requestsToolsList(requestBody)) return responseBody
    if (!contentType.includes('json')) {
      // The child answers JSON to this call (we forward no `Accept`), so a
      // different content type means something changed upstream — say so
      // instead of silently skipping the repair.
      this.log.warn(`tools/list 返回了非 JSON 内容（${contentType}），未做 inputSchema 归一化`)
      return responseBody
    }
    try {
      const parsed: unknown = JSON.parse(responseBody)
      const repaired = repairToolsListResult(parsed)
      if (repaired === 0) return responseBody
      this.log.info(`已修正 ${repaired} 个工具的 inputSchema（上游缺 type:"object"，不修会让桥丢掉全部工具）`)
      return JSON.stringify(parsed)
    } catch (error) {
      this.log.warn(`tools/list 响应无法解析，未做 inputSchema 归一化：${(error as Error).message}`)
      return responseBody
    }
  }

  /** Proxy one request to the child. Returns null when the child is unreachable. */
  private async proxy(port: number, body: string): Promise<{ status: number; body: string; contentType: string } | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp/http`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
      const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8'
      return {
        status: response.status,
        body: this.repairToolsList(body, await response.text(), contentType),
        contentType,
      }
    } catch (error) {
      this.log.warn(`转发到后台服务失败（端口 ${port}）：${(error as Error).message}`)
      return null
    }
  }

  /**
   * Wait on an upstream `auth/tuya_qr_status` answer.
   *
   * Polling is what makes the chat flow work at all: the user scans, and the
   * answer has to come back on its own. Doing it here (rather than asking the
   * model to sleep between calls) also keeps a slow user cheap — the ceiling is
   * one client call, and the caller simply asks again.
   */
  private async longPollTuyaStatus(
    port: number,
    body: string,
    first: { status: number; body: string; contentType: string },
  ): Promise<{ status: number; body: string; contentType: string }> {
    let current = first
    const deadline = Date.now() + TUYA_STATUS_LONG_POLL_MS
    let gatewayRetries = 0
    while (Date.now() < deadline) {
      const verdict = tuyaStatusOf(current.body)
      if (verdict === 'pending' || tuyaStatusIsWaitingReply(current.body)) {
        // 还没扫（涂鸦把未扫码回成 waiting error，见 TUYA_WAITING_MSG_RE）：继续等。
      } else if (verdict === 'error' && gatewayRetries < TUYA_GATEWAY_RETRIES && tuyaErrorIsGatewayLevel(current.body)) {
        gatewayRetries += 1
      } else {
        // authorized，或涂鸦给出了明确答复（error 且带非等待类 msg），或网关重试已用尽。
        return current
      }
      await new Promise((resolve) => setTimeout(resolve, TUYA_STATUS_POLL_INTERVAL_MS))
      const next = await this.proxy(port, body)
      // Child died mid-wait: the last good answer (a valid `pending`) beats an
      // error, and the model's next call will surface the real problem.
      if (next === null) return current
      current = next
    }
    // 等满预算仍是「还没扫」：改写成干净的 pending 还给模型——模型按工具说明
    // 继续轮询直到扫到或自行重新生成，而不是把一条等待答复当成失败。
    const rewritten = rewriteTuyaWaitingToPending(current.body)
    return rewritten === current.body ? current : { ...current, body: rewritten }
  }

  /**
   * Adapt one upstream tool result for a chat client.
   *
   * Only the Tuya authorization pair is touched, and only when the request and
   * the answer both have the shape we expect; anything else is returned
   * byte-identical. A facade that rewrites responses it does not fully
   * understand is worse than one that forwards them.
   */
  private adaptToolResult(requestBody: string, responseBody: string, contentType: string): string {
    const call = requestedToolCall(requestBody)
    if (call === null || (call.name !== 'auth/tuya_qr' && call.name !== 'auth/tuya_qr_status')) return responseBody
    if (responseBody === '' || !contentType.includes('json')) return responseBody
    const parsed = parseToolPayload(responseBody)
    if (parsed === null) {
      this.log.warn(`${call.name} 的返回不符合预期结构，未做聊天适配`)
      return responseBody
    }
    const extra = call.name === 'auth/tuya_qr' ? this.tuyaQrExtras(parsed.payload, call.arguments) : tuyaStatusExtras(parsed.payload)
    if (extra === null) return responseBody
    Object.assign(parsed.payload, extra)
    parsed.content.text = JSON.stringify(parsed.payload)
    return JSON.stringify(parsed.message)
  }

  /** Everything a chat client needs to actually finish the QR step. */
  private tuyaQrExtras(payload: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> | null {
    if (payload.success !== true) return null
    const token = typeof payload.token === 'string' ? payload.token : ''
    if (!isTuyaToken(token)) return null
    const userCode = typeof args.user_code === 'string' ? args.user_code : ''
    const expire = typeof payload.expire_time === 'number' && payload.expire_time > 0 ? payload.expire_time : 300
    this.log.info(`已为涂鸦授权生成可扫二维码（token ${token.slice(0, 8)}…，${expire}s 有效）`)
    return {
      qr_image_url: tuyaQrImagePath(token),
      qr_text_url: tuyaQrTextPath(token),
      chat_display: tuyaQrChatDisplay(token, expire),
      user_code: userCode,
      next_action: tuyaQrNextAction(token, userCode),
      note: '把 chat_display 原样放进给用户的回复里（DSH 会渲染成二维码）；随后立即用返回的 token + user_code 调用 auth/tuya_qr_status，不要问用户"扫好了吗"。',
    }
  }

  private answerLocally(body: string, res: ServerResponse): void {
    const reason = this.childPort() === null ? '尚未安装或尚未启动' : '进程无响应'
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效的 JSON 请求体' } })
      return
    }

    if (Array.isArray(parsed)) {
      const answers = parsed
        .map((message) => localAnswer(message as JsonRpcMessage, this.version, reason))
        .filter((answer): answer is unknown => answer !== null)
      if (answers.length === 0) {
        res.writeHead(202).end()
        return
      }
      json(res, 200, answers)
      return
    }

    const answer = localAnswer(parsed as JsonRpcMessage, this.version, reason)
    if (answer === null) {
      res.writeHead(202).end()
      return
    }
    json(res, 200, answer)
  }

  /**
   * The server→client half of Streamable HTTP. The MCP SDK opens this with
   * `Accept: text/event-stream`; it is the only channel over which
   * `tools/list_changed` can reach the client, so it must stay open.
   *
   * Reconciliation on open: the child's health edge and this stream's
   * establishment are independent, so whichever happened first does not
   * know about the other. If the child is *already* healthy, send an
   * immediate `list_changed` so this (late) bridge fills its tool list now
   * instead of never; if a notification was missed earlier, replay it.
   * Both are idempotent — the bridge simply re-lists.
   */
  private async openStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const accept = String(req.headers.accept ?? '')
    if (!accept.includes('text/event-stream')) {
      json(res, 406, { error: 'GET 需要 Accept: text/event-stream' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    this.streams.add(res)
    const drop = (): void => {
      this.streams.delete(res)
    }
    req.on('close', drop)
    res.on('close', drop)

    const replayed = this.listChangedPending
    let healthy = false
    try {
      healthy = await this.isChildHealthy()
    } catch {
      // A probe failure means "not healthy"; the normal health edge will
      // still deliver a fresh `list_changed` later.
    }
    if (replayed || healthy) {
      // Only send if the stream is still open: a client that dropped in
      // the probe window reconnects and gets its own reconciliation.
      if (this.streams.has(res)) this.deliverListChanged()
    }
  }
}
