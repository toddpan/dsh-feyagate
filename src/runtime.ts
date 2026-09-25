/**
 * The runtime container: everything the plugin owns, wired once and disposed
 * together.
 *
 * Start-up is split in two, and the split is the point.
 *
 *  * `startFacade()` is **fast and awaited by `apply()`**. It binds the loopback
 *    port and writes it to `state.json`. `cordis.patch.yml` derives the MCP
 *    bridge URL from that file, and the loader evaluates the bridge row only
 *    after this plugin's `apply()` resolves — so the facade must already be
 *    listening when this returns.
 *  * `startService()` is **slow and deliberately not awaited**. Waiting for a
 *    cold child process to pass `/health` can take twenty seconds; blocking the
 *    host's boot for that would be the wrong trade. Nothing depends on it: the
 *    facade answers `initialize` and an empty `tools/list` in the meantime, so
 *    the model sees a working (if empty) MCP server instead of a failed one.
 *
 * The other ordering rule lives in `startFacade`: `recoverPending()` runs before
 * anything starts the installed version, because it decides whether that version
 * is trustworthy at all.
 */

import { ChildApi } from './child-api.js'
import { LogBuffer } from './log.js'
import { JobManager } from './jobs.js'
import { InstallService } from './install.js'
import { McpFacade } from './mcp/facade.js'
import { listInstalledVersions, serverLogPath } from './paths.js'
import { loadManifest, compatSummary } from './manifest.js'
import { detectPlatformTag, binaryName, type PlatformTag } from './util/platform.js'
import { readSettings } from './settings.js'
import { StateStore } from './state.js'
import { Supervisor } from './supervise/process.js'
import type { RuntimeStatus, ServiceState } from './types.js'

export interface RuntimeOptions {
  /** Plugin version, used in `serverInfo` and the log header. */
  version: string
  /** Install root override; the state store applies its own default when absent. */
  root?: string
}

export class GatewayRuntime {
  readonly log = new LogBuffer()
  readonly state: StateStore
  /** Null when the host platform/arch has no installable build. */
  readonly platform: PlatformTag | null
  readonly jobs: JobManager
  readonly supervisor: Supervisor | null
  readonly facade: McpFacade | null
  readonly childApi: ChildApi | null
  readonly installs: InstallService | null

  private readonly version: string
  private facadeStarted = false
  private bootError: string | null = null
  /** Tracks the health edge so `tools/list_changed` is sent once per transition. */
  private lastHealthy = false

  constructor(options: RuntimeOptions) {
    this.version = options.version
    this.state = new StateStore(options.root)
    this.platform = detectPlatformTag()
    this.jobs = new JobManager(this.log)
    this.log.attachFile(serverLogPath(this.state.root))

    const platform = this.platform
    if (platform === null) {
      // A first-class state, not a crash: an unknown architecture simply has no
      // installable build, and the UI says which platform is unsupported.
      this.supervisor = null
      this.facade = null
      this.childApi = null
      this.installs = null
      this.log.error(`当前平台不受支持（${process.platform}/${process.arch}），无法管理后台服务`)
      return
    }

    this.supervisor = new Supervisor({
      root: this.state.root,
      platform,
      state: this.state,
      log: this.log,
      onChange: () => {
        void this.afterSupervisorChange()
      },
    })
    this.facade = new McpFacade({
      state: this.state,
      log: this.log,
      version: options.version,
      // Read on every request, which is what makes the child's port a runtime
      // detail rather than something baked into the profile patch.
      childPort: () => this.state.get().server.effectivePort,
    })
    this.childApi = new ChildApi({
      log: this.log,
      port: () => this.state.get().server.effectivePort,
    })
    this.installs = new InstallService({
      root: this.state.root,
      platform,
      state: this.state,
      log: this.log,
      jobs: this.jobs,
      supervisor: this.supervisor,
      childApi: this.childApi,
    })
  }

  get root(): string {
    return this.state.root
  }

  get pluginVersion(): string {
    return this.version
  }

  /** Send `tools/list_changed` on the health edge, so tools appear without a restart. */
  private async afterSupervisorChange(): Promise<void> {
    if (this.facade === null || this.supervisor === null) return
    const healthy = await this.supervisor.healthy()
    if (healthy && !this.lastHealthy) {
      this.lastHealthy = true
      this.facade.notifyToolsChanged()
    } else if (!healthy) {
      this.lastHealthy = false
    }
  }

  /**
   * Fast path, awaited by `apply()`. Binds the facade and makes `state.json`
   * reflect the port the MCP bridge must use.
   */
  async startFacade(): Promise<void> {
    if (this.facadeStarted) return
    this.facadeStarted = true

    if (this.state.recoveredFromCorruption) {
      this.log.warn('state.json 无法解析，已按默认值重建；已安装版本会在下次启动时被重新识别')
    }

    if (this.platform === null || this.facade === null || this.installs === null) {
      this.bootError = `当前平台 ${process.platform}/${process.arch} 不受支持`
      return
    }

    // Decide whether the version on disk is trustworthy *before* anything starts it.
    await this.installs.recoverPending()

    try {
      await this.facade.start()
    } catch (error) {
      this.bootError = `无法启动 MCP 门面：${(error as Error).message}`
      this.log.error(this.bootError)
    }
  }

  /** Slow path, intentionally not awaited by `apply()`. */
  async startService(): Promise<void> {
    if (this.platform === null || this.supervisor === null || this.bootError !== null) return
    if (!readSettings(this.state).autoStart) {
      this.log.info('已按设置跳过自动启动（可在设置界面手动启动）')
      return
    }
    const outcome = await this.supervisor.ensureStarted()
    if (outcome.ok) {
      await this.afterSupervisorChange()
    } else if (outcome.error !== 'not-installed') {
      this.log.warn(`后台服务未能自动启动：${outcome.error ?? '未知原因'}`)
    }
  }

  async dispose(): Promise<void> {
    await this.facade?.stop()
    await this.supervisor?.dispose()
    this.facadeStarted = false
  }

  /** One-line description used in the boot log and the diagnostics route. */
  describe(): string {
    return `root=${this.root} platform=${this.platform ?? 'unsupported'} node=${process.version}`
  }

  private stateFor(installed: boolean, healthy: boolean, uptimeMs: number | null): { state: ServiceState; detail?: string } {
    if (this.platform === null) return { state: 'error', detail: '当前平台不受支持' }
    if (this.bootError !== null) return { state: 'error', detail: this.bootError }
    const job = this.jobs.current()
    if (this.jobs.isBusy() && job !== null && (job.kind === 'install' || job.kind === 'rollback')) {
      return { state: 'updating', detail: job.label }
    }
    if (!installed) return { state: 'not-installed', detail: '尚未安装后台服务' }
    if (this.supervisor?.isCircuitOpen === true) {
      return { state: 'error', detail: this.supervisor.lastErrorMessage ?? '后台服务反复异常退出，已停止自动重启' }
    }
    if (healthy) return { state: 'running' }
    if (this.supervisor !== null && this.supervisor.pid !== null) {
      // Alive but not answering: the watchdog restarts it if it stays quiet.
      return uptimeMs !== null && uptimeMs < 25_000
        ? { state: 'starting', detail: '正在启动，等待健康检查通过' }
        : { state: 'degraded', detail: '进程在运行，但健康检查未通过' }
    }
    return { state: 'stopped', detail: this.supervisor?.lastErrorMessage ?? '后台服务未运行' }
  }

  /** Full status for the settings UI. Never throws. */
  async status(): Promise<RuntimeStatus> {
    const platform = this.platform
    const settings = readSettings(this.state)
    const current = this.state.get().currentVersion
    const installedVersions = platform === null ? [] : listInstalledVersions(this.root, binaryName(platform))
    const installed = current !== null && installedVersions.includes(current)
    const healthy = this.supervisor !== null && (await this.supervisor.healthy())
    const uptimeMs = this.supervisor?.uptimeMs ?? null
    const phase = this.stateFor(installed, healthy, uptimeMs)

    let compat: RuntimeStatus['manifest'] = {
      minSupportedServer: '未知',
      maxTestedServer: null,
      latestVersion: null,
      latestVersionMatches: platform,
    }
    if (platform !== null) {
      try {
        compat = compatSummary(loadManifest(), platform)
      } catch (error) {
        this.log.warn(`读取内置清单失败：${(error as Error).message}`)
      }
    }

    return {
      state: phase.state,
      detail: phase.detail,
      installed,
      currentVersion: current,
      lastKnownGood: this.state.get().lastKnownGood,
      pendingVersion: this.state.get().pending?.version ?? null,
      port: settings.serverPort,
      effectivePort: this.state.get().server.effectivePort,
      facadePort: this.state.get().facade.port,
      pid: this.supervisor?.pid ?? null,
      healthy,
      platform: platform ?? 'unknown',
      uptimeMs,
      restarts: this.supervisor?.restartCount ?? 0,
      circuitOpen: this.supervisor?.isCircuitOpen ?? false,
      lastError: this.bootError ?? this.supervisor?.lastErrorMessage ?? null,
      installedVersions,
      manifest: compat,
    }
  }
}
