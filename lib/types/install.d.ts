/**
 * Install / upgrade / rollback / uninstall, expressed as jobs.
 *
 * The invariant that shapes all of it: **the running version and the version on
 * disk must never disagree silently.** Every operation writes the pointer and
 * state before starting the process, and the activation handshake
 * (`state.markPending` → healthy → `confirmHealthy`) is what turns "it started"
 * into "it works". A version that does not reach healthy within its budget is
 * rolled back rather than left in place.
 *
 * Failure handling is the interesting part, and it is uniform:
 *
 *   1. Record the version running before the operation.
 *   2. Stop the child (a Windows binary cannot be replaced while running).
 *   3. Do the work.
 *   4. Start the new version and wait for `/health`.
 *   5. On any failure after step 2 — including user cancellation — start the
 *      previous version again, so the user is never left with nothing running.
 *
 * Step 5 is why "cancel" cannot simply abort: aborting mid-download is fine,
 * but abandoning the machine with a stopped gateway is not.
 */
import { type ChildApi } from './child-api.js';
import { type JobManager } from './jobs.js';
import { type LogBuffer } from './log.js';
import { type Supervisor } from './supervise/process.js';
import { type StateStore } from './state.js';
import { type PlatformTag } from './util/platform.js';
import type { JobSnapshot } from './types.js';
export interface InstallServiceOptions {
    root: string;
    platform: PlatformTag;
    state: StateStore;
    log: LogBuffer;
    jobs: JobManager;
    supervisor: Supervisor;
    childApi: ChildApi;
}
export interface UpdateCheck {
    current: string | null;
    latest: string | null;
    updateAvailable: boolean;
    installedVersions: string[];
    /** Set when this platform's newest release is older than the plugin expects. */
    note: string | null;
}
export declare class InstallService {
    private readonly root;
    private readonly platform;
    private readonly state;
    private readonly log;
    private readonly jobs;
    private readonly supervisor;
    constructor(options: InstallServiceOptions);
    private installed;
    /** What is running versus what the manifest offers for this platform. */
    checkUpdate(): UpdateCheck;
    /**
     * Boot-time recovery for an activation that never proved itself.
     *
     * `pending` is written before starting a version and cleared only after
     * `/health` answers. So a pending entry at boot means DSH died (or the start
     * failed) inside that window. Two cases, treated differently:
     *
     *  * the child is *actually running and healthy* → the activation did succeed
     *    and we simply never got to record it; confirm it.
     *  * otherwise → prefer `lastKnownGood`, but only when it is a *different*
     *    version that is still on disk. On a first install there is no good
     *    version, and clearing the pointer would throw away a working binary, so
     *    we keep it and let the normal start attempt decide.
     */
    recoverPending(): Promise<void>;
    /**
     * Install a version (or the platform's newest), optionally upgrading an
     * existing install. Returns the job snapshot immediately; the work continues
     * in the background and the UI polls it.
     */
    startInstall(target: string | null, options?: {
        allowUnverified?: boolean;
        reinstall?: boolean;
        localArchive?: string | null;
    }): JobSnapshot;
    /** Switch back to `lastKnownGood`, or to a specific installed version. */
    startRollback(target?: string): JobSnapshot;
    /**
     * Stop the service and remove installed versions, keeping `data/`.
     *
     * `data/` is preserved on purpose: it holds the device id, the license and
     * every platform token. Deleting it would consume a free trial and force the
     * user to log in to every platform again. The UI says so explicitly.
     */
    startUninstall(options?: {
        purgeData?: boolean;
    }): JobSnapshot;
}
