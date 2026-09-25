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

import { readFileSync } from 'node:fs'

import { compareVersions } from './util/platform.js'
import { writeJsonAtomic } from './util/atomic.js'
import { defaultRoot, ensureLayout, readCurrentPointer, stateFile, writeCurrentPointer } from './paths.js'
import { DEFAULT_FACADE_PORT, DEFAULT_SERVER_PORT } from './constants.js'
import type { PersistedState } from './types.js'

function defaults(root: string): PersistedState {
  return {
    schemaVersion: 1,
    root,
    currentVersion: null,
    lastKnownGood: null,
    pending: null,
    server: { port: DEFAULT_SERVER_PORT, effectivePort: null, autoStart: true },
    facade: { port: DEFAULT_FACADE_PORT },
    flags: {},
  }
}

/**
 * Merge a file that may predate the current schema (or have been hand-edited)
 * onto the defaults, validating each field. Unknown extra keys are dropped
 * rather than carried, so a stale key can never resurrect removed behaviour.
 */
function normalize(root: string, raw: unknown): PersistedState {
  const base = defaults(root)
  if (raw === null || typeof raw !== 'object') return base
  const input = raw as Partial<PersistedState> & Record<string, unknown>

  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  const port = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number.NaN
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
  }

  const server = (input.server ?? {}) as Partial<PersistedState['server']>
  const facade = (input.facade ?? {}) as Partial<PersistedState['facade']>

  return {
    schemaVersion: 1,
    root,
    currentVersion: str(input.currentVersion),
    lastKnownGood: str(input.lastKnownGood),
    pending:
      input.pending !== null && typeof input.pending === 'object' && typeof (input.pending as any).version === 'string'
        ? { version: String((input.pending as any).version), startedAt: Number((input.pending as any).startedAt) || Date.now() }
        : null,
    server: {
      port: port(server.port, DEFAULT_SERVER_PORT),
      effectivePort: server.effectivePort === null || server.effectivePort === undefined ? null : port(server.effectivePort, DEFAULT_SERVER_PORT),
      autoStart: server.autoStart !== false,
    },
    facade: { port: port(facade.port, DEFAULT_FACADE_PORT) },
    flags: input.flags !== null && typeof input.flags === 'object' ? { ...(input.flags as Record<string, unknown>) } : {},
  }
}

/** A patch where the nested state objects may themselves be partial. */
export type StatePatch = Omit<Partial<PersistedState>, 'server' | 'facade' | 'flags'> & {
  server?: Partial<PersistedState['server']>
  facade?: Partial<PersistedState['facade']>
  flags?: Record<string, unknown>
}

export class StateStore {
  readonly root: string
  private state: PersistedState
  private readonly listeners = new Set<() => void>()
  /** Set when the file on disk was unreadable and we fell back to defaults. */
  readonly recoveredFromCorruption: boolean

  constructor(root: string = defaultRoot()) {
    this.root = root
    ensureLayout(root)
    const file = stateFile(root)
    let parsed: unknown = null
    let corrupt = false
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // ENOENT is the normal first-boot case; anything else means the file
      // existed but could not be read or parsed, which is worth reporting.
      corrupt = code !== 'ENOENT' && code !== undefined
      parsed = null
    }
    this.recoveredFromCorruption = corrupt
    this.state = normalize(root, parsed)

    // The pointer file is the tiebreaker: if it names a version, trust it over
    // a stale state field, because the pointer is written last during activation.
    const pointed = readCurrentPointer(root)
    if (pointed !== null && pointed !== this.state.currentVersion) {
      this.state.currentVersion = pointed
    }
  }

  get(): PersistedState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(): void {
    writeJsonAtomic(stateFile(this.root), this.state)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Shallow-merge a patch and persist. `server`, `facade`, and `flags` merge
   * one level deep, so callers can set a single field without restating the
   * object — which is also why the parameter type widens them to partials.
   */
  patch(patch: StatePatch): PersistedState {
    this.state = normalize(this.root, {
      ...this.state,
      ...patch,
      server: { ...this.state.server, ...(patch.server ?? {}) },
      facade: { ...this.state.facade, ...(patch.facade ?? {}) },
      flags: { ...this.state.flags, ...(patch.flags ?? {}) },
    })
    this.commit()
    return this.state
  }

  setFlag(key: string, value: unknown): void {
    this.patch({ flags: { ...this.state.flags, [key]: value } })
  }

  getFlag<T>(key: string, fallback: T): T {
    const value = this.state.flags[key]
    return value === undefined ? fallback : (value as T)
  }

  /** Record the version about to be started. Cleared by `confirmPending`. */
  markPending(version: string): void {
    this.patch({ pending: { version, startedAt: Date.now() } })
  }

  /**
   * Called once the child of `version` answered `/health`. Promotes it to the
   * active version and to `lastKnownGood`, and clears the pending marker.
   */
  confirmHealthy(version: string): void {
    const previousGood = this.state.lastKnownGood
    // A version that answered `/health` is good by definition. Keep a *different*
    // existing fallback: that is the way back. Only fall back to recording this
    // version when there is nothing else, so a fresh install still has a value
    // that means "the only thing that has ever worked here".
    const nextGood = previousGood !== null && previousGood !== version ? previousGood : version
    writeCurrentPointer(this.root, version)
    this.patch({ currentVersion: version, lastKnownGood: nextGood, pending: null })
  }

  /**
   * Point `current` at a version without claiming it is healthy.
   *
   * `fallbackFrom` is the version being left, and it becomes `lastKnownGood` —
   * which is exactly what the UI's 「回滚到上一版本」 targets. Without it,
   * "last known good" tends to end up equal to the current version, and the
   * rollback path silently disappears at the moment it is most needed: right
   * after an upgrade.
   */
  setCurrentVersion(version: string | null, options: { fallbackFrom?: string | null } = {}): void {
    if (version === null) {
      this.patch({ currentVersion: null, server: { effectivePort: null } })
      return
    }
    const fallback = options.fallbackFrom ?? null
    const nextGood = fallback !== null && fallback !== version ? fallback : this.state.lastKnownGood
    writeCurrentPointer(this.root, version)
    this.patch({ currentVersion: version, lastKnownGood: nextGood })
  }
}
