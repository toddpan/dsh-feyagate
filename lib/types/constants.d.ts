/**
 * Every constant that a maintainer might need to change, in one file.
 *
 * The rule this file exists to enforce: version numbers, ports, paths, and
 * protocol paths are never duplicated as literals elsewhere in `src/`.
 */
/** npm package name; also the Cordis entry id used in doctor output. */
export declare const PLUGIN_ID = "dsh-feyagate";
/** Short name used for directory names, log prefixes, and DOM ids. */
export declare const PLUGIN_SHORT = "dsh-feyagate";
/** `serverName` of the MCP bridge row; makes tool names `mcp__feyagate__*`. */
export declare const MCP_SERVER_NAME = "feyagate";
/** Settings namespace and the id of the settings.section registered by the UI. */
export declare const SETTINGS_NS = "feyagate";
export declare const SETTINGS_SECTION_ID = "feyagate";
export declare const SETTINGS_SECTION_ORDER = 30;
/** Host HTTP API prefix (same-origin from the browser half). */
export declare const API_PREFIX = "/dsh-feyagate";
/**
 * Global the host injects into index.html so the browser half can find the API
 * prefix without hard-coding it (the prefix is a plugin setting).
 */
export declare const BROWSER_GLOBAL = "__DSH_FEYAGATE__";
/** Default port of the plugin's always-on MCP facade (the bridge talks here). */
export declare const DEFAULT_FACADE_PORT = 38081;
/** Default port for the child server's own HTTP API. */
export declare const DEFAULT_SERVER_PORT = 38080;
/** How many consecutive ports to probe when the preferred one is taken. */
export declare const PORT_SCAN_RANGE = 20;
/** Child process readiness probing: 40 x 500ms = 20s before we call it failed. */
export declare const HEALTH_INTERVAL_MS = 500;
export declare const HEALTH_RETRIES = 40;
export declare const HEALTH_REQUEST_TIMEOUT_MS = 1500;
/** Crash restart backoff, walked one step at a time and capped at the last. */
export declare const RESTART_BACKOFF_MS: readonly [1000, 2000, 5000, 10000, 20000, 30000];
/** Crash-loop circuit breaker: more than N crashes inside the window stops auto-restart. */
export declare const CRASH_WINDOW_MS = 60000;
export declare const MAX_CRASHES_PER_WINDOW = 5;
/** Stop sequence: SIGTERM, wait, then SIGKILL. */
export declare const STOP_GRACE_MS = 5000;
/**
 * How long a recorded pid that is alive but not yet answering `/health` is given
 * to finish starting before it is treated as wedged.
 *
 * Several DSH instances share one install root (and therefore one pid file), so
 * "no answer right now" usually means "someone else's child is still binding its
 * port". Killing it there is what turns concurrent boots into a restart war:
 * each instance kills the other's child and both respawn. Waiting it out lets
 * the instance that lost the race adopt the winner's process instead.
 */
export declare const ADOPT_GRACE_MS = 30000;
/** Poll interval used while waiting out `ADOPT_GRACE_MS`. */
export declare const ADOPT_POLL_MS = 500;
/**
 * Tuya authorization polling, done on the plugin's side.
 *
 * The status tool is asked by the model, but a model that has to sleep and
 * re-ask turns a two-second scan into a dozen turns of chatter. So the facade
 * waits instead: one client call blocks up to `TUYA_STATUS_LONG_POLL_MS`,
 * re-asking upstream every `TUYA_STATUS_POLL_INTERVAL_MS`, and returns as soon
 * as the user scans. The ceiling stays well below the MCP bridge's 60s per-call
 * timeout, and a timeout is answered as `pending` — the model just calls again,
 * so a slow user loses nothing.
 */
export declare const TUYA_STATUS_LONG_POLL_MS = 35000;
export declare const TUYA_STATUS_POLL_INTERVAL_MS = 2000;
/**
 * Hung-child watchdog: probe every `WATCHDOG_INTERVAL_MS`, and after
 * `WATCHDOG_FAILURES` consecutive misses replace the process — unless another
 * live DSH instance owns it (see `PidRecord.ownerPid` in `supervise/process.ts`).
 */
export declare const WATCHDOG_INTERVAL_MS = 15000;
export declare const WATCHDOG_FAILURES = 3;
/** Download knobs. */
export declare const DOWNLOAD_TIMEOUT_MS = 120000;
export declare const DOWNLOAD_MAX_REDIRECTS = 5;
export declare const DOWNLOAD_RETRIES = 2;
/** Log ring buffer handed to the UI. */
export declare const LOG_BUFFER_LINES = 800;
/** How many trailing child-output lines a startup failure carries into its error. */
export declare const CHILD_OUTPUT_TAIL_LINES = 12;
export declare const LOG_FORWARD_LINES = 400;
/**
 * The child's WebSocket port.
 *
 * Unused by the plugin (the MCP bridge speaks Streamable HTTP) but it must still
 * be written into the generated config, because the child requires the field and
 * refuses to start without it. It lives here so the rule "a port is written down
 * exactly once" keeps holding, and so the DriftReport has a single value to
 * compare against.
 */
export declare const DEFAULT_WS_PORT = 8765;
/** API prefix of the child server, taken from the manifest at runtime too. */
export declare const SERVER_HEALTH_PATH = "/health";
export declare const SERVER_MCP_PATH = "/mcp/http";
/** License-tier wording is owned by the child process; we only display it. */
export declare const LICENSE_SERVICE_URL = "https://www.feyagate.com/api/v1/device";
