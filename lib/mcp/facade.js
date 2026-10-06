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
 *   * proxies the child's traffic as soon as it is healthy, keeping the official
 *     bridge's tool naming, timeouts, and result projection
 *     (`mcp__feyagate__<rawName>`) exactly as upstream ships them, and touching
 *     exactly two responses: `tools/list` (`repairToolsList`) and the handshake
 *     (`repairHandshake` — `initialize` *and* `server/discover`, below);
 *   * pushes `notifications/tools/list_changed` over the GET event stream when
 *     the child appears, so the tool list fills in without a host restart.
 *
 * A `list_changed` is only worth anything if the client installed a handler for
 * it, and a client filters that on the capability the server advertised in the
 * handshake: `@modelcontextprotocol/client@2.0.0` skips the handler *silently*
 * when `capabilities.tools.listChanged` is missing ("Handlers are silently
 * skipped if the server doesn't advertise the corresponding listChanged
 * capability", `dist/index.mjs:3091`, gated at `:3095`) — and DSH's bridge does
 * register one (`@deepseek-ai/dsh-mcp-client` `lib/index.js:602`, `onChanged →
 * refreshTools`). Two handshake shapes can carry that capability, because the
 * client negotiates the protocol era itself: `server/discover` first (the
 * 2026-07-28 era, whose `capabilities` it *prefers* — `dist/index.mjs:3296`),
 * then `initialize` on the legacy fallback. The child answers neither
 * completely, so the facade must advertise the capability on **all three** of
 * its paths: `localAnswer` synthesises it, and `repairHandshake` re-adds it to
 * whichever handshake response the child produced — the child honestly reports
 * `tools: {}` (it never changes its tool list at runtime) and forwarding that
 * verbatim would silently delete the very capability the recovery below depends
 * on. Remove any half and the recovery goes quiet while every log line still
 * looks healthy.
 *
 * Delivery is *eventual*, not fire-and-forget — and a successful `write()` is
 * **not** delivery. The client may not have installed its handler yet (the
 * bridge opens its GET stream during the handshake), or the stream may belong
 * to a superseded generation that drops the notification; neither is visible
 * from the socket. The only trustworthy acknowledgement is the client's own
 * `tools/list` coming back *with tools* — a re-list into an empty table is not
 * an improvement, it is the state being repaired — so the facade re-sends on a
 * bounded schedule (`armListChangedReplay`) until it sees that, which is what
 * turns a swallowed notification from a permanent, silent failure into a
 * recoverable one, and says so out loud when nothing ever acknowledges. The
 * child's health edge and the stream's establishment are two independent
 * timelines, so a stream that opens while the child is already healthy is
 * reconciled immediately as well.
 *
 * Proxying the *raw* body rather than re-encoding each JSON-RPC message is
 * deliberate: batches, extra params, and future protocol revisions pass through
 * untouched, and the child stays the single source of truth for tool schemas.
 * The two repairs above are the narrow exception, and they are one-field edits
 * applied only when the request and answer have the shape we expect — a
 * response the facade does not fully understand is forwarded byte-identical
 * with a warning instead of being guessed at.
 *
 * The child's own port never appears here. It is read from the state store on
 * every request, which is what makes the port configurable without touching
 * `cordis.patch.yml` or restarting DSH.
 */
import { createServer } from 'node:http';
import { DEFAULT_FACADE_PORT, PORT_SCAN_RANGE, TUYA_STATUS_LONG_POLL_MS, TUYA_STATUS_POLL_INTERVAL_MS } from '../constants.js';
import { TUYA_QR_STATUS_TOOL_NOTE, TUYA_QR_TOOL_NOTE, TUYA_WAITING_MSG_RE, isTuyaToken, tuyaQrChatDisplay, tuyaQrImagePath, tuyaQrNextAction, tuyaQrTextPath, } from '../tuya-qr.js';
import { findFreePort } from '../supervise/health.js';
/** Same protocol revision the child advertises, so nothing has to downgrade. */
const PROTOCOL_VERSION = '2025-03-26';
/** Request bodies we are willing to buffer (a tools/call with a big payload). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How long a single proxied call may take; camera + VLM round trips are slow. */
const PROXY_TIMEOUT_MS = 180_000;
/** SSE keep-alive comment interval, so idle connections are not reaped. */
const SSE_KEEPALIVE_MS = 15_000;
/** Retry interval for a `list_changed` that found no open stream to deliver to. */
const LIST_CHANGED_RETRY_MS = 5_000;
/**
 * 涂鸦网关（apigw.iotbing.com）会间歇 5xx：一次 `auth/tuya_qr_status` 可能正好
 * 撞上。长轮询里给这类网关层失败（上游没有带任何说明的 error）最多 3 次重试，
 * 一条好好的扫码就不会被一次 502 打断；真正的终态（token 无效，上游带 msg）照旧
 * 立即返回。
 */
const TUYA_GATEWAY_RETRIES = 3;
/** Bound on retry attempts; gives the bridge roughly a minute to open its stream. */
const LIST_CHANGED_MAX_RETRIES = 12;
function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
/**
 * The answers we give while the child is absent: enough of MCP to satisfy a
 * client handshake and an initial `tools/list`, and an explicit error — never a
 * silent success — for anything that actually needs the gateway.
 */
function localAnswer(message, version, reason) {
    const id = message.id ?? null;
    if (id === null)
        return null; // a notification: nothing to answer
    switch (message.method) {
        case 'initialize':
            // `tools.listChanged: true` is load-bearing, not decoration: the bridge
            // only installs its `list_changed` handler when the server advertises it,
            // and the recovery path for a late child depends on that handler existing.
            // `repairHandshake` guarantees the same thing on the proxied path.
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'dsh-feyagate-gateway', version },
                },
            };
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            // An empty list is the honest answer: there is no gateway yet. It is also
            // what keeps the bridge's reconnect budget intact.
            return { jsonrpc: '2.0', id, result: { tools: [] } };
        case 'tools/call':
        case 'resources/list':
        case 'resources/read':
        case 'prompts/list':
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: `FeyaGate 后台服务未运行：${reason}` },
            };
        default:
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${String(message.method)}（后台服务未运行）` },
            };
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
function normalizedInputSchema(schema) {
    const source = schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
    const next = { ...source };
    let changed = false;
    if (next.type !== 'object') {
        next.type = 'object';
        changed = true;
    }
    const properties = next.properties;
    if (properties === undefined || properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
        next.properties = {};
        changed = true;
    }
    return { schema: next, changed };
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
const TOOL_DESCRIPTION_NOTES = {
    'auth/tuya_qr': TUYA_QR_TOOL_NOTE,
    'auth/tuya_qr_status': TUYA_QR_STATUS_TOOL_NOTE,
};
/**
 * Repair every `tools/list` result in a parsed JSON-RPC payload (single message
 * or batch). Returns how many tools actually changed (schema repaired and/or
 * description annotated), so callers can leave an unchanged response
 * byte-identical.
 */
function repairToolsListResult(payload) {
    const messages = Array.isArray(payload) ? payload : [payload];
    let repaired = 0;
    for (const message of messages) {
        if (message === null || typeof message !== 'object')
            continue;
        const result = message.result;
        if (result === null || typeof result !== 'object' || Array.isArray(result))
            continue;
        const tools = result.tools;
        if (!Array.isArray(tools))
            continue;
        for (const tool of tools) {
            if (tool === null || typeof tool !== 'object' || Array.isArray(tool))
                continue;
            const entry = tool;
            let changed = false;
            const { schema, changed: schemaChanged } = normalizedInputSchema(entry.inputSchema);
            if (schemaChanged) {
                entry.inputSchema = schema;
                changed = true;
            }
            const note = typeof entry.name === 'string' ? TOOL_DESCRIPTION_NOTES[entry.name] : undefined;
            if (note !== undefined && !(typeof entry.description === 'string' && entry.description.includes('DSH 聊天内授权流程'))) {
                entry.description = `${typeof entry.description === 'string' ? entry.description : ''}${note}`;
                changed = true;
            }
            if (changed)
                repaired += 1;
        }
    }
    return repaired;
}
/**
 * Advertise `tools.listChanged` in a proxied handshake result.
 *
 * `initialize` and `server/discover` are the two answers that can carry the
 * capability, and which one matters depends on the era the client negotiated:
 * for a 2026-07-28 server it reads `server/discover.capabilities`, and only on
 * the legacy fallback does it read `initialize.capabilities`
 * (`@modelcontextprotocol/client@2.0.0`, `dist/index.mjs:3296` vs `:3241`).
 *
 * The child is a plain MCP server whose tool list never changes at runtime, so
 * it answers `capabilities: { resources: {}, tools: {} }` — honest, and correct
 * for a client that talks to it directly. It is *wrong* for the bridge behind
 * this facade: DSH's MCP client filters its `list_changed` handler on exactly
 * that bit (`:3095`), so forwarding the child's answer verbatim deletes the
 * capability the facade's whole eventual-delivery design rests on — the health
 * edge below would push `notifications/tools/list_changed` into a client with
 * no handler for it, and the session keeps whatever list it got at connect
 * time, forever.
 *
 * This only ever *adds* `listChanged: true` to an existing `tools` object; it
 * never invents a capability the child does not have, and never touches
 * `resources`/`prompts` (the facade pushes no notifications for those). Matching
 * is by *request id* rather than by response shape, which is what keeps a batch
 * honest: a `tools/list` answer in the same batch has no `capabilities` at all,
 * and judging it as a malformed handshake answer produced a false warning. The
 * repaired and unexpected methods are returned so the caller can leave a
 * response byte-identical when nothing changed, and can name the method when the
 * shape is not what we expect.
 */
function repairHandshakeResult(payload, requests) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const repaired = [];
    const unexpected = [];
    for (const message of messages) {
        if (message === null || typeof message !== 'object' || Array.isArray(message))
            continue;
        const envelope = message;
        // An error answer, or a message that is not a response: nothing to repair.
        if (envelope.error !== undefined || envelope.method !== undefined)
            continue;
        // Only the answers to the handshake requests we actually sent are
        // candidates; anything else in the batch is none of this repair's business.
        const id = envelope.id;
        if (typeof id !== 'string' && typeof id !== 'number')
            continue;
        const method = requests.get(id);
        if (method === undefined)
            continue;
        const result = envelope.result;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            unexpected.push(method);
            continue;
        }
        const capabilities = result.capabilities;
        if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
            unexpected.push(method);
            continue;
        }
        const tools = capabilities.tools;
        if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
            // No `tools` capability at all: do not invent one — that would claim a
            // tool surface the child never offered.
            unexpected.push(method);
            continue;
        }
        if (tools.listChanged === true)
            continue;
        tools.listChanged = true;
        repaired.push(method);
    }
    return { repaired, unexpected };
}
/** The `tools/call` a request body asks for, or null when it asks for anything else. */
function requestedToolCall(body) {
    try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) {
            if (message === null || typeof message !== 'object')
                continue;
            const envelope = message;
            if (envelope.method !== 'tools/call')
                continue;
            const params = envelope.params;
            if (params === null || typeof params !== 'object' || Array.isArray(params))
                continue;
            const { name, arguments: args } = params;
            if (typeof name !== 'string')
                continue;
            const parsedArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
            return { name, arguments: parsedArgs };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * The JSON object the child put in its first text content item.
 *
 * Upstream answers every tool with `result.content[0].text` holding a stringified
 * JSON object (see `McpServer::handle_tool_call`), so adapting a result means
 * reading that string, adding fields, and writing it back.
 */
function parseToolPayload(responseBody) {
    let parsed;
    try {
        parsed = JSON.parse(responseBody);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const message = parsed;
    const result = message.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        return null;
    const content = result.content;
    if (!Array.isArray(content))
        return null;
    const first = content[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first))
        return null;
    const item = first;
    if (item.type !== 'text' || typeof item.text !== 'string')
        return null;
    let payload;
    try {
        payload = JSON.parse(item.text);
    }
    catch {
        return null;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    return { message, content: item, payload: payload };
}
/** The `status` field of an upstream Tuya status answer, when it has one. */
function tuyaStatusOf(responseBody) {
    const parsed = parseToolPayload(responseBody);
    if (parsed === null)
        return null;
    const status = parsed.payload.status;
    return typeof status === 'string' ? status : null;
}
/**
 * 网关层失败：子服务回 error，但上游没有给出任何说明（无 `msg`）——涂鸦的
 * 网关 5xx 就是这个形状。带 `msg` 的 error 是涂鸦的明确答复，不属于这类。
 */
function tuyaErrorIsGatewayLevel(responseBody) {
    const parsed = parseToolPayload(responseBody);
    if (parsed === null)
        return false;
    return parsed.payload.status === 'error' && parsed.payload.msg === undefined && parsed.payload.message === undefined;
}
/**
 * 「还没扫」的 waiting 答复：涂鸦 apigw 对未扫码的 token 回的不是 pending，
 * 而是 `status:"error"` + `msg:"Login failed, please scan and try again!"`。
 * 不识别它，二维码就会在生成几秒后被当成「已失效」。
 */
function tuyaStatusIsWaitingReply(responseBody) {
    const parsed = parseToolPayload(responseBody);
    if (parsed === null)
        return false;
    return parsed.payload.status === 'error' && typeof parsed.payload.msg === 'string' && TUYA_WAITING_MSG_RE.test(parsed.payload.msg);
}
/** 把 waiting 答复改写成一行干净的 `pending`，模型按工具说明继续轮询。 */
function rewriteTuyaWaitingToPending(responseBody) {
    const parsed = parseToolPayload(responseBody);
    if (parsed === null)
        return responseBody;
    if (!(parsed.payload.status === 'error' && typeof parsed.payload.msg === 'string' && TUYA_WAITING_MSG_RE.test(parsed.payload.msg))) {
        return responseBody;
    }
    const pendingPayload = { ...parsed.payload, status: 'pending', success: true };
    delete pendingPayload.msg;
    parsed.content.text = JSON.stringify(pendingPayload);
    return JSON.stringify(parsed.message);
}
/** What to tell the model about an upstream Tuya status answer. */
function tuyaStatusExtras(payload) {
    const status = typeof payload.status === 'string' ? payload.status : null;
    if (status === 'authorized') {
        return {
            note: '涂鸦授权成功，token 已保存在后台服务里。可以调用 device_list 或 tuya/refresh 查看设备；写操作需要授权版或有效试用，见 license/status。',
        };
    }
    if (status === 'pending') {
        return { note: '用户还没扫码：立即再次调用 auth/tuya_qr_status（服务端会继续等待），不要反问用户"扫好了吗"，也不要自己 sleep。' };
    }
    if (status === 'error' || payload.success === false) {
        return { note: '扫码授权失败或二维码已失效：重新调用 auth/tuya_qr 生成新二维码，再按 chat_display 引导用户扫一次。' };
    }
    return null;
}
/** True when the request body asks for `tools/list` (single message or batch). */
function requestsToolsList(body) {
    try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        return messages.some((message) => message !== null && typeof message === 'object' && message.method === 'tools/list');
    }
    catch {
        return false;
    }
}
/**
 * True when a `tools/list` response carries at least one tool.
 *
 * This is what makes the replay's acknowledgement honest: "the client asked"
 * proves nothing (it always asks once at connect time, and the facade itself
 * answers that with an empty list while the child is absent), while "the client
 * asked and got tools" is exactly the state the pending notification exists to
 * reach. Anything unparsable counts as no tools, i.e. keep retrying.
 */
function toolsListHasTools(body) {
    try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) {
            if (message === null || typeof message !== 'object' || Array.isArray(message))
                continue;
            const result = message.result;
            if (result === null || typeof result !== 'object' || Array.isArray(result))
                continue;
            const tools = result.tools;
            if (Array.isArray(tools) && tools.length > 0)
                return true;
        }
    }
    catch {
        return false;
    }
    return false;
}
/**
 * The handshake requests in a body, keyed by JSON-RPC id → method.
 *
 * Both `initialize` (legacy era) and `server/discover` (2026-07-28 era) can be
 * where the client reads the capabilities it gates the `list_changed` handler
 * on, so both are candidates for the capability repair. Returning the ids (not
 * just a boolean) is what lets the repair skip unrelated responses in a batch
 * instead of reporting them as malformed handshake answers.
 */
function handshakeRequests(body) {
    const requests = new Map();
    try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) {
            if (message === null || typeof message !== 'object' || Array.isArray(message))
                continue;
            const { id, method } = message;
            if (method !== 'initialize' && method !== 'server/discover')
                continue;
            if (typeof id === 'string' || typeof id === 'number')
                requests.set(id, method);
        }
    }
    catch {
        return requests;
    }
    return requests;
}
export class McpFacade {
    state;
    log;
    version;
    childPort;
    isChildHealthy;
    server = null;
    port = null;
    /** Open server→client SSE streams (the GET side of Streamable HTTP). */
    streams = new Set();
    keepalive = null;
    /**
     * Set while a `list_changed` still owes the client a re-list: every push arms
     * this, and it is cleared only by the acknowledgement the facade actually
     * trusts — a `tools/list` from the client that came back with at least one
     * tool — or when the bounded replay budget is exhausted (which is reported,
     * not swallowed). A successful `write()` alone does *not* clear it: the client
     * may have no handler installed yet, or the stream may belong to a superseded
     * generation, and neither is observable from the socket. An *empty* answer does
     * not clear it either: a client that re-lists into nothing is exactly the
     * client this replay still owes a tool list, so silencing it then would
     * recreate the original silent failure in miniature.
     */
    listChangedPending = false;
    listChangedRetries = 0;
    retryTimer = null;
    constructor(options) {
        this.state = options.state;
        this.log = options.log;
        this.version = options.version;
        this.childPort = options.childPort;
        this.isChildHealthy = options.isChildHealthy;
    }
    get listeningPort() {
        return this.port;
    }
    /**
     * Bind the facade and persist the port.
     *
     * The port must be written to `state.json` **before** this promise resolves:
     * `cordis.patch.yml` derives the bridge URL from that file, and the loader
     * evaluates the bridge row only after this plugin's `apply()` has settled.
     */
    async start() {
        const preferred = this.state.get().facade.port || DEFAULT_FACADE_PORT;
        const port = await findFreePort(preferred, PORT_SCAN_RANGE);
        if (port === null)
            throw new Error(`无法为 MCP 门面找到可用端口（从 ${preferred} 起尝试 ${PORT_SCAN_RANGE + 1} 个）`);
        const server = createServer((req, res) => {
            void this.handle(req, res);
        });
        server.on('clientError', (_error, socket) => {
            socket.destroy();
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen({ port, host: '127.0.0.1' }, () => resolve());
        });
        this.server = server;
        this.port = port;
        if (port !== preferred) {
            this.log.warn(`MCP 门面端口 ${preferred} 已被占用，改用 ${port}`);
        }
        this.state.patch({ facade: { port } });
        this.log.info(`MCP 门面已就绪：http://127.0.0.1:${port}/mcp`);
        this.keepalive = setInterval(() => {
            for (const stream of this.streams) {
                try {
                    stream.write(': keepalive\n\n');
                }
                catch {
                    this.streams.delete(stream);
                }
            }
        }, SSE_KEEPALIVE_MS);
        this.keepalive.unref?.();
        return port;
    }
    async stop() {
        if (this.keepalive !== null)
            clearInterval(this.keepalive);
        this.keepalive = null;
        if (this.retryTimer !== null)
            clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.listChangedPending = false;
        this.listChangedRetries = 0;
        for (const stream of this.streams) {
            try {
                stream.end();
            }
            catch {
                /* ignore */
            }
        }
        this.streams.clear();
        const server = this.server;
        this.server = null;
        this.port = null;
        if (server !== null) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }
    /**
     * Tell the connected client that the tool list changed.
     *
     * Called when the child transitions to healthy and when a stream opens
     * while the child is already healthy. The push is not considered done when
     * the bytes are written: it stays pending until the client actually re-lists
     * (`noteToolsListConfirmed`), and is re-sent on a bounded schedule meanwhile.
     * The bridge never re-opens its GET stream or re-issues `tools/list` on its
     * own, so a notification swallowed during the handshake — or by a superseded
     * generation — would otherwise leave it on an empty tool list for the rest of
     * the session, with no error anywhere to show for it.
     */
    notifyToolsChanged() {
        this.pushToolsChanged();
    }
    /** Start (or restart) a bounded push-and-verify cycle. */
    pushToolsChanged() {
        this.listChangedPending = true;
        this.listChangedRetries = 0;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.deliverListChanged();
        this.armListChangedReplay();
    }
    /** Write `list_changed` to every open stream. Returns how many received it. */
    deliverListChanged() {
        const payload = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        let delivered = 0;
        for (const stream of this.streams) {
            try {
                stream.write(`event: message\ndata: ${payload}\n\n`);
                delivered += 1;
            }
            catch {
                this.streams.delete(stream);
            }
        }
        if (delivered > 0) {
            this.log.info(`已通知工具列表变化（${delivered} 个客户端流）`);
        }
        return delivered;
    }
    /**
     * Arm the next verification tick of the current push.
     *
     * Each tick re-sends, and stops as soon as the client's own `tools/list`
     * comes back with tools — so a notification that landed costs one tick and
     * nothing else, while one that was swallowed is retried. Exhausting the budget
     * is a *diagnosis*, not a dead end: it means the client saw the bytes and still
     * never listed any tools, i.e. it has no `list_changed` handler installed (the
     * capability was not advertised on the handshake it used) or the child is not
     * answering, and either is worth saying out loud.
     */
    armListChangedReplay() {
        if (this.retryTimer !== null)
            return; // a tick is already in flight
        if (this.listChangedRetries >= LIST_CHANGED_MAX_RETRIES) {
            const streams = this.streams.size;
            this.listChangedPending = false;
            this.listChangedRetries = 0;
            this.log.warn(streams > 0
                ? `已重发 ${LIST_CHANGED_MAX_RETRIES} 次工具列表变化（含首次推送共 ${LIST_CHANGED_MAX_RETRIES + 1} 帧），但客户端始终没有列举出任何工具：请确认握手响应（initialize / server/discover）已广告 tools.listChanged、客户端装有 list_changed 处理器，以及后台服务是否在应答 tools/list`
                : '工具列表变化未送达（无客户端流，重试次数已用尽）');
            return;
        }
        this.listChangedRetries += 1;
        const attempt = this.listChangedRetries;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.listChangedPending)
                return;
            if (this.streams.size > 0)
                this.deliverListChanged();
            this.armListChangedReplay();
        }, LIST_CHANGED_RETRY_MS);
        this.retryTimer.unref?.();
        this.log.info(this.streams.size > 0
            ? `等待客户端重新列举工具，${LIST_CHANGED_RETRY_MS / 1000}s 后未确认则重发（第 ${attempt}/${LIST_CHANGED_MAX_RETRIES} 次）`
            : `工具列表变化暂无客户端流，${LIST_CHANGED_RETRY_MS / 1000}s 后重试（第 ${attempt}/${LIST_CHANGED_MAX_RETRIES} 次）`);
    }
    /**
     * A client listed tools *and got some*. That — and only that — acknowledges a
     * `list_changed` push. An empty answer is deliberately not an acknowledgement:
     * it means the client is no better off than before, which is precisely the
     * state the replay exists to repair.
     */
    noteToolsListConfirmed() {
        if (!this.listChangedPending)
            return;
        this.clearListChangedPending();
        this.log.info('客户端已重新列举工具（工具列表变化投递确认）');
    }
    /** Drop a pending `list_changed` (acknowledged, or the child went unhealthy). */
    clearListChangedPending() {
        this.listChangedPending = false;
        this.listChangedRetries = 0;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
    async handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // Accept both `/mcp` (what cordis.patch.yml points at) and `/mcp/http`
        // (what the child itself serves) so either can be configured by hand.
        if (url.pathname !== '/mcp' && url.pathname !== '/mcp/http') {
            json(res, 404, { error: 'not found' });
            return;
        }
        if (req.method === 'GET') {
            this.openStream(req, res);
            return;
        }
        if (req.method === 'DELETE') {
            // Session termination: nothing to tear down, we hold no session state.
            res.writeHead(204).end();
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch (error) {
            json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error.message) } });
            return;
        }
        const wantsTools = requestsToolsList(body);
        const port = this.childPort();
        if (port !== null) {
            let proxied = await this.proxy(port, body);
            if (proxied !== null) {
                // Tuya authorization is the one flow that needs two calls to feel like
                // one: the model shows the QR, then asks for the status until the user
                // scans. The waiting happens here so the model never has to sleep.
                if (requestedToolCall(body)?.name === 'auth/tuya_qr_status') {
                    proxied = await this.longPollTuyaStatus(port, body, proxied);
                }
                proxied = { ...proxied, body: this.adaptToolResult(body, proxied.body, proxied.contentType) };
            }
            if (proxied !== null) {
                if (proxied.body === '') {
                    // The child answered a notification with an empty 202.
                    res.writeHead(proxied.status === 200 ? 202 : proxied.status).end();
                    return;
                }
                // A `tools/list` that actually carries tools is the one acknowledgement
                // the replay waits for; note it *after* the answer is known, so an empty
                // result (child absent or unresponsive) never silences the retries.
                if (wantsTools && toolsListHasTools(proxied.body))
                    this.noteToolsListConfirmed();
                res.writeHead(proxied.status, {
                    'Content-Type': proxied.contentType,
                    'Content-Length': Buffer.byteLength(proxied.body),
                });
                res.end(proxied.body);
                return;
            }
            // Fall through to the local answers: the child died between the health
            // check and this request, and a valid empty answer beats a broken socket.
            // That answer is empty by construction, so it is not an acknowledgement.
        }
        this.answerLocally(body, res);
    }
    /**
     * Repair a `tools/list` response on its way through the facade.
     *
     * This is the one response a strict client validates as a whole, so a single
     * non-conforming `inputSchema` costs the model every tool the gateway has.
     * Anything unexpected (non-JSON content type, unparsable body) is passed
     * through untouched and logged rather than guessed at.
     */
    repairToolsList(requestBody, responseBody, contentType) {
        if (responseBody === '' || !requestsToolsList(requestBody))
            return responseBody;
        if (!contentType.includes('json')) {
            // The child answers JSON to this call (we forward no `Accept`), so a
            // different content type means something changed upstream — say so
            // instead of silently skipping the repair.
            this.log.warn(`tools/list 返回了非 JSON 内容（${contentType}），未做 inputSchema 归一化`);
            return responseBody;
        }
        try {
            const parsed = JSON.parse(responseBody);
            const repaired = repairToolsListResult(parsed);
            if (repaired === 0)
                return responseBody;
            this.log.info(`已修正 ${repaired} 个工具的 inputSchema（上游缺 type:"object"，不修会让桥丢掉全部工具）`);
            return JSON.stringify(parsed);
        }
        catch (error) {
            this.log.warn(`tools/list 响应无法解析，未做 inputSchema 归一化：${error.message}`);
            return responseBody;
        }
    }
    /**
     * Repair a proxied handshake response on its way through the facade.
     *
     * Same discipline as `repairToolsList`: change exactly one field, only for the
     * methods whose answer can carry the capability (`initialize` and
     * `server/discover`), only for responses whose id matches a request we
     * actually forwarded, and hand anything unexpected through untouched with a
     * warning rather than guessing.
     */
    repairHandshake(requestBody, responseBody, contentType) {
        if (responseBody === '')
            return responseBody;
        const requests = handshakeRequests(requestBody);
        if (requests.size === 0)
            return responseBody;
        const methods = [...new Set(requests.values())].join(' / ');
        if (!contentType.includes('json')) {
            this.log.warn(`握手响应（${methods}）返回了非 JSON 内容（${contentType}），未做能力补全`);
            return responseBody;
        }
        try {
            const parsed = JSON.parse(responseBody);
            const { repaired, unexpected } = repairHandshakeResult(parsed, requests);
            for (const method of unexpected) {
                this.log.warn(`${method} 响应结构不符合预期，未补全 tools.listChanged（原样透传）`);
            }
            if (repaired.length === 0)
                return responseBody;
            for (const method of repaired) {
                this.log.info(method === 'initialize'
                    ? '已为 initialize 响应补上 tools.listChanged（子进程不广告该能力，不补桥就装不上 list_changed 处理器）'
                    : '已为 server/discover 响应补上 tools.listChanged（现代协议按该响应判定能力，不补同样装不上处理器）');
            }
            return JSON.stringify(parsed);
        }
        catch (error) {
            this.log.warn(`握手响应无法解析，未做能力补全：${error.message}`);
            return responseBody;
        }
    }
    /** Proxy one request to the child. Returns null when the child is unreachable. */
    async proxy(port, body) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/mcp/http`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
            });
            const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
            // Both response repairs are gated on the request method, so at most one of
            // them ever parses; a request that is neither is forwarded byte-identical.
            const handshakeFixed = this.repairHandshake(body, await response.text(), contentType);
            return {
                status: response.status,
                body: this.repairToolsList(body, handshakeFixed, contentType),
                contentType,
            };
        }
        catch (error) {
            this.log.warn(`转发到后台服务失败（端口 ${port}）：${error.message}`);
            return null;
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
    async longPollTuyaStatus(port, body, first) {
        let current = first;
        const deadline = Date.now() + TUYA_STATUS_LONG_POLL_MS;
        let gatewayRetries = 0;
        while (Date.now() < deadline) {
            const verdict = tuyaStatusOf(current.body);
            if (verdict === 'pending' || tuyaStatusIsWaitingReply(current.body)) {
                // 还没扫（涂鸦把未扫码回成 waiting error，见 TUYA_WAITING_MSG_RE）：继续等。
            }
            else if (verdict === 'error' && gatewayRetries < TUYA_GATEWAY_RETRIES && tuyaErrorIsGatewayLevel(current.body)) {
                gatewayRetries += 1;
            }
            else {
                // authorized，或涂鸦给出了明确答复（error 且带非等待类 msg），或网关重试已用尽。
                return current;
            }
            await new Promise((resolve) => setTimeout(resolve, TUYA_STATUS_POLL_INTERVAL_MS));
            const next = await this.proxy(port, body);
            // Child died mid-wait: the last good answer (a valid `pending`) beats an
            // error, and the model's next call will surface the real problem.
            if (next === null)
                return current;
            current = next;
        }
        // 等满预算仍是「还没扫」：改写成干净的 pending 还给模型——模型按工具说明
        // 继续轮询直到扫到或自行重新生成，而不是把一条等待答复当成失败。
        const rewritten = rewriteTuyaWaitingToPending(current.body);
        return rewritten === current.body ? current : { ...current, body: rewritten };
    }
    /**
     * Adapt one upstream tool result for a chat client.
     *
     * Only the Tuya authorization pair is touched, and only when the request and
     * the answer both have the shape we expect; anything else is returned
     * byte-identical. A facade that rewrites responses it does not fully
     * understand is worse than one that forwards them.
     */
    adaptToolResult(requestBody, responseBody, contentType) {
        const call = requestedToolCall(requestBody);
        if (call === null || (call.name !== 'auth/tuya_qr' && call.name !== 'auth/tuya_qr_status'))
            return responseBody;
        if (responseBody === '' || !contentType.includes('json'))
            return responseBody;
        const parsed = parseToolPayload(responseBody);
        if (parsed === null) {
            this.log.warn(`${call.name} 的返回不符合预期结构，未做聊天适配`);
            return responseBody;
        }
        const extra = call.name === 'auth/tuya_qr' ? this.tuyaQrExtras(parsed.payload, call.arguments) : tuyaStatusExtras(parsed.payload);
        if (extra === null)
            return responseBody;
        Object.assign(parsed.payload, extra);
        parsed.content.text = JSON.stringify(parsed.payload);
        return JSON.stringify(parsed.message);
    }
    /** Everything a chat client needs to actually finish the QR step. */
    tuyaQrExtras(payload, args) {
        if (payload.success !== true)
            return null;
        const token = typeof payload.token === 'string' ? payload.token : '';
        if (!isTuyaToken(token))
            return null;
        const userCode = typeof args.user_code === 'string' ? args.user_code : '';
        const expire = typeof payload.expire_time === 'number' && payload.expire_time > 0 ? payload.expire_time : 300;
        this.log.info(`已为涂鸦授权生成可扫二维码（token ${token.slice(0, 8)}…，${expire}s 有效）`);
        return {
            qr_image_url: tuyaQrImagePath(token),
            qr_text_url: tuyaQrTextPath(token),
            chat_display: tuyaQrChatDisplay(token, expire),
            user_code: userCode,
            next_action: tuyaQrNextAction(token, userCode),
            note: '把 chat_display 原样放进给用户的回复里（DSH 会渲染成二维码）；随后立即用返回的 token + user_code 调用 auth/tuya_qr_status，不要问用户"扫好了吗"。',
        };
    }
    answerLocally(body, res) {
        const reason = this.childPort() === null ? '尚未安装或尚未启动' : '进程无响应';
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效的 JSON 请求体' } });
            return;
        }
        if (Array.isArray(parsed)) {
            const answers = parsed
                .map((message) => localAnswer(message, this.version, reason))
                .filter((answer) => answer !== null);
            if (answers.length === 0) {
                res.writeHead(202).end();
                return;
            }
            json(res, 200, answers);
            return;
        }
        const answer = localAnswer(parsed, this.version, reason);
        if (answer === null) {
            res.writeHead(202).end();
            return;
        }
        json(res, 200, answer);
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
    async openStream(req, res) {
        const accept = String(req.headers.accept ?? '');
        if (!accept.includes('text/event-stream')) {
            json(res, 406, { error: 'GET 需要 Accept: text/event-stream' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        this.streams.add(res);
        const drop = () => {
            this.streams.delete(res);
        };
        req.on('close', drop);
        res.on('close', drop);
        const replayed = this.listChangedPending;
        let healthy = false;
        try {
            healthy = await this.isChildHealthy();
        }
        catch {
            // A probe failure means "not healthy"; the normal health edge will
            // still deliver a fresh `list_changed` later.
        }
        if (replayed || healthy) {
            // Only send if the stream is still open: a client that dropped in
            // the probe window reconnects and gets its own reconciliation. This goes
            // through the push-and-verify cycle, so a client that is not ready to
            // receive yet (handler still being installed) is retried rather than
            // missed.
            if (this.streams.has(res))
                this.pushToolsChanged();
        }
    }
}
//# sourceMappingURL=facade.js.map