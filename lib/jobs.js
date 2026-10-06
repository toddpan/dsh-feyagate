/**
 * One-at-a-time long-running tasks, with progress and cancellation.
 *
 * Installs, upgrades, and rollbacks all mutate the same two things — the active
 * version and the running process — so they must never run concurrently. Rather
 * than guarding each operation separately, this class owns the single slot and
 * the UI reads progress from one place.
 *
 * The finished snapshot deliberately outlives the task: after an upgrade fails,
 * the user needs to see *why*, and the reason must survive until they start
 * something else. So `current()` keeps returning the last result until a new
 * task begins.
 */
import { randomUUID } from 'node:crypto';
export class JobManager {
    log;
    snapshot = null;
    controller = null;
    running = false;
    constructor(log) {
        this.log = log;
    }
    isBusy() {
        return this.running;
    }
    current() {
        return this.snapshot;
    }
    /**
     * Start a task. Throws when one is already running — the caller turns that
     * into a 409 so the UI can say "another operation is in progress" instead of
     * silently queueing two upgrades.
     */
    start(kind, label, run) {
        if (this.running)
            throw new Error('已有任务正在进行，请等待完成或先取消');
        const controller = new AbortController();
        this.controller = controller;
        this.running = true;
        const snapshot = {
            id: randomUUID(),
            kind,
            label,
            phase: 'queued',
            percent: null,
            bytesDone: null,
            bytesTotal: null,
            message: null,
            attemptedSources: [],
            startedAt: Date.now(),
            finishedAt: null,
            error: null,
            noop: false,
        };
        this.snapshot = snapshot;
        const context = {
            signal: controller.signal,
            phase: (phase, message = null, patch = {}) => {
                Object.assign(snapshot, { phase, message }, patch);
            },
            progress: (patch) => {
                Object.assign(snapshot, patch);
            },
            attemptSource: (sourceLabel) => {
                if (!snapshot.attemptedSources.includes(sourceLabel))
                    snapshot.attemptedSources.push(sourceLabel);
            },
            log: this.log,
        };
        void (async () => {
            try {
                const result = (await run(context)) ?? {};
                snapshot.noop = result.noop === true;
                snapshot.phase = 'done';
                snapshot.message = result.message ?? snapshot.message;
                snapshot.percent = 100;
            }
            catch (error) {
                const aborted = controller.signal.aborted;
                snapshot.phase = aborted ? 'cancelled' : 'failed';
                snapshot.error = aborted ? '已取消' : error.message;
                this.log[aborted ? 'warn' : 'error'](`${label}${aborted ? '已取消' : '失败'}：${snapshot.error}`);
            }
            finally {
                snapshot.finishedAt = Date.now();
                this.running = false;
                this.controller = null;
            }
        })();
        return snapshot;
    }
    /** Request cancellation. Returns false when nothing was running. */
    cancel() {
        if (!this.running || this.controller === null)
            return false;
        this.controller.abort();
        return true;
    }
}
//# sourceMappingURL=jobs.js.map