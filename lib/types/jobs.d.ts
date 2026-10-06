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
import { type LogBuffer } from './log.js';
import type { JobKind, JobPhase, JobSnapshot } from './types.js';
export interface JobContext {
    signal: AbortSignal;
    /** Move to a new phase, optionally with a message and extra snapshot fields. */
    phase: (phase: JobPhase, message?: string | null, patch?: Partial<JobSnapshot>) => void;
    /** Report byte/percent progress without changing the phase. */
    progress: (patch: Partial<Pick<JobSnapshot, 'percent' | 'bytesDone' | 'bytesTotal' | 'message'>>) => void;
    /** Record a download source that was tried (shown when all of them fail). */
    attemptSource: (label: string) => void;
    log: LogBuffer;
}
export interface JobRunResult {
    /** True when the task ended without changing anything. */
    noop?: boolean;
    /** Replaces the snapshot message on success. */
    message?: string;
}
export declare class JobManager {
    private readonly log;
    private snapshot;
    private controller;
    private running;
    constructor(log: LogBuffer);
    isBusy(): boolean;
    current(): JobSnapshot | null;
    /**
     * Start a task. Throws when one is already running — the caller turns that
     * into a 409 so the UI can say "another operation is in progress" instead of
     * silently queueing two upgrades.
     */
    start(kind: JobKind, label: string, run: (context: JobContext) => Promise<JobRunResult | void>): JobSnapshot;
    /** Request cancellation. Returns false when nothing was running. */
    cancel(): boolean;
}
