/**
 * Platform detection and version comparison.
 *
 * Platform tags are the *manifest's* vocabulary, not Node's. The mapping is
 * deliberately explicit and narrow: a platform we cannot name here is a
 * platform we cannot install on, and saying so up front is better than
 * downloading the wrong binary.
 */
export type PlatformTag = 'mac-arm64' | 'mac-x64' | 'linux-x64' | 'linux-arm64' | 'win-x64';
export declare const PLATFORM_LABELS: Record<PlatformTag, string>;
/** Map the running Node platform/arch pair to a manifest platform tag. */
export declare function detectPlatformTag(platform?: NodeJS.Platform, arch?: string): PlatformTag | null;
/** Executable name inside an installed version directory. */
export declare function binaryName(tag: PlatformTag): string;
/** True when this platform needs the macOS quarantine/codesign fixup. */
export declare function isMac(tag: PlatformTag): boolean;
/** Parse `1.2.20` / `1.2.20-rc.1` into comparable numeric segments. */
export declare function parseVersion(version: string): {
    parts: number[];
    prerelease: string | null;
} | null;
/**
 * Compare two versions: negative when `a < b`, positive when `a > b`, 0 when
 * equal. A prerelease sorts below its release, and unparseable input sorts
 * below everything parseable (so a typo can never look like an upgrade).
 */
export declare function compareVersions(a: string, b: string): number;
/** True when `version` is not older than `minimum`. */
export declare function atLeast(version: string, minimum: string): boolean;
