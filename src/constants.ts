/**
 * Every constant that a maintainer might need to change, in one file.
 *
 * The rule this file exists to enforce: version numbers, ports, paths, and
 * protocol paths are never duplicated as literals elsewhere in `src/`.
 */

/** npm package name; also the Cordis entry id used in doctor output. */
export const PLUGIN_ID = '@dsh-external/dsh-feyagate-gateway'

/** Short name used for directory names, log prefixes, and DOM ids. */
export const PLUGIN_SHORT = 'dsh-feyagate'

/** `serverName` of the MCP bridge row; makes tool names `mcp__feyagate__*`. */
export const MCP_SERVER_NAME = 'feyagate'

/** Settings namespace and the id of the settings.section registered by the UI. */
export const SETTINGS_NS = 'feyagate'
export const SETTINGS_SECTION_ID = 'feyagate'
export const SETTINGS_SECTION_ORDER = 30

/** Host HTTP API prefix (same-origin from the browser half). */
export const API_PREFIX = '/dsh-feyagate'

/**
 * Global the host injects into index.html so the browser half can find the API
 * prefix without hard-coding it (the prefix is a plugin setting).
 */
export const BROWSER_GLOBAL = '__DSH_FEYAGATE__'

/** Default port of the plugin's always-on MCP facade (the bridge talks here). */
export const DEFAULT_FACADE_PORT = 38081

/** Default port for the child server's own HTTP API. */
export const DEFAULT_SERVER_PORT = 38080

/** How many consecutive ports to probe when the preferred one is taken. */
export const PORT_SCAN_RANGE = 20

/** Child process readiness probing: 40 x 500ms = 20s before we call it failed. */
export const HEALTH_INTERVAL_MS = 500
export const HEALTH_RETRIES = 40
export const HEALTH_REQUEST_TIMEOUT_MS = 1500

/** Crash restart backoff, walked one step at a time and capped at the last. */
export const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000] as const

/** Crash-loop circuit breaker: more than N crashes inside the window stops auto-restart. */
export const CRASH_WINDOW_MS = 60_000
export const MAX_CRASHES_PER_WINDOW = 5

/** Stop sequence: SIGTERM, wait, then SIGKILL. */
export const STOP_GRACE_MS = 5000

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
export const ADOPT_GRACE_MS = 30_000

/** Poll interval used while waiting out `ADOPT_GRACE_MS`. */
export const ADOPT_POLL_MS = 500

/**
 * Hung-child watchdog: probe every `WATCHDOG_INTERVAL_MS`, and after
 * `WATCHDOG_FAILURES` consecutive misses replace the process — unless another
 * live DSH instance owns it (see `PidRecord.ownerPid` in `supervise/process.ts`).
 */
export const WATCHDOG_INTERVAL_MS = 15_000
export const WATCHDOG_FAILURES = 3

/** Download knobs. */
export const DOWNLOAD_TIMEOUT_MS = 120_000
export const DOWNLOAD_MAX_REDIRECTS = 5
export const DOWNLOAD_RETRIES = 2

/** Log ring buffer handed to the UI. */
export const LOG_BUFFER_LINES = 800
/** How many trailing child-output lines a startup failure carries into its error. */
export const CHILD_OUTPUT_TAIL_LINES = 12

export const LOG_FORWARD_LINES = 400

/**
 * The child's WebSocket port.
 *
 * Unused by the plugin (the MCP bridge speaks Streamable HTTP) but it must still
 * be written into the generated config, because the child requires the field and
 * refuses to start without it. It lives here so the rule "a port is written down
 * exactly once" keeps holding, and so the DriftReport has a single value to
 * compare against.
 */
export const DEFAULT_WS_PORT = 8765

/** API prefix of the child server, taken from the manifest at runtime too. */
export const SERVER_HEALTH_PATH = '/health'
export const SERVER_MCP_PATH = '/mcp/http'

/** License-tier wording is owned by the child process; we only display it. */
export const LICENSE_SERVICE_URL = 'https://www.feyagate.com/api/v1/device'
