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
