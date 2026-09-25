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
  profile: string | null
  /** Human description of where the plugin lives on disk. */
  packageName: string
  installCommand: string
  upgradeCommand: string
  restartHint: string
  /** True when the profile was actually detected (not a placeholder). */
  profileKnown: boolean
}

const PACKAGE_NAME = '@dsh-external/dsh-feyagate-gateway'

/** Read `--profile <name>` / `--profile=<name>` from the host's arguments. */
function detectProfile(): string | null {
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--profile' || arg === '-p') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) return value
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '') return value
    }
  }
  const fromEnv = process.env.DSH_PROFILE
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : null
}

function build(): LauncherInfo {
  const profile = detectProfile()
  const target = profile ?? '<你的 profile 名>'
  return {
    profile,
    packageName: PACKAGE_NAME,
    installCommand: `dsh plugin --profile ${target} add ${PACKAGE_NAME}`,
    upgradeCommand: `dsh plugin --profile ${target} update ${PACKAGE_NAME}`,
    restartHint: '插件版本的切换需要重启 DSH：宿主在启动时读取包的版本，运行期间没有热替换接口。',
    profileKnown: profile !== null,
  }
}

/**
 * Computed once at module load: the host's arguments never change during a run,
 * and the UI reads this on every render.
 */
export const LAUNCHER: LauncherInfo = build()

export { PACKAGE_NAME }
