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
import { type StateStore } from './state.js';
import type { PluginSettings } from './types.js';
export type { PluginSettings };
declare const DEFAULTS: PluginSettings;
/** Read the settings, falling back to defaults for anything invalid. */
export declare function readSettings(state: StateStore): PluginSettings;
export type SettingsPatch = Partial<PluginSettings>;
/**
 * Validate a patch. Returns an error string instead of throwing so the API can
 * hand the user a precise message ("镜像地址必须是以 https:// 开头的网址").
 */
export declare function validateSettings(patch: SettingsPatch): string | null;
/** Apply a patch, persisting to the state file. Assumes `validateSettings` passed. */
export declare function writeSettings(state: StateStore, patch: SettingsPatch): PluginSettings;
export { DEFAULTS as DEFAULT_SETTINGS };
