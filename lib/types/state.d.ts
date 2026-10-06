/**
 * The state store: one mutable file, read at boot, written atomically.
 *
 * Two things here are load-bearing beyond plain persistence:
 *
 *  * **Directory stability.** `root`, `config/`, and `data/` never move once
 *    created. The child process derives its device identity and license
 *    binding from the directory that holds `config.yaml`, so relocating them
 *    would hand an existing user a fresh device id and a fresh free trial.
 *
 *  * **The `pending` handshake.** Activating a new version records `pending`
 *    *before* starting the child and clears it only after a healthy start.
 *    A `pending` entry found at boot therefore means "the last activation never
 *    proved itself" — a crash, a power loss, a failed health check — and the
 *    supervisor rolls back to `lastKnownGood` instead of trusting it.
 */
import type { PersistedState } from './types.js';
/** A patch where the nested state objects may themselves be partial. */
export type StatePatch = Omit<Partial<PersistedState>, 'server' | 'facade' | 'flags'> & {
    server?: Partial<PersistedState['server']>;
    facade?: Partial<PersistedState['facade']>;
    flags?: Record<string, unknown>;
};
export declare class StateStore {
    readonly root: string;
    private state;
    private readonly listeners;
    /** Set when the file on disk was unreadable and we fell back to defaults. */
    readonly recoveredFromCorruption: boolean;
    constructor(root?: string);
    get(): PersistedState;
    subscribe(listener: () => void): () => void;
    private commit;
    /**
     * Shallow-merge a patch and persist. `server`, `facade`, and `flags` merge
     * one level deep, so callers can set a single field without restating the
     * object — which is also why the parameter type widens them to partials.
     */
    patch(patch: StatePatch): PersistedState;
    setFlag(key: string, value: unknown): void;
    getFlag<T>(key: string, fallback: T): T;
    /** Record the version about to be started. Cleared by `confirmPending`. */
    markPending(version: string): void;
    /**
     * Called once the child of `version` answered `/health`. Promotes it to the
     * active version and to `lastKnownGood`, and clears the pending marker.
     */
    confirmHealthy(version: string): void;
    /**
     * Point `current` at a version without claiming it is healthy.
     *
     * `fallbackFrom` is the version being left, and it becomes `lastKnownGood` —
     * which is exactly what the UI's 「回滚到上一版本」 targets. Without it,
     * "last known good" tends to end up equal to the current version, and the
     * rollback path silently disappears at the moment it is most needed: right
     * after an upgrade.
     */
    setCurrentVersion(version: string | null, options?: {
        fallbackFrom?: string | null;
    }): void;
}
