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
import { type LogBuffer } from '../log.js';
import { type StateStore } from '../state.js';
export interface FacadeOptions {
    state: StateStore;
    log: LogBuffer;
    /** Plugin version, reported in `serverInfo` while the child is absent. */
    version: string;
    /** Resolves the child's current HTTP port, or null when it is not running. */
    childPort: () => number | null;
    /**
     * Live health probe, resolved from the supervisor (`healthy()`). Consulted
     * when a stream opens, so a late bridge reconnect gets an immediate
     * `list_changed` instead of waiting for the next (possibly never) edge.
     */
    isChildHealthy: () => Promise<boolean>;
}
export declare class McpFacade {
    private readonly state;
    private readonly log;
    private readonly version;
    private readonly childPort;
    private readonly isChildHealthy;
    private server;
    private port;
    /** Open server→client SSE streams (the GET side of Streamable HTTP). */
    private readonly streams;
    private keepalive;
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
    private listChangedPending;
    private listChangedRetries;
    private retryTimer;
    constructor(options: FacadeOptions);
    get listeningPort(): number | null;
    /**
     * Bind the facade and persist the port.
     *
     * The port must be written to `state.json` **before** this promise resolves:
     * `cordis.patch.yml` derives the bridge URL from that file, and the loader
     * evaluates the bridge row only after this plugin's `apply()` has settled.
     */
    start(): Promise<number>;
    stop(): Promise<void>;
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
    notifyToolsChanged(): void;
    /** Start (or restart) a bounded push-and-verify cycle. */
    private pushToolsChanged;
    /** Write `list_changed` to every open stream. Returns how many received it. */
    private deliverListChanged;
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
    private armListChangedReplay;
    /**
     * A client listed tools *and got some*. That — and only that — acknowledges a
     * `list_changed` push. An empty answer is deliberately not an acknowledgement:
     * it means the client is no better off than before, which is precisely the
     * state the replay exists to repair.
     */
    private noteToolsListConfirmed;
    /** Drop a pending `list_changed` (acknowledged, or the child went unhealthy). */
    clearListChangedPending(): void;
    private handle;
    /**
     * Repair a `tools/list` response on its way through the facade.
     *
     * This is the one response a strict client validates as a whole, so a single
     * non-conforming `inputSchema` costs the model every tool the gateway has.
     * Anything unexpected (non-JSON content type, unparsable body) is passed
     * through untouched and logged rather than guessed at.
     */
    private repairToolsList;
    /**
     * Repair a proxied handshake response on its way through the facade.
     *
     * Same discipline as `repairToolsList`: change exactly one field, only for the
     * methods whose answer can carry the capability (`initialize` and
     * `server/discover`), only for responses whose id matches a request we
     * actually forwarded, and hand anything unexpected through untouched with a
     * warning rather than guessing.
     */
    private repairHandshake;
    /** Proxy one request to the child. Returns null when the child is unreachable. */
    private proxy;
    /**
     * Wait on an upstream `auth/tuya_qr_status` answer.
     *
     * Polling is what makes the chat flow work at all: the user scans, and the
     * answer has to come back on its own. Doing it here (rather than asking the
     * model to sleep between calls) also keeps a slow user cheap — the ceiling is
     * one client call, and the caller simply asks again.
     */
    private longPollTuyaStatus;
    /**
     * Adapt one upstream tool result for a chat client.
     *
     * Only the Tuya authorization pair is touched, and only when the request and
     * the answer both have the shape we expect; anything else is returned
     * byte-identical. A facade that rewrites responses it does not fully
     * understand is worse than one that forwards them.
     */
    private adaptToolResult;
    /** Everything a chat client needs to actually finish the QR step. */
    private tuyaQrExtras;
    private answerLocally;
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
    private openStream;
}
