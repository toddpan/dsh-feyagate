/**
 * Atomic small-file writes.
 *
 * `state.json` and `current` are read on every boot and written during
 * installs, so a half-written file is a real failure mode: a truncated
 * `state.json` loses the rollback target, and a truncated `current` makes the
 * plugin believe nothing is installed. Both are written to a sibling temp file
 * and renamed, which is atomic on the same filesystem.
 */
/** Write UTF-8 text so readers see either the old file or the complete new one. */
export declare function writeFileAtomic(file: string, content: string, mode?: number): void;
/** Write a JSON document, pretty-printed and newline-terminated. */
export declare function writeJsonAtomic(file: string, value: unknown, mode?: number): void;
/**
 * Read and parse JSON, returning `fallback` for a missing, unreadable, or
 * malformed file. Callers that must distinguish "absent" from "broken" should
 * pass `undefined` and check, which is what the state store does.
 */
export declare function readJson<T>(file: string, fallback: T): T;
