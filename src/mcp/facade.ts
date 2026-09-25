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
 * Proxying the *raw* body rather than re-encoding each JSON-RPC message is
 * deliberate: batches, extra params, and future protocol revisions pass through
 * untouched, and the child stays the single source of truth for tool schemas.
 *
 * The child's own port never appears here. It is read from the state store on
 * every request, which is what makes the port configurable without touching
 * `cordis.patch.yml` or restarting DSH.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { DEFAULT_FACADE_PORT, PORT_SCAN_RANGE } from '../constants.js'
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

export interface FacadeOptions {
  state: StateStore
  log: LogBuffer
  /** Plugin version, reported in `serverInfo` while the child is absent. */
  version: string
  /** Resolves the child's current HTTP port, or null when it is not running. */
  childPort: () => number | null
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

export class McpFacade {
  private readonly state: StateStore
  private readonly log: LogBuffer
  private readonly version: string
  private readonly childPort: () => number | null

  private server: Server | null = null
  private port: number | null = null
  /** Open server→client SSE streams (the GET side of Streamable HTTP). */
  private readonly streams = new Set<ServerResponse>()
  private keepalive: NodeJS.Timeout | null = null

  constructor(options: FacadeOptions) {
    this.state = options.state
    this.log = options.log
    this.version = options.version
    this.childPort = options.childPort
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
   * Called when the child transitions to healthy. If the client never opened
   * the GET stream, this is a no-op and the UI's "reload to mount tools" hint is
   * the fallback — we prefer to do the right thing and degrade honestly rather
   * than fake a capability the transport does not have.
   */
  notifyToolsChanged(): void {
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
    this.log.info(`已通知工具列表变化（${delivered} 个客户端流）`)
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
      const proxied = await this.proxy(port, body)
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

  /** Proxy one request to the child. Returns null when the child is unreachable. */
  private async proxy(port: number, body: string): Promise<{ status: number; body: string; contentType: string } | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp/http`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
      return {
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      }
    } catch (error) {
      this.log.warn(`转发到后台服务失败（端口 ${port}）：${(error as Error).message}`)
      return null
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
   */
  private openStream(req: IncomingMessage, res: ServerResponse): void {
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
  }
}
