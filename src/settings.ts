/**
 * User-editable settings, stored in `state.json` rather than in the Cordis
 * config.
 *
 * That choice is deliberate. Anything living in the profile's `cordis.patch.yml`
 * or plugin config is only read at boot, so changing a port or a mirror would
 * require restarting DSH — which, for this plugin, also means dropping the MCP
 * connection and the child process. Keeping settings in our own state file means
 * the settings UI can change the server port, the mirror, or auto-start and have
 * it take effect on the next start, with no host restart.
 *
 * Values are validated on write, not on read: a hand-edited `state.json` should
 * degrade to the default rather than take the plugin down.
 */

import { type StateStore } from './state.js'
import { DEFAULT_FACADE_PORT, DEFAULT_SERVER_PORT } from './constants.js'
import type { PluginSettings } from './types.js'

export type { PluginSettings }

const DEFAULTS: PluginSettings = {
  mirrorBase: null,
  localArchive: null,
  allowUnverified: false,
  bindAddress: '127.0.0.1',
  cloudServer: 'cn',
  autoStart: true,
  serverPort: DEFAULT_SERVER_PORT,
  facadePort: DEFAULT_FACADE_PORT,
}

const SETTINGS_KEY = 'settings'

function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return null
  // Only https for remote mirrors; the downloader enforces this too, but
  // rejecting it here gives the user a message instead of a silent skip.
  return /^https:\/\/[^\s]+$/.test(trimmed) ? trimmed : null
}

function sanitizePort(value: unknown, fallback: number): number {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback
}

/** Read the settings, falling back to defaults for anything invalid. */
export function readSettings(state: StateStore): PluginSettings {
  const raw = state.getFlag<Record<string, unknown>>(SETTINGS_KEY, {})
  const persisted = raw !== null && typeof raw === 'object' ? raw : {}
  const server = state.get().server
  return {
    mirrorBase: sanitizeUrl(persisted.mirrorBase),
    localArchive: typeof persisted.localArchive === 'string' && persisted.localArchive.trim() !== '' ? persisted.localArchive.trim() : null,
    allowUnverified: persisted.allowUnverified === true,
    bindAddress: persisted.bindAddress === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    cloudServer: typeof persisted.cloudServer === 'string' && persisted.cloudServer.trim() !== '' ? persisted.cloudServer.trim() : DEFAULTS.cloudServer,
    // autoStart and the two ports live in their own state fields, because the
    // supervisor and the facade read them without going through settings.
    autoStart: server.autoStart,
    serverPort: server.port,
    facadePort: state.get().facade.port,
  }
}

export type SettingsPatch = Partial<PluginSettings>

/**
 * Validate a patch. Returns an error string instead of throwing so the API can
 * hand the user a precise message ("镜像地址必须是以 https:// 开头的网址").
 */
export function validateSettings(patch: SettingsPatch): string | null {
  if (patch.mirrorBase !== undefined && patch.mirrorBase !== null && sanitizeUrl(patch.mirrorBase) === null) {
    return '镜像地址必须是以 https:// 开头的网址'
  }
  if (patch.localArchive !== undefined && patch.localArchive !== null && !/^(\/|[A-Za-z]:[\\/])/.test(patch.localArchive)) {
    return '本地安装包必须是绝对路径'
  }
  if (patch.serverPort !== undefined && (patch.serverPort < 1024 || patch.serverPort > 65535)) {
    return '后台服务端口必须在 1024–65535 之间'
  }
  if (patch.facadePort !== undefined && (patch.facadePort < 1024 || patch.facadePort > 65535)) {
    return '门面端口必须在 1024–65535 之间'
  }
  if (patch.facadePort !== undefined && patch.serverPort !== undefined && patch.facadePort === patch.serverPort) {
    return '门面端口不能与后台服务端口相同'
  }
  return null
}

/** Apply a patch, persisting to the state file. Assumes `validateSettings` passed. */
export function writeSettings(state: StateStore, patch: SettingsPatch): PluginSettings {
  const current = readSettings(state)
  const next: PluginSettings = {
    mirrorBase: patch.mirrorBase === undefined ? current.mirrorBase : sanitizeUrl(patch.mirrorBase),
    localArchive: patch.localArchive === undefined ? current.localArchive : patch.localArchive,
    allowUnverified: patch.allowUnverified === undefined ? current.allowUnverified : patch.allowUnverified,
    bindAddress: patch.bindAddress === undefined ? current.bindAddress : patch.bindAddress,
    cloudServer: patch.cloudServer === undefined ? current.cloudServer : patch.cloudServer,
    autoStart: patch.autoStart === undefined ? current.autoStart : patch.autoStart,
    serverPort: patch.serverPort === undefined ? current.serverPort : sanitizePort(patch.serverPort, current.serverPort),
    facadePort: patch.facadePort === undefined ? current.facadePort : sanitizePort(patch.facadePort, current.facadePort),
  }

  state.patch({
    flags: { [SETTINGS_KEY]: next as unknown as Record<string, unknown> },
    server: { port: next.serverPort, autoStart: next.autoStart },
    facade: { port: next.facadePort },
  })

  return next
}

export { DEFAULTS as DEFAULT_SETTINGS }
