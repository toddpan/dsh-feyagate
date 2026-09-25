/**
 * Shared types: the manifest contract, the on-disk state contract, the runtime
 * status the UI renders, and the HTTP API envelope.
 *
 * Everything here is a *contract*. The browser half consumes `RuntimeStatus`,
 * `JobSnapshot`, and `ApiEnvelope` verbatim; the downloader consumes the
 * manifest types; the supervisor owns `PersistedState`.
 */

import type { PlatformTag } from './util/platform.js'

export type { PlatformTag }

// ──────────────────────────────────────────────────────────────── manifest

/** One downloadable archive (or bare executable) for one platform. */
export interface ManifestAsset {
  /** Exact file name as published upstream. Never reconstructed at runtime. */
  file: string
  kind: 'zip' | 'tar.gz' | 'exe'
  /** Published size in bytes, used for progress and sanity checks. */
  size: number
  /** Absolute download URL on the primary (GitHub Releases) channel. */
  url: string
  /**
   * Lower-case hex sha256 from the published `.sha256` sidecar, or computed at
   * manifest-generation time when no sidecar exists. `null` means the asset
   * cannot be verified before install; the UI must ask the user explicitly.
   */
  sha256: string | null
}

export interface ManifestVersion {
  /** Upstream git tag, e.g. `v1.2.20`. */
  releaseTag: string
  publishedAt: string
  /** Only the platforms this release actually shipped. */
  assets: Partial<Record<PlatformTag, ManifestAsset[]>>
}

export interface ServerManifest {
  manifestVersion: number
  generatedAt: string
  server: {
    name: string
    repo: string
    /** MCP endpoint path on the child process, e.g. `/mcp/http`. */
    mcpPath: string
    /** Health endpoint path, e.g. `/health`. */
    healthPath: string
  }
  sources: {
    /** Base for `<base>/<tag>/<file>`. */
    github: string
    /** Fallback manifest URL carrying its own per-platform url + md5. */
    fota: string
  }
  /** FOTA `type` id per platform; null when the channel publishes none. */
  fotaType: Partial<Record<PlatformTag, string | null>>
  pluginCompat: {
    /** Refuse to run anything below this version. */
    minSupportedServer: string
    /** Highest version this plugin build was smoke-tested against. */
    maxTestedServer: string | null
  }
  /** Default target version per platform (newest that actually shipped there). */
  channel: { stable: Partial<Record<PlatformTag, string | null>> }
  /** All known versions, newest last when sorted with `compareVersions`. */
  versions: Record<string, ManifestVersion>
}

/** A resolved download target: one asset plus the version it belongs to. */
export interface ResolvedAsset {
  version: string
  platform: PlatformTag
  asset: ManifestAsset
  /** True when `asset.sha256 === null`: the user must opt in to install it. */
  unverified: boolean
}

// ──────────────────────────────────────────────────────────── persisted state

/**
 * The one mutable file this plugin owns. Written atomically (tmp + rename);
 * read at every boot before anything else happens.
 *
 * Paths are deliberately **stable across versions**: the child process binds
 * its device identity and its license to the directory containing its config,
 * so moving `config.yaml` or `data/` would silently re-bind the user's
 * license and free trial.
 */
export interface PersistedState {
  schemaVersion: 1
  /** Absolute install root (`~/.dsh/dsh-feyagate` by default). */
  root: string
  /** Version currently pointed at by `current`, or null when never installed. */
  currentVersion: string | null
  /** Last version that reached a healthy start; the rollback target. */
  lastKnownGood: string | null
  /**
   * Set while a newly activated version has not yet proven healthy. On the next
   * boot, a pending entry means the previous activation never confirmed, so we
   * roll back instead of trusting the broken version.
   */
  pending: { version: string; startedAt: number } | null
  server: {
    /** Port written into the generated config.yaml. */
    port: number
    /** Drift from `port` when it was occupied at start time. */
    effectivePort: number | null
    /** Start the child automatically whenever DSH boots. */
    autoStart: boolean
  }
  facade: {
    /** Port the always-on MCP facade listens on. Read by cordis.patch.yml. */
    port: number
  }
  /** Free-form flags; read/written only through the state store helpers. */
  flags: Record<string, unknown>
}

/** Status of the managed child service, as shown in the UI status bar. */
export type ServiceState =
  | 'not-installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'error'
  | 'updating'

export interface RuntimeStatus {
  state: ServiceState
  /** One short sentence explaining a non-running state; undefined when running. */
  detail?: string
  installed: boolean
  currentVersion: string | null
  lastKnownGood: string | null
  pendingVersion: string | null
  /** Configured port, and the port actually bound (differs after drift). */
  port: number
  effectivePort: number | null
  facadePort: number
  pid: number | null
  healthy: boolean
  /** `'unknown'` when the host platform/arch has no installable build. */
  platform: PlatformTag | 'unknown'
  /** Milliseconds since the current child process started; null when stopped. */
  uptimeMs: number | null
  /** Number of unexpected restarts since DSH boot. */
  restarts: number
  /** Set when the crash-loop breaker tripped. */
  circuitOpen: boolean
  lastError: string | null
  /** Versions installed under `versions/`, newest last. */
  installedVersions: string[]
  /** Manifest facts the UI needs without a second round trip. */
  manifest: {
    minSupportedServer: string
    maxTestedServer: string | null
    /** Newest version available for this platform. */
    latestVersion: string | null
    /** Which platform the line above was resolved for (null when unsupported). */
    latestVersionMatches: PlatformTag | null
  }
}

// ───────────────────────────────────────────────────────────────────── jobs

export type JobKind = 'install' | 'upgrade' | 'rollback' | 'repair' | 'uninstall'

export type JobPhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'activating'
  | 'starting'
  | 'confirming'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * Progress for a long task. `percent` is null when the total is unknown — the
 * UI renders an indeterminate bar rather than inventing a number.
 */
export interface JobSnapshot {
  id: string
  kind: JobKind
  label: string
  phase: JobPhase
  percent: number | null
  bytesDone: number | null
  bytesTotal: number | null
  /** Human-readable current step, e.g. the file being downloaded. */
  message: string | null
  /** Download sources already tried, oldest first; shown on failure. */
  attemptedSources: string[]
  startedAt: number
  finishedAt: number | null
  error: string | null
  /** Set when the task ended without leaving a change (nothing to clean up). */
  noop: boolean
}

// ────────────────────────────────────────────────────────── server details

/**
 * `GET /api/v1/gateway/info` → `{code, data}` (mirrored by the `gateway/info`
 * MCP tool). Field names are flattened from the child's snake_case payload.
 */
export interface GatewayInfo {
  name: string | null
  /** Runtime version as the child reports it — the authority on what is running. */
  version: string | null
  /** SoC/OS chip string, e.g. `macos-arm64`. */
  platform: string | null
  /**
   * Machine-derived device id (sha256 of `/etc/machine-id`, `IOPlatformUUID`,
   * or the hostname, truncated to 12 hex chars). Stable per machine, not per
   * install, and it is what the license is bound to.
   */
  deviceId: string | null
  /**
   * `false` on Windows: the upstream build compiles camera support out there.
   * The UI must not offer camera features on such a host.
   */
  cameraSupported: boolean | null
  license: {
    edition: string | null
    status: string | null
    product: string | null
    keyMasked: string | null
  }
  raw: Record<string, unknown>
}

/** One entry of `license.capabilities.platforms`, as computed by the child. */
export interface PlatformCapability {
  platform: string
  /** Whether the current edition permits this platform at all. */
  enabled: boolean
  status: string | null
  /** Child-authored explanation, e.g. a trial-expiry sentence. */
  message: string | null
  trialHours: number | null
  trialRemainingHours: number | null
  trialRemainingDays: number | null
}

/**
 * `GET /api/v1/gateway/license` → `{code, data}`.
 *
 * `capabilitiesLoaded === false` means the child has not yet fetched the
 * server-side capability rules and is showing local defaults. That distinction
 * is shown to the user verbatim (the UX copy depends on it), so it is part of
 * this type rather than something the UI infers.
 */
export interface LicenseView {
  edition: string | null
  status: string | null
  product: string | null
  keyMasked: string | null
  deviceId: string | null
  capabilitiesLoaded: boolean
  capabilitiesMessage: string | null
  subscriptionActive: boolean | null
  subscriptionExpiresAt: string | null
  gracePeriodStartAt: string | null
  gracePeriodExpiresAt: string | null
  graceRemainingDays: number | null
  features: Record<string, unknown>
  platforms: PlatformCapability[]
  raw: Record<string, unknown>
}

/**
 * One entry of the `auth/platforms` MCP tool: is a platform account logged in?
 *
 * Deliberately separate from `PlatformCapability`: this is *authentication*
 * state (the user's account), the other is *entitlement* (the license). The UX
 * doc keeps those words apart on purpose, and so does this type.
 */
export interface PlatformAccount {
  platformId: string
  platformName: string
  authenticated: boolean
  /** Platform-specific extras (`cloud_server`, `token_remaining_seconds`, …). */
  authStatus: Record<string, unknown>
}

/** A camera as reported by `xiaomi/camera_list`. */
export interface CameraSummary {
  deviceId: string
  name: string
  online: boolean
}

// ───────────────────────────────────────────────────────────────── settings

/**
 * User-editable settings. Defined here rather than in `settings.ts` because the
 * browser half renders exactly this shape; one definition keeps the API and the
 * form from drifting apart.
 *
 * These live in `state.json`, not in the Cordis config: anything in the profile
 * patch is read only at boot, so changing a port would require restarting DSH.
 */
export interface PluginSettings {
  /**
   * Base URL of a self-hosted mirror. Community forks and offline deployments
   * point this at their own channel; the plugin then tries
   * `<mirrorBase>/<file>` before giving up.
   */
  mirrorBase: string | null
  /** Absolute path to a local archive, used as the last-resort source. */
  localArchive: string | null
  /**
   * Install an asset that publishes no checksum at all. Off by default and
   * surfaced as an explicit confirmation, because "we could not verify this" is
   * exactly where a silent default is unacceptable.
   */
  allowUnverified: boolean
  /**
   * `127.0.0.1` keeps the child on loopback. Upstream ships `0.0.0.0`, which
   * exposes the gateway and its platform tokens to the whole LAN, so LAN
   * exposure is opt-in here.
   */
  bindAddress: '127.0.0.1' | '0.0.0.0'
  /** Child's cloud region, forwarded to `auth.cloud_server`. */
  cloudServer: string
  /** Start the child whenever DSH boots. */
  autoStart: boolean
  serverPort: number
  facadePort: number
}

// ──────────────────────────────────────────────────────────── HTTP envelope

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string }

export interface LogLine {
  ts: number
  level: 'info' | 'warn' | 'error'
  /** `plugin` for host messages, `server` for child stdout/stderr. */
  source: 'plugin' | 'server'
  text: string
}
