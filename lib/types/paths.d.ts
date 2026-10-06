/**
 * Filesystem layout.
 *
 * Everything this plugin owns lives under one root, and the *shape* below is a
 * compatibility contract:
 *
 *   <root>/
 *     state.json                  the only mutable bookkeeping file
 *     config.yaml                 generated; read back and merged, never clobbered
 *     data/                       child-owned: tokens, license.json, memory, skills
 *     logs/server.log             child stdout/stderr, size-capped
 *     versions/<version>/         one immutable install per version
 *     cache/                      downloaded archives and extracted staging
 *     current                     pointer file naming the active version
 *
 * `config.yaml` sits **at the root, not in a `config/` subdirectory**, and that
 * is not a style choice. The child resolves every relative path against the
 * directory holding the config file (`src/config.cpp` → `resolve_path`, applied
 * to `license_file`, every `*_token_file`, `memory.data_dir`, and
 * `skill.*_dir`), and `src/main.cpp` derives its own data directory the same
 * way. So "the directory next to config.yaml" *is* the data root. Putting the
 * file in `config/` would silently relocate `data/` to `config/data/`, and —
 * worse — move `license.json`, which is where the device id and the license
 * binding live. A user upgrading the plugin would appear as a new device and
 * get a fresh free trial.
 */
/** The DSH home directory (`$DSH_HOME`, else `~/.dsh`). */
export declare function dshHome(): string;
/** Default install root for this plugin. */
export declare function defaultRoot(): string;
/**
 * Package directory (contains `manifest/`, `skills/`, `cordis.patch.yml`).
 *
 * One level up, not two: this module lives at `src/paths.ts` in the checkout and
 * at `lib/paths.js` in the published package, and both are exactly one level
 * below the package root. Getting this wrong is invisible until run time, when
 * the manifest silently fails to load and every platform reports "no version".
 */
export declare function packageRoot(): string;
/** Absolute path of the bundled server manifest. */
export declare function manifestPath(): string;
/** Path of the bundled skill documentation shipped with the plugin. */
export declare function skillsDir(): string;
export declare function stateFile(root: string): string;
/** The generated child config. Its directory is the child's data root. */
export declare function configPath(root: string): string;
/** Child-owned data directory (tokens, license.json, memory, skills). */
export declare function dataDir(root: string): string;
export declare function logsDir(root: string): string;
export declare function serverLogPath(root: string): string;
export declare function versionsDir(root: string): string;
export declare function versionDir(root: string, version: string): string;
export declare function cacheDir(root: string): string;
/** Pointer file naming the active version (a file, not a symlink: Windows). */
export declare function currentPointerPath(root: string): string;
export declare function readCurrentPointer(root: string): string | null;
/**
 * Remove the `current` pointer.
 *
 * The pointer is the tiebreaker read at startup, so a state that says "nothing
 * is current" while the pointer still names a version would be silently
 * overridden back to that version on the next boot.
 */
export declare function clearCurrentPointer(root: string): void;
export declare function writeCurrentPointer(root: string, version: string): void;
/** List version directories that contain an executable. */
export declare function listInstalledVersions(root: string, binary: string): string[];
export declare function ensureDir(path: string): string;
/** Create every directory the plugin expects, idempotently. */
export declare function ensureLayout(root: string): void;
