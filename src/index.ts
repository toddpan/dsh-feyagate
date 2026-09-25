/**
 * The host-half Cordis plugin entry.
 *
 * `apply` is `async` for one specific reason: the loader awaits the plugin
 * before it applies the *next* row of this bundle's patch (`config/entry.ts` →
 * `_start` → `fiber.await()`), and that next row is the MCP bridge. The bridge's
 * URL is read from `state.json`, which `McpFacade.start()` writes. Resolving
 * `apply` only after the facade is bound is therefore what makes the bridge and
 * the facade agree on a port — including the first boot, when `state.json` does
 * not exist yet and the bridge expression would otherwise fall back to the
 * default and miss a drifted port.
 *
 * Everything slow happens after that await: starting the child process can take
 * twenty seconds on a cold first run. The child is deliberately not on the boot
 * critical path, because its absence is invisible — the facade answers
 * `initialize` and an empty `tools/list` while it is down.
 */

import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import { API_PREFIX, BROWSER_GLOBAL, PLUGIN_ID } from './constants.js'
import { createApiHandler } from './api.js'
import { LAUNCHER } from './launcher.js'
import { GatewayRuntime } from './runtime.js'

/**
 * The slice of the host's web-server service this plugin uses.
 *
 * Declared structurally instead of imported from `@deepseek-ai/dsh-host-webserver`
 * on purpose: the host provides that package at run time, and depending on its
 * types at build time would pin this plugin's build to one host version for no
 * benefit. Two methods is the whole contract.
 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

/** Our plugin context: the Cordis context plus the one service we inject. */
export type FeyagateContext = Context & { webServer: WebServerLike }

/** Cordis service dependencies; the host provides both. */
export const inject = ['webServer']

export const name = PLUGIN_ID

export interface FeyagateConfig {
  /**
   * Override the install root. Defaults to `$DSH_FEYAGATE_HOME`, then
   * `$DSH_HOME/dsh-feyagate`, then `~/.dsh/dsh-feyagate`.
   */
  installRoot?: string
  /**
   * Hung-child watchdog timing (defaults: probe every 15s, restart after 3
   * consecutive misses). Exposed so the test suite can exercise the watchdog
   * without waiting 45 seconds, and so a user with an unusual gateway can tune
   * it — it is not a normal setting.
   */
  watchdogIntervalMs?: number
  watchdogFailures?: number
}

/** Read our own version from package.json without a JSON import or a build flag. */
function readPluginVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    // `lib/index.js` and `src/index.ts` are both one level below the package root.
    const pkg = require('../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Escape a payload for safe embedding inside a `<script>` body. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export async function apply(ctx: FeyagateContext, config: FeyagateConfig = {}): Promise<void> {
  const version = readPluginVersion()
  const runtime = new GatewayRuntime({
    version,
    root: resolveRoot(config.installRoot),
    watchdogIntervalMs: config.watchdogIntervalMs,
    watchdogFailures: config.watchdogFailures,
  })

  ctx.logger?.info(`[${name}] ${runtime.describe()}`)

  // Register the API before starting the facade, so a UI that somehow loads
  // first gets a real answer ("service not installed") instead of a 404 that
  // looks like a broken install.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createApiHandler({ runtime, version }),
    }),
  )

  // Expose the API prefix and a little static context to the browser half. The
  // prefix is a constant today, but hard-coding it in two halves is how they
  // drift apart, so the host injects it.
  ctx.effect(() =>
    ctx.webServer.tapIndex((html: string) => {
      const payload = jsonForScript({ apiPrefix: API_PREFIX, pluginVersion: version, launcher: LAUNCHER })
      const tag = `<script>window.${BROWSER_GLOBAL}=${payload};</script>`
      return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
    }),
  )

  ctx.effect(() => () => {
    void runtime.dispose()
  })

  // Awaited: the facade must be listening, and `state.json` must name its port,
  // before the bridge row in cordis.patch.yml is evaluated. See file header.
  await runtime.startFacade()

  // Not awaited: the child may take tens of seconds and nothing blocks on it.
  void runtime.startService()
}

function resolveRoot(configured?: string): string | undefined {
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_FEYAGATE_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return undefined
}
