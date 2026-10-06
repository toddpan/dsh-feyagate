/**
 * The host HTTP API the browser half talks to.
 *
 * Same-origin, prefix-registered through `ctx.webServer.register`, envelope
 * `{ok, data|error}` — the pattern the plugin's reference implementation already
 * established, so the client half looks like every other DSH plugin's.
 *
 * Two defences are here because this API can install and execute binaries, and
 * the DSH web server is reachable at `127.0.0.1` from *any* page the user has
 * open:
 *
 *   * **Origin check** on every mutating request. A cross-site `fetch` carries
 *     an `Origin` header we can compare against `Host`; a non-browser client
 *     (curl, a script) sends none and is allowed. Browsers cannot omit `Origin`
 *     on a cross-origin write, so this closes the CSRF path without needing a
 *     token.
 *   * **JSON content type required** for JSON writes: an HTML form cannot set
 *     it, which removes the other classic CSRF vector.
 *
 * Read-only routes are deliberately not so protected — a GET that leaks status
 * to a page the user already has open is a much smaller problem than a GET that
 * installs something, and every destructive action here is a POST.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type GatewayRuntime } from './runtime.js';
export interface ApiOptions {
    runtime: GatewayRuntime;
    /** Plugin version, echoed in diagnostics. */
    version: string;
}
/**
 * Build the request handler. Everything it needs is captured here; the plugin
 * registers the returned function once and disposes the route on unload.
 */
export declare function createApiHandler(options: ApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
