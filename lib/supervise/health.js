/**
 * Health probing and port selection.
 *
 * Two facts about the child process drive everything here:
 *
 *  * `GET /health` returns `{"status":"ok"}` and **nothing else** — no version,
 *    no pid, no subsystem detail. It answers "something is listening and it is
 *    our server", and that is all it can be trusted for. Version identity has
 *    to come from our own bookkeeping.
 *  * There is no readiness protocol beyond that. "Started" means "answered
 *    /health within the budget", so the budget must exist and must expire.
 */
import { createServer } from 'node:net';
import { HEALTH_INTERVAL_MS, HEALTH_REQUEST_TIMEOUT_MS, HEALTH_RETRIES } from '../constants.js';
/** One `/health` request. Never throws: a failure is `false`. */
export async function probeHealth(port, timeoutMs = HEALTH_REQUEST_TIMEOUT_MS) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: 'application/json' },
        });
        if (!response.ok)
            return false;
        const payload = (await response.json());
        return payload?.status === 'ok';
    }
    catch {
        return false;
    }
}
/** True when nothing is listening on the port. */
export function isPortFree(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen({ port, host, exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}
/**
 * First free port at or after `preferred`, scanning at most `range` steps.
 *
 * Drift (rather than failing) is the right default: the common cause is another
 * local service squatting on the upstream default port, and a gateway that
 * works on 38081 is strictly better than one that refuses to start.
 */
export async function findFreePort(preferred, range, host = '127.0.0.1') {
    for (let offset = 0; offset <= range; offset += 1) {
        const candidate = preferred + offset;
        if (candidate > 65535)
            break;
        if (await isPortFree(candidate, host))
            return candidate;
    }
    return null;
}
/**
 * Poll `/health` until it answers or the budget runs out.
 *
 * @returns true when healthy; false on timeout or abort. The caller decides
 * which of the two it was by inspecting its own signal.
 */
export async function waitForHealthy(port, options = {}) {
    const retries = options.retries ?? HEALTH_RETRIES;
    const intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        if (options.signal?.aborted === true)
            return false;
        if (await probeHealth(port))
            return true;
        options.onAttempt?.(attempt, retries);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}
//# sourceMappingURL=health.js.map