/**
 * Install / upgrade / rollback / uninstall, expressed as jobs.
 *
 * The invariant that shapes all of it: **the running version and the version on
 * disk must never disagree silently.** Every operation writes the pointer and
 * state before starting the process, and the activation handshake
 * (`state.markPending` → healthy → `confirmHealthy`) is what turns "it started"
 * into "it works". A version that does not reach healthy within its budget is
 * rolled back rather than left in place.
 *
 * Failure handling is the interesting part, and it is uniform:
 *
 *   1. Record the version running before the operation.
 *   2. Stop the child (a Windows binary cannot be replaced while running).
 *   3. Do the work.
 *   4. Start the new version and wait for `/health`.
 *   5. On any failure after step 2 — including user cancellation — start the
 *      previous version again, so the user is never left with nothing running.
 *
 * Step 5 is why "cancel" cannot simply abort: aborting mid-download is fine,
 * but abandoning the machine with a stopped gateway is not.
 */

import { rmSync } from 'node:fs'

import { type ChildApi } from './child-api.js'
import { type JobManager } from './jobs.js'
import { type LogBuffer } from './log.js'
import { loadManifest, latestVersionForPlatform, resolveAsset, isVersionUsable } from './manifest.js'
import { buildDownloadPlans } from './download/sources.js'
import { installBinary } from './download/index.js'
import { binaryName } from './util/platform.js'
import { listInstalledVersions, versionDir } from './paths.js'
import { readSettings } from './settings.js'
import { type Supervisor } from './supervise/process.js'
import { probeHealth } from './supervise/health.js'
import { type StateStore } from './state.js'
import { type PlatformTag } from './util/platform.js'
import type { JobSnapshot } from './types.js'

export interface InstallServiceOptions {
  root: string
  platform: PlatformTag
  state: StateStore
  log: LogBuffer
  jobs: JobManager
  supervisor: Supervisor
  childApi: ChildApi
}

export interface UpdateCheck {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  installedVersions: string[]
  /** Set when this platform's newest release is older than the plugin expects. */
  note: string | null
}

export class InstallService {
  private readonly root: string
  private readonly platform: PlatformTag
  private readonly state: StateStore
  private readonly log: LogBuffer
  private readonly jobs: JobManager
  private readonly supervisor: Supervisor

  constructor(options: InstallServiceOptions) {
    this.root = options.root
    this.platform = options.platform
    this.state = options.state
    this.log = options.log
    this.jobs = options.jobs
    this.supervisor = options.supervisor
    void options.childApi
  }

  private installed(): string[] {
    return listInstalledVersions(this.root, binaryName(this.platform))
  }

  /** What is running versus what the manifest offers for this platform. */
  checkUpdate(): UpdateCheck {
    const current = this.state.get().currentVersion
    let latest: string | null = null
    let note: string | null = null
    try {
      const manifest = loadManifest()
      latest = latestVersionForPlatform(manifest, this.platform)
      if (latest === null) {
        note = `清单中没有适用于 ${this.platform} 的版本`
      } else if (current !== null && latest === current) {
        note = null
      }
    } catch (error) {
      note = `无法读取内置清单：${(error as Error).message}`
    }
    return {
      current,
      latest,
      updateAvailable: latest !== null && (current === null || latest !== current),
      installedVersions: this.installed().sort(),
      note,
    }
  }

  /**
   * Boot-time recovery for an activation that never proved itself.
   *
   * `pending` is written before starting a version and cleared only after
   * `/health` answers. So a pending entry at boot means DSH died (or the start
   * failed) inside that window. Two cases, treated differently:
   *
   *  * the child is *actually running and healthy* → the activation did succeed
   *    and we simply never got to record it; confirm it.
   *  * otherwise → prefer `lastKnownGood`, but only when it is a *different*
   *    version that is still on disk. On a first install there is no good
   *    version, and clearing the pointer would throw away a working binary, so
   *    we keep it and let the normal start attempt decide.
   */
  async recoverPending(): Promise<void> {
    const pending = this.state.get().pending
    if (pending === null) return

    const effectivePort = this.state.get().server.effectivePort
    if (effectivePort !== null && (await probeHealth(effectivePort))) {
      this.log.warn(`发现未确认的版本 v${pending.version}，但服务正在健康运行，按成功处理`)
      this.state.confirmHealthy(pending.version)
      return
    }

    const good = this.state.get().lastKnownGood
    if (good !== null && good !== pending.version && this.installed().includes(good)) {
      this.log.warn(`上次激活 v${pending.version} 未确认成功，已回滚到 v${good}`)
      this.state.setCurrentVersion(good)
      this.state.patch({ pending: null })
      return
    }

    this.log.warn(`上次激活 v${pending.version} 未确认成功，但没有可回滚的版本，将重试启动`)
    this.state.patch({ pending: null })
  }

  /**
   * Install a version (or the platform's newest), optionally upgrading an
   * existing install. Returns the job snapshot immediately; the work continues
   * in the background and the UI polls it.
   */
  startInstall(
    target: string | null,
    options: { allowUnverified?: boolean; reinstall?: boolean; localArchive?: string | null } = {},
  ): JobSnapshot {
    const label = target === null ? '安装后台服务' : `安装后台服务 v${target}`
    const previousVersion = this.state.get().currentVersion
    const settings = readSettings(this.state)

    return this.jobs.start('install', label, async (context) => {
      context.phase('resolving', '正在解析版本与下载来源')
      const manifest = loadManifest()
      const version = target ?? latestVersionForPlatform(manifest, this.platform)
      if (version === null) {
        throw new Error(`内置清单中没有适用于 ${this.platform} 的版本`)
      }
      const usable = isVersionUsable(manifest, this.platform, version)
      if (!usable.ok) throw new Error(usable.reason)

      const resolved = resolveAsset(manifest, this.platform, version)
      if (resolved === null) throw new Error(`清单中不存在 ${this.platform} 的 v${version} 资产`)

      const allowUnverified = options.allowUnverified ?? settings.allowUnverified
      if (resolved.unverified && !allowUnverified) {
        throw new Error(
          `上游未为 ${resolved.asset.file} 提供校验值，无法校验完整性。` +
            '如确认来源可信，请在设置中开启「允许安装无法校验的版本」后重试。',
        )
      }

      // "Already the current version" only justifies doing nothing when that
      // version is actually up. A failed activation can leave `currentVersion`
      // naming a version that never started, and short-circuiting there would
      // report success without installing anything — the one answer a user
      // cannot act on. Requiring a live child keeps the no-op honest.
      if (options.reinstall !== true && previousVersion === version && this.supervisor.pid !== null) {
        return { noop: true, message: `v${version} 已是当前版本，无需安装` }
      }

      const plans = await buildDownloadPlans({
        manifest,
        platform: this.platform,
        version,
        asset: resolved.asset,
        mirrorBase: settings.mirrorBase,
        // A one-shot local package (an upload) wins over the stored setting.
        localArchive: options.localArchive ?? settings.localArchive,
      })
      if (plans.length === 0) {
        throw new Error('没有任何可用的下载来源：GitHub Releases 不可达，且未配置镜像或本地安装包')
      }

      // Stop before swapping: on Windows the executable cannot be replaced while
      // running, and on every platform a half-swapped tree is worse than a gap.
      this.supervisor.setUpgradeInFlight(true)
      let started: { ok: boolean; error: string | null } = { ok: false, error: null }
      let activationFailed = false
      try {
        await this.supervisor.stop()

        context.phase('downloading', `准备从 ${plans[0]!.label} 下载`)
        // Only record sources we will actually try. A source that was skipped
        // (no mirror configured, no local file) was not "attempted", and listing
        // it as such would tell the user we tried something we never did. The
        // reasons still reach them: `installBinary`'s aggregate error lists every
        // candidate with its own explanation.
        for (const plan of plans) {
          if (plan.skipReason === undefined && plan.url !== null) context.attemptSource(plan.label)
        }

        const result = await installBinary({
          root: this.root,
          platform: this.platform,
          version,
          binary: binaryName(this.platform),
          plans,
          signal: context.signal,
          allowUnverified,
          // Without this, "重新安装" on an already-installed version is a silent
          // no-op: `installBinary` is idempotent by default, so nothing gets
          // re-downloaded and the version is never actually repaired.
          reinstall: options.reinstall === true,
          onProgress: (progress) => {
            context.phase(progress.phase === 'extracting' ? 'extracting' : progress.phase === 'verifying' ? 'verifying' : 'downloading', progress.message, {
              percent: progress.percent,
              bytesDone: progress.bytesDone,
              bytesTotal: progress.bytesTotal,
            })
          },
          log: { info: (message) => this.log.info(message), warn: (message) => this.log.warn(message), error: (message) => this.log.error(message) },
        })
        this.log.info(`v${version} 已就位（来源：${result.usedPlan.label}，sha256 ${result.sha256 ?? '未校验'}）`)

        context.phase('activating', `正在切换到 v${version}`)
        // The version being replaced stays reachable as the rollback target.
        this.state.setCurrentVersion(version, { fallbackFrom: previousVersion })

        context.phase('starting', '正在启动并等待健康检查')
        const outcome = await this.supervisor.ensureStarted()
        started = { ok: outcome.ok, error: outcome.error }
        if (!outcome.ok) {
          throw new Error(`v${version} 启动失败：${outcome.error ?? '未知原因'}`)
        }
        return { message: `v${version} 已安装并运行` }
      } catch (error) {
        activationFailed = true
        // Never leave the machine with nothing running: put the previous version
        // back, whether we failed or the user cancelled.
        if (started.ok !== true && previousVersion !== null && this.installed().includes(previousVersion) && previousVersion !== version) {
          this.log.warn(`安装未完成，正在恢复 v${previousVersion}`)
          this.state.setCurrentVersion(previousVersion)
          const restored = await this.supervisor.ensureStarted()
          if (restored.ok) {
            throw new Error(`${(error as Error).message}；已恢复原版本 v${previousVersion}`)
          }
          throw new Error(`${(error as Error).message}；原版本 v${previousVersion} 也未能启动：${restored.error ?? '未知原因'}`)
        }
        throw error
      } finally {
        if (activationFailed) {
          // This activation is over and it did not succeed.
          //
          // `currentVersion` was pointed at `version` before the start attempt,
          // so it must stop claiming it: otherwise the UI shows a current version
          // that is neither installed nor running, and the next attempt at that
          // same version short-circuits as "已是当前版本" — success reported,
          // nothing done.
          if (this.state.get().currentVersion === version) {
            const good = this.state.get().lastKnownGood
            this.state.setCurrentVersion(good !== null && this.installed().includes(good) ? good : null)
          }
          // `pending` means "an activation was in flight and we never learned how
          // it ended". We just learned: it failed. Leaving the marker behind would
          // tell the next boot that DSH died mid-activation and send it down the
          // recovery path for a failure that is already understood.
          if (this.state.get().pending?.version === version) this.state.patch({ pending: null })
        }
        this.supervisor.setUpgradeInFlight(false)
      }
    })
  }

  /** Switch back to `lastKnownGood`, or to a specific installed version. */
  startRollback(target?: string): JobSnapshot {
    const requested = target ?? this.state.get().lastKnownGood ?? undefined
    return this.jobs.start('rollback', `回滚到 v${requested ?? '?'}`, async (context) => {
      context.phase('resolving', '正在确认可回滚的版本')
      if (requested === undefined || requested === null) {
        throw new Error('没有可回滚的历史版本')
      }
      const installed = this.installed()
      if (!installed.includes(requested)) {
        throw new Error(`v${requested} 不在已安装列表中（已安装：${installed.join('、') || '无'}）`)
      }
      if (this.state.get().currentVersion === requested) {
        return { noop: true, message: `v${requested} 已是当前版本` }
      }

      const leaving = this.state.get().currentVersion
      this.supervisor.setUpgradeInFlight(true)
      try {
        await this.supervisor.stop()
        context.phase('activating', `正在切换到 v${requested}`)
        // Symmetric with an upgrade: the version we roll back *from* becomes the
        // target, so a mistaken rollback can be undone from the same button.
        this.state.setCurrentVersion(requested, { fallbackFrom: leaving })
        context.phase('starting', '正在启动并等待健康检查')
        const outcome = await this.supervisor.ensureStarted()
        if (!outcome.ok) throw new Error(`v${requested} 启动失败：${outcome.error ?? '未知原因'}`)
        return { message: `已回滚到 v${requested}` }
      } finally {
        this.supervisor.setUpgradeInFlight(false)
      }
    })
  }

  /**
   * Stop the service and remove installed versions, keeping `data/`.
   *
   * `data/` is preserved on purpose: it holds the device id, the license and
   * every platform token. Deleting it would consume a free trial and force the
   * user to log in to every platform again. The UI says so explicitly.
   */
  startUninstall(options: { purgeData?: boolean } = {}): JobSnapshot {
    return this.jobs.start('uninstall', '卸载后台服务', async (context) => {
      context.phase('resolving', '正在停止后台服务')
      this.supervisor.setUpgradeInFlight(true)
      try {
        await this.supervisor.stop()
      } finally {
        this.supervisor.setUpgradeInFlight(false)
      }

      context.phase('activating', '正在删除已安装的版本')
      for (const version of this.installed()) {
        rmSync(versionDir(this.root, version), { recursive: true, force: true })
      }
      rmSync(`${this.root}/cache`, { recursive: true, force: true })
      this.state.setCurrentVersion(null)
      this.state.patch({ lastKnownGood: null, pending: null })

      if (options.purgeData === true) {
        // Explicitly requested: this deletes the license binding and every token.
        rmSync(`${this.root}/data`, { recursive: true, force: true })
        this.log.warn('已按要求删除 data/：设备标识与全部平台登录信息已被清除')
      }

      return {
        message: options.purgeData === true ? '已卸载，并删除了本地数据' : '已卸载（保留了 data/ 中的授权与登录信息）',
      }
    })
  }
}
