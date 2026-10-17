/**
 * How this plugin is installed, upgraded, and restarted — as copyable text.
 *
 * DSH has no plugin self-update API: the package version is read once at boot
 * and only a host restart can change it. So the honest MVP is to *detect* a new
 * version and hand the user the exact command, rather than pretending a hot
 * swap is possible. That makes these strings part of the product surface, and
 * they must be correct for the profile the user is actually running.
 *
 * The profile name comes from the host's own arguments first (`--profile`), then
 * from the environment. When neither is available we emit a placeholder instead
 * of guessing a profile name — running `dsh plugin --profile <wrong> add …`
 * installs into the wrong profile, which is worse than an obvious placeholder.
 */
export interface LauncherInfo {
    /** Detected profile name, or null when it cannot be determined. */
    profile: string | null;
    /** Human description of where the plugin lives on disk. */
    packageName: string;
    installCommand: string;
    upgradeCommand: string;
    restartHint: string;
    /** True when the profile was actually detected (not a placeholder). */
    profileKnown: boolean;
}
declare const PACKAGE_NAME = "dsh-feyagate";
/**
 * Computed once at module load: the host's arguments never change during a run,
 * and the UI reads this on every render.
 */
export declare const LAUNCHER: LauncherInfo;
export { PACKAGE_NAME };
