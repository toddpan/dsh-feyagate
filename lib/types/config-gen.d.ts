/**
 * `config.yaml` generation — the single writer for the managed fields.
 *
 * The child process both reads and *writes* its own config: saving the Vision
 * model, the trigger engine, or the Xiaozhi endpoint list rewrites the YAML in
 * place. So this file is not "our file" in the usual sense. Two rules keep that
 * from turning into two writers fighting over one document:
 *
 *   1. **We never replace the document.** We load whatever is on disk, deep-set
 *      only the fields listed in `MANAGED_FIELDS`, and write the whole thing
 *      back. Every key we do not own — including keys from a *newer* child
 *      version that we have never heard of — survives untouched.
 *   2. **The managed set is deliberately small.** Port, bind address, and the
 *      data-relative paths we are responsible for. Everything about platforms,
 *      vision, triggers, memory, and skills belongs to the child, and is edited
 *      through its MCP tools, not through us.
 *
 * `data/`-relative paths matter more than they look. The child resolves them
 * against the directory holding this file, and it binds the device id and the
 * license to that same directory. Keeping them relative means the root can be
 * moved as a whole (or backed up and restored) without re-binding the license.
 */
/** Dotted paths this plugin owns and may overwrite on every generation. */
export declare const MANAGED_FIELDS: readonly ["server.http_port", "server.bind_address", "server.webui_dir", "server.ws_port", "auth.token_file", "tuya.token_file", "midea.token_file", "ewelink.token_file", "huawei.token_file", "memory.data_dir", "skill.user_dir", "skill.builtin_dir"];
/**
 * Fields written once, only when absent.
 *
 * These configure the child's own behaviour, so a user who changed them
 * (in the child's WebUI or by hand) must not have that change reverted by a
 * plugin upgrade. Applying them conditionally is what makes an upgrade safe.
 */
export declare const SEED_ONLY_FIELDS: readonly ["camera.frame_interval", "camera.buffer_max_size", "camera.buffer_ttl", "camera.reconnect_min", "camera.reconnect_max", "camera.jpeg_quality", "auth.cloud_server", "xiaozhi.reconnect_interval_ms", "vision.enabled", "vision.base_url", "vision.model", "trigger.enabled", "memory.enabled", "skill.enabled"];
export interface ConfigGenerationInput {
    root: string;
    /** Port the child is being told to listen on for this start. */
    port: number;
    bindAddress?: string;
    cloudServer?: string;
}
type Dict = Record<string, unknown>;
declare function getPath(document: Dict, dotted: string): unknown;
/** Read the config as a plain object; `{}` when absent or unparseable. */
export declare function loadConfig(root: string): Dict;
/** True when the file exists but has no `server.http_port` (a fresh stub). */
export declare function needsGeneration(root: string): boolean;
/**
 * Write the managed fields into the existing document.
 *
 * @returns the path written and whether the content actually changed, so the
 * caller can log "config regenerated" only when something moved.
 */
export declare function generateConfig(input: ConfigGenerationInput): {
    path: string;
    changed: boolean;
    document: Dict;
};
/**
 * Rewrite only `server.http_port`.
 *
 * Used when the preferred port was occupied and we are starting on a drifted
 * one. Doing it as a targeted edit (rather than a full regeneration) keeps the
 * intent explicit: the configured port stays in `state.json`, while the file
 * reflects what this particular start is bound to.
 */
export declare function applyEffectivePort(root: string, port: number): {
    path: string;
    changed: boolean;
};
/**
 * Point `server.webui_dir` at the installed version's own `webui/` directory.
 *
 * The child resolves this value against its working directory, which is the
 * install root — but the release payload puts `webui/` inside the *version*
 * directory. Left as the upstream default (`webui`), `set_mount_point` fails and
 * the child merely logs "WebUI directory not found (web UI disabled)": one
 * silently dropped feature, which is exactly the failure mode that hides for
 * months. An absolute path makes it work, and re-pointing it on every activation
 * keeps it correct across upgrades instead of pinning the old version's assets.
 *
 * Returns without writing when the version ships no `webui/` directory, so a
 * payload change upstream cannot leave a dangling absolute path in the config.
 */
export declare function applyWebuiDir(root: string, version: string): {
    path: string;
    changed: boolean;
};
export { getPath as getConfigPath };
