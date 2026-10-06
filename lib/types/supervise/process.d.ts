/**
 * The child-process supervisor.
 *
 * Owns exactly one long-running `miloco-mcp-server` process and everything that
 * follows from that: where it runs, which port it binds, when it is considered
 * up, when to restart it after a crash, and when to stop trying.
 *
 * Three behaviours are worth reading before changing anything here.
 *
 * **Adoption.** DSH can exit (or be killed) while the child keeps running — it
 * is a foreground child, not a service, but nothing guarantees it dies with the
 * host. On the next boot we therefore look for our own pid file, probe the
 * recorded port, and adopt a healthy process instead of spawning a second one.
 * Restarting the whole gateway because the editor restarted DSH would drop
 * camera connections and platform sessions for no reason.
 *
 * **Drift.** The upstream default port (38080) is also the default of two other
 * FeyaGate wrappers, so it is genuinely often taken. We scan upward and record
 * the effective port, rather than refusing to start.
 *
 * **Circuit breaker.** A server that crashes on start will crash forever, and
 * a restart loop hides that from the user while burning CPU. After
 * `MAX_CRASHES_PER_WINDOW` crashes inside `CRASH_WINDOW_MS` we stop restarting,
 * record the reason, and let the UI say so.
 */
import { type LogBuffer } from '../log.js';
import { type PlatformTag } from '../util/platform.js';
import { type StateStore } from '../state.js';
export interface SupervisorOptions {
    root: string;
    platform: PlatformTag;
    state: StateStore;
    log: LogBuffer;
    /** Notified whenever the observable status changes (start/stop/crash). */
    onChange?: () => void;
    /**
     * How often the hung-child watchdog probes, and how many consecutive misses
     * mean "restart". Defaults come from `constants.ts`; overridable so tests can
     * exercise the watchdog without waiting 45 seconds.
     */
    watchdogIntervalMs?: number;
    watchdogFailures?: number;
}
export interface SpawnOutcome {
    ok: boolean;
    port: number | null;
    error: string | null;
    /** True when an already-running process was adopted rather than spawned. */
    adopted: boolean;
}
export declare class Supervisor {
    private readonly root;
    private readonly platform;
    private readonly state;
    private readonly log;
    private readonly onChange;
    private readonly watchdogIntervalMs;
    private readonly watchdogFailureLimit;
    private child;
    private adoptedPid;
    private adoptedVersion;
    /** True when the adopted child belongs to another live DSH instance (see `PidRecord`). */
    private guestOfForeignOwner;
    /** Set once, so a guest does not repeat the same warning every watchdog tick. */
    private warnedForeignOwner;
    private effectivePort;
    private startedAt;
    private stopping;
    private disposed;
    private restartTimer;
    private watchdogTimer;
    private watchdogFailures;
    private crashTimestamps;
    private circuitOpen;
    private lastError;
    /** Set while an upgrade is swapping versions, so exit events are expected. */
    private upgradeInFlight;
    /**
     * True between spawning and the first successful health probe.
     *
     * A child that dies during startup has *not* "crashed after running" — it
     * never ran. Without this flag the exit would be attributed to a runtime crash
     * and the supervisor would schedule a backoff restart for a process that
     * cannot possibly come up, turning one bad install into a restart loop.
     */
    private starting;
    /** Why the current startup ended, when the child died instead of answering. */
    private startFailure;
    /** Last lines the child printed; carried into the error so the cause is visible. */
    private childOutput;
    /** Aborts the health wait as soon as the child is known to be gone. */
    private startAbort;
    constructor(options: SupervisorOptions);
    private pidFile;
    private readPidFile;
    /** True when a process with this pid exists and we may signal it. */
    private isAlive;
    private binaryPathFor;
    /** Version whose directory actually contains an executable, or null. */
    private activeVersion;
    get effectivePortValue(): number | null;
    get pid(): number | null;
    get restartCount(): number;
    get isCircuitOpen(): boolean;
    get lastErrorMessage(): string | null;
    get uptimeMs(): number | null;
    setUpgradeInFlight(value: boolean): void;
    /**
     * Bring the service up if it should be up.
     *
     * Idempotent: safe to call on every boot and from the "start" button. Returns
     * the outcome rather than throwing, because "could not start" is a normal
     * state of this system that the UI must display, not an exception.
     */
    ensureStarted(): Promise<SpawnOutcome>;
    /**
     * Take over a process left running by a previous DSH session.
     *
     * Only trusts a pid whose recorded port answers `/health`. A pid file whose
     * process is alive but unhealthy is killed: it is either a wedged server or a
     * recycled pid belonging to something else, and in both cases the right move
     * is to clear it and start our own.
     */
    private tryAdopt;
    /** Record an adopted process and hand it to the watchdog. */
    private adoptRecord;
    /** True when the record names a live owner that is not this process. */
    private foreignOwnerAlive;
    /**
     * Whether the currently supervised process belongs to another live instance.
     *
     * Trusts the pid file when it still describes our child, and falls back to what
     * we recorded at adoption time (the owner may have rewritten the file).
     */
    private ownedByForeignInstance;
    /** Poll `/health` until it answers, the budget runs out, or we are disposed. */
    private waitForHealth;
    private spawnChild;
    /** Buffer child output into whole lines so the log pane stays readable. */
    private forwardLines;
    /**
     * The single most diagnostic line the child printed.
     *
     * Chosen so the UI's 60-character "原因" line carries the real cause rather
     * than a generic prefix: for a `dyld: Library not loaded` failure the useful
     * text is that line, not "后台服务启动后立即退出".
     */
    private diagnosticLine;
    /** Human detail appended to a startup failure: the top cause plus the raw tail. */
    private startupDetail;
    private handleExit;
    /**
     * Watch for a *hung* server: a process that stays alive but stops answering
     * `/health`. Three consecutive misses trigger a restart, because a gateway
     * that cannot answer is indistinguishable from a dead one to the user.
     */
    private startWatchdog;
    private stopWatchdog;
    /** SIGTERM, wait, then SIGKILL. Tolerates a pid that is already gone. */
    private killPid;
    /** Stop the service. Idempotent; resolves once the process is gone. */
    stop(): Promise<void>;
    restart(): Promise<SpawnOutcome>;
    /** Release everything. Called from the plugin's `ctx.effect` disposer. */
    dispose(): Promise<void>;
    /** True when the child answers `/health` right now. */
    healthy(): Promise<boolean>;
}
