/**
 * The runtime container: everything the plugin owns, wired once and disposed
 * together.
 *
 * Start-up is split in two, and the split is the point.
 *
 *  * `startFacade()` is **fast and awaited by `apply()`**. It binds the loopback
 *    port and writes it to `state.json`. `cordis.patch.yml` derives the MCP
 *    bridge URL from that file, and the loader evaluates the bridge row only
 *    after this plugin's `apply()` resolves — so the facade must already be
 *    listening when this returns.
 *  * `startService()` is **slow and deliberately not awaited**. Waiting for a
 *    cold child process to pass `/health` can take twenty seconds; blocking the
 *    host's boot for that would be the wrong trade. Nothing depends on it: the
 *    facade answers `initialize` and an empty `tools/list` in the meantime, so
 *    the model sees a working (if empty) MCP server instead of a failed one.
 *
 * The other ordering rule lives in `startFacade`: `recoverPending()` runs before
 * anything starts the installed version, because it decides whether that version
 * is trustworthy at all.
 */
import { ChildApi } from './child-api.js';
import { PlatformAuth } from './platform-auth.js';
import { LogBuffer } from './log.js';
import { JobManager } from './jobs.js';
import { InstallService } from './install.js';
import { McpFacade } from './mcp/facade.js';
import { type PlatformTag } from './util/platform.js';
import { StateStore } from './state.js';
import { Supervisor } from './supervise/process.js';
import type { RuntimeStatus } from './types.js';
export interface RuntimeOptions {
    /** Plugin version, used in `serverInfo` and the log header. */
    version: string;
    /** Install root override; the state store applies its own default when absent. */
    root?: string;
    /** Hung-child watchdog timing; overridable so tests need not wait 45 seconds. */
    watchdogIntervalMs?: number;
    watchdogFailures?: number;
}
export declare class GatewayRuntime {
    readonly log: LogBuffer;
    readonly state: StateStore;
    /** Null when the host platform/arch has no installable build. */
    readonly platform: PlatformTag | null;
    readonly jobs: JobManager;
    readonly supervisor: Supervisor | null;
    readonly facade: McpFacade | null;
    readonly childApi: ChildApi | null;
    /** Platform authorization for the settings page (see `platform-auth.ts`). */
    readonly platformAuth: PlatformAuth | null;
    readonly installs: InstallService | null;
    private readonly version;
    private facadeStarted;
    private bootError;
    /** Tracks the health edge so `tools/list_changed` is sent once per transition. */
    private lastHealthy;
    constructor(options: RuntimeOptions);
    get root(): string;
    get pluginVersion(): string;
    /** Send `tools/list_changed` on the health edge, so tools appear without a restart. */
    private afterSupervisorChange;
    /**
     * Fast path, awaited by `apply()`. Binds the facade and makes `state.json`
     * reflect the port the MCP bridge must use.
     */
    startFacade(): Promise<void>;
    /** Slow path, intentionally not awaited by `apply()`. */
    startService(): Promise<void>;
    dispose(): Promise<void>;
    /** One-line description used in the boot log and the diagnostics route. */
    describe(): string;
    private stateFor;
    /** Full status for the settings UI. Never throws. */
    status(): Promise<RuntimeStatus>;
}
