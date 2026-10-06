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
/** One `/health` request. Never throws: a failure is `false`. */
export declare function probeHealth(port: number, timeoutMs?: number): Promise<boolean>;
/** True when nothing is listening on the port. */
export declare function isPortFree(port: number, host?: string): Promise<boolean>;
/**
 * First free port at or after `preferred`, scanning at most `range` steps.
 *
 * Drift (rather than failing) is the right default: the common cause is another
 * local service squatting on the upstream default port, and a gateway that
 * works on 38081 is strictly better than one that refuses to start.
 */
export declare function findFreePort(preferred: number, range: number, host?: string): Promise<number | null>;
export interface WaitForHealthyOptions {
    retries?: number;
    intervalMs?: number;
    signal?: AbortSignal;
    /** Called after each failed probe, for progress reporting. */
    onAttempt?: (attempt: number, retries: number) => void;
}
/**
 * Poll `/health` until it answers or the budget runs out.
 *
 * @returns true when healthy; false on timeout or abort. The caller decides
 * which of the two it was by inspecting its own signal.
 */
export declare function waitForHealthy(port: number, options?: WaitForHealthyOptions): Promise<boolean>;
