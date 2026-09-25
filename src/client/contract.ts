/**
 * The browser half's type contract.
 *
 * Every export here is a **type-only** re-export of the host half's shared
 * types, so nothing in this file survives into the bundle — the client never
 * pulls `node:fs`, the supervisor, or any other host code into a browser. It
 * exists so the client's imports read as one coherent contract instead of a
 * scattered list of relative paths, and so a host-side rename breaks the build
 * here rather than silently rendering `undefined` in the UI.
 */

export type {
  ApiEnvelope,
  AuthCapabilities,
  CameraSummary,
  GatewayInfo,
  JobKind,
  JobPhase,
  JobSnapshot,
  LicenseView,
  LogLine,
  PlatformAccount,
  PlatformCapability,
  PluginSettings,
  RuntimeStatus,
  ServiceState,
  TuyaQrStatus,
  TuyaQrTicket,
} from '../types.js'

/** One entry of `GET /install/catalog`. */
export interface CatalogEntry {
  version: string
  publishedAt: string | null
  file: string | null
  size: number | null
  sha256: string | null
  unverified: boolean
  isCurrent: boolean
  installed: boolean
}
