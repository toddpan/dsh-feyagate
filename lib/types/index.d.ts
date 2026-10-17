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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
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
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
    tapIndex(transform: (html: string) => string): () => void;
}
/** Our plugin context: the Cordis context plus the one service we inject. */
export type FeyagateContext = Context & {
    webServer: WebServerLike;
};
/** Cordis service dependencies; the host provides both. */
export declare const inject: string[];
export declare const name = "dsh-feyagate";
export interface FeyagateConfig {
    /**
     * Override the install root. Defaults to `$DSH_FEYAGATE_HOME`, then
     * `$DSH_HOME/dsh-feyagate`, then `~/.dsh/dsh-feyagate`.
     */
    installRoot?: string;
    /**
     * Hung-child watchdog timing (defaults: probe every 15s, restart after 3
     * consecutive misses). Exposed so the test suite can exercise the watchdog
     * without waiting 45 seconds, and so a user with an unusual gateway can tune
     * it — it is not a normal setting.
     */
    watchdogIntervalMs?: number;
    watchdogFailures?: number;
}
export declare function apply(ctx: FeyagateContext, config?: FeyagateConfig): Promise<void>;
