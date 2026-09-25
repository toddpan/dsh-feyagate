/**
 * The child-process supervisor.
 *
 * Owns exactly one long-running `miloco-mcp-server` process and everything that
 * follows from that: where it runs, which port it binds, when it is considered
 * up, when to restart it after a crash, and when to stop trying.
 *
 * Three behaviours are worth reading before changing anything here.
 *
 * **Adoption.** DSH can exit (or be killed) while the child keeps running — it
 * is a foreground child, not a service, but nothing guarantees it dies with the
 * host. On the next boot we therefore look for our own pid file, probe the
 * recorded port, and adopt a healthy process instead of spawning a second one.
 * Restarting the whole gateway because the editor restarted DSH would drop
 * camera connections and platform sessions for no reason.
 *
 * **Drift.** The upstream default port (38080) is also the default of two other
 * FeyaGate wrappers, so it is genuinely often taken. We scan upward and record
 * the effective port, rather than refusing to start.
 *
 * **Circuit breaker.** A server that crashes on start will crash forever, and
 * a restart loop hides that from the user while burning CPU. After
 * `MAX_CRASHES_PER_WINDOW` crashes inside `CRASH_WINDOW_MS` we stop restarting,
 * record the reason, and let the UI say so.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  CRASH_WINDOW_MS,
  MAX_CRASHES_PER_WINDOW,
  PORT_SCAN_RANGE,
  RESTART_BACKOFF_MS,
  STOP_GRACE_MS,
} from '../constants.js'
import { applyEffectivePort, applyWebuiDir, generateConfig } from '../config-gen.js'
import { CHILD_OUTPUT_TAIL_LINES } from '../constants.js'
import { type LogBuffer } from '../log.js'
import { binaryName, type PlatformTag } from '../util/platform.js'
import { configPath, versionDir } from '../paths.js'
import { writeJsonAtomic } from '../util/atomic.js'
import { type StateStore } from '../state.js'
import { findFreePort, probeHealth, waitForHealthy } from './health.js'

/** Contents of `<root>/server.pid`, written on spawn and cleared on clean stop. */
interface PidRecord {
  pid: number
  port: number
  version: string
  startedAt: number
}

export interface SupervisorOptions {
  root: string
  platform: PlatformTag
  state: StateStore
  log: LogBuffer
  /** Notified whenever the observable status changes (start/stop/crash). */
  onChange?: () => void
}

export interface SpawnOutcome {
  ok: boolean
  port: number | null
  error: string | null
  /** True when an already-running process was adopted rather than spawned. */
  adopted: boolean
}

export class Supervisor {
  private readonly root: string
  private readonly platform: PlatformTag
  private readonly state: StateStore
  private readonly log: LogBuffer
  private readonly onChange: () => void

  private child: ChildProcess | null = null
  private adoptedPid: number | null = null
  private adoptedVersion: string | null = null
  private effectivePort: number | null = null
  private startedAt: number | null = null
  private stopping = false
  private disposed = false
  private restartTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private watchdogFailures = 0
  private crashTimestamps: number[] = []
  private circuitOpen = false
  private lastError: string | null = null
  /** Set while an upgrade is swapping versions, so exit events are expected. */
  private upgradeInFlight = false
  /**
   * True between spawning and the first successful health probe.
   *
   * A child that dies during startup has *not* "crashed after running" — it
   * never ran. Without this flag the exit would be attributed to a runtime crash
   * and the supervisor would schedule a backoff restart for a process that
   * cannot possibly come up, turning one bad install into a restart loop.
   */
  private starting = false
  /** Why the current startup ended, when the child died instead of answering. */
  private startFailure: string | null = null
  /** Last lines the child printed; carried into the error so the cause is visible. */
  private childOutput: string[] = []
  /** Aborts the health wait as soon as the child is known to be gone. */
  private startAbort: AbortController | null = null

  constructor(options: SupervisorOptions) {
    this.root = options.root
    this.platform = options.platform
    this.state = options.state
    this.log = options.log
    this.onChange = options.onChange ?? (() => {})
  }

  private pidFile(): string {
    return join(this.root, 'server.pid')
  }

  private readPidFile(): PidRecord | null {
    const file = this.pidFile()
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PidRecord
      return typeof parsed?.pid === 'number' ? parsed : null
    } catch {
      return null
    }
  }

  /** True when a process with this pid exists and we may signal it. */
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means it exists but belongs to someone else; treat as not ours.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private binaryPathFor(version: string): string {
    return join(versionDir(this.root, version), binaryName(this.platform))
  }

  /** Version whose directory actually contains an executable, or null. */
  private activeVersion(): string | null {
    const version = this.state.get().currentVersion
    if (version === null) return null
    return existsSync(this.binaryPathFor(version)) ? version : null
  }

  get effectivePortValue(): number | null {
    return this.effectivePort
  }

  get pid(): number | null {
    return this.child?.pid ?? this.adoptedPid
  }

  get restartCount(): number {
    return this.crashTimestamps.length
  }

  get isCircuitOpen(): boolean {
    return this.circuitOpen
  }

  get lastErrorMessage(): string | null {
    return this.lastError
  }

  get uptimeMs(): number | null {
    return this.startedAt === null ? null : Date.now() - this.startedAt
  }

  setUpgradeInFlight(value: boolean): void {
    this.upgradeInFlight = value
  }

  // ────────────────────────────────────────────────────────────── lifecycle

  /**
   * Bring the service up if it should be up.
   *
   * Idempotent: safe to call on every boot and from the "start" button. Returns
   * the outcome rather than throwing, because "could not start" is a normal
   * state of this system that the UI must display, not an exception.
   */
  async ensureStarted(): Promise<SpawnOutcome> {
    if (this.disposed) return { ok: false, port: null, error: '插件已卸载', adopted: false }
    if (this.child !== null || this.adoptedPid !== null) {
      if (this.effectivePort !== null && (await probeHealth(this.effectivePort))) {
        return { ok: true, port: this.effectivePort, error: null, adopted: this.adoptedPid !== null }
      }
    }

    const version = this.activeVersion()
    if (version === null) {
      return { ok: false, port: null, error: 'not-installed', adopted: false }
    }

    const adopted = await this.tryAdopt(version)
    if (adopted !== null) return adopted

    return this.spawnChild(version)
  }

  /**
   * Take over a process left running by a previous DSH session.
   *
   * Only trusts a pid whose recorded port answers `/health`. A pid file whose
   * process is alive but unhealthy is killed: it is either a wedged server or a
   * recycled pid belonging to something else, and in both cases the right move
   * is to clear it and start our own.
   */
  private async tryAdopt(version: string): Promise<SpawnOutcome | null> {
    const record = this.readPidFile()
    if (record === null || !this.isAlive(record.pid)) {
      if (record !== null) rmSync(this.pidFile(), { force: true })
      return null
    }
    if (await probeHealth(record.port)) {
      this.adoptedPid = record.pid
      this.adoptedVersion = record.version
      this.effectivePort = record.port
      this.startedAt = record.startedAt || Date.now()
      this.state.patch({ server: { effectivePort: record.port } })
      this.log.info(`已接管此前运行中的后台服务（pid ${record.pid}，端口 ${record.port}，版本 ${record.version}）`)
      this.startWatchdog()
      this.onChange()
      return { ok: true, port: record.port, error: null, adopted: true }
    }
    this.log.warn(`pid 文件指向的进程 ${record.pid} 无响应，将清理后重新启动`)
    await this.killPid(record.pid)
    rmSync(this.pidFile(), { force: true })
    return null
  }

  private async spawnChild(version: string): Promise<SpawnOutcome> {
    const binary = this.binaryPathFor(version)
    if (!existsSync(binary)) {
      return { ok: false, port: null, error: `未找到可执行文件：${binary}`, adopted: false }
    }

    // 1. Config first: it carries the port the child will bind.
    const preferred = this.state.get().server.port
    const port = await findFreePort(preferred, PORT_SCAN_RANGE)
    if (port === null) {
      const error = `端口 ${preferred}–${preferred + PORT_SCAN_RANGE} 都被占用，无法启动后台服务`
      this.lastError = error
      this.log.error(error)
      this.onChange()
      return { ok: false, port: null, error, adopted: false }
    }
    generateConfig({ root: this.root, port })
    if (port !== preferred) {
      // Keep the configured intent in state and the effective value in the file.
      applyEffectivePort(this.root, port)
      this.log.warn(`配置端口 ${preferred} 已被占用，本次使用 ${port}`)
    }
    this.effectivePort = port
    this.state.patch({ server: { effectivePort: port } })

    // The payload ships `webui/` inside the version directory, so the child's
    // default relative `webui_dir` would silently disable its built-in web UI.
    applyWebuiDir(this.root, version)

    // 2. Record the pending activation *before* starting, so a crash or power
    //    loss leaves evidence that this version never proved itself.
    this.state.markPending(version)

    this.log.info(`启动后台服务 v${version}（端口 ${port}）：${binary}`)
    this.stopping = false
    this.lastError = null
    this.starting = true
    this.startFailure = null
    this.childOutput = []
    this.startAbort = new AbortController()

    const child = spawn(binary, ['--config', configPath(this.root)], {
      // cwd is the root, because the config file lives there and the child
      // resolves its relative data paths against the config's own directory.
      cwd: this.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.forwardLines(chunk, 'info'))
    child.stderr?.on('data', (chunk: string) => this.forwardLines(chunk, 'warn'))

    child.once('error', (error) => {
      this.lastError = `无法启动后台服务：${error.message}`
      this.log.error(this.lastError)
      this.onChange()
    })

    child.once('exit', (code, signal) => {
      this.handleExit(version, code, signal)
    })

    if (child.pid !== undefined) {
      writeJsonAtomic(this.pidFile(), {
        pid: child.pid,
        port,
        version,
        startedAt: Date.now(),
      } satisfies PidRecord)
      this.startedAt = Date.now()
    }

    const healthy = await waitForHealthy(port, {
      // Without the signal a process that died in 20 ms still costs the full
      // ~20 second budget, and the user watches a spinner for a failure that was
      // already known.
      signal: this.startAbort.signal,
      onAttempt: (attempt) => {
        if (attempt % 6 === 0) this.log.info(`等待后台服务就绪…（${attempt} 次探测）`)
      },
    })

    this.starting = false
    if (!healthy) {
      const cause = this.diagnosticLine()
      const error =
        this.startFailure === null
          ? `后台服务启动后未能在超时时间内通过健康检查（端口 ${port}）${cause === null ? '' : `：${cause}`}${this.startupDetail()}`
          : `${this.startFailure}${cause === null ? '' : `；${cause}`}${this.startupDetail()}`
      this.lastError = error
      this.log.error(error.split('\n')[0]!)
      await this.stop()
      this.onChange()
      return { ok: false, port, error, adopted: false }
    }

    // 3. Confirmed: promote the version and clear the pending marker.
    this.state.confirmHealthy(version)
    this.startWatchdog()
    this.log.info(`后台服务就绪：v${version}，端口 ${port}`)
    this.onChange()
    return { ok: true, port, error: null, adopted: false }
  }

  /** Buffer child output into whole lines so the log pane stays readable. */
  private forwardLines(chunk: string, level: 'info' | 'warn'): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      if (level === 'warn' && /error|fail|fatal/i.test(line)) this.log.error(line, 'server')
      else this.log.push(level, 'server', line)
      if (this.starting) {
        this.childOutput.push(line)
        // A bounded ring: a chatty child must not grow this without limit, and
        // only the tail matters for diagnosing why a startup failed.
        if (this.childOutput.length > CHILD_OUTPUT_TAIL_LINES) this.childOutput.shift()
      }
    }
  }

  /**
   * The single most diagnostic line the child printed.
   *
   * Chosen so the UI's 60-character "原因" line carries the real cause rather
   * than a generic prefix: for a `dyld: Library not loaded` failure the useful
   * text is that line, not "后台服务启动后立即退出".
   */
  private diagnosticLine(): string | null {
    const interesting = this.childOutput.find((line) =>
      /library not loaded|not loaded|no such file|shared librar|symbol not found|cannot open|permission denied|fatal|error/i.test(line),
    )
    return interesting ?? this.childOutput[0] ?? null
  }

  /** Human detail appended to a startup failure: the top cause plus the raw tail. */
  private startupDetail(): string {
    const tail = this.childOutput.slice(-CHILD_OUTPUT_TAIL_LINES)
    if (tail.length === 0) return ''
    return `\n服务自身输出（最后 ${tail.length} 行）：\n${tail.join('\n')}`
  }

  private handleExit(version: string, code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    this.startedAt = null
    rmSync(this.pidFile(), { force: true })

    if (this.disposed || this.stopping) {
      this.starting = false
      this.log.info(`后台服务已停止（code ${code ?? '-'}，signal ${signal ?? '-'}）`)
      this.onChange()
      return
    }

    if (this.starting) {
      // Died before it ever answered. Record why and stop waiting instead of
      // entering the crash-restart path: a binary that cannot start will not
      // start on the third attempt either.
      this.startFailure = `后台服务启动后立即退出（code ${code ?? '-'}，signal ${signal ?? '-'}）`
      this.log.error(this.startFailure)
      this.startAbort?.abort()
      this.onChange()
      return
    }

    if (this.upgradeInFlight) {
      // Expected: an upgrade stops the child on purpose before swapping.
      this.log.info('后台服务已停止（升级流程中）')
      this.onChange()
      return
    }

    const description = `后台服务异常退出（code ${code ?? '-'}，signal ${signal ?? '-'}）`
    this.lastError = description
    this.log.error(description)

    const now = Date.now()
    this.crashTimestamps = this.crashTimestamps.filter((ts) => now - ts < CRASH_WINDOW_MS)
    this.crashTimestamps.push(now)

    if (this.crashTimestamps.length > MAX_CRASHES_PER_WINDOW) {
      this.circuitOpen = true
      this.lastError = `${description}；${CRASH_WINDOW_MS / 1000} 秒内连续 ${this.crashTimestamps.length} 次，已停止自动重启`
      this.log.error(this.lastError)
      this.onChange()
      return
    }

    const backoff = RESTART_BACKOFF_MS[Math.min(this.crashTimestamps.length - 1, RESTART_BACKOFF_MS.length - 1)]!
    this.log.warn(`${backoff} ms 后自动重启（本轮第 ${this.crashTimestamps.length} 次）`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.ensureStarted().then(() => {
        void version
      })
    }, backoff)
    this.restartTimer.unref?.()
    this.onChange()
  }

  /**
   * Watch for a *hung* server: a process that stays alive but stops answering
   * `/health`. Three consecutive misses trigger a restart, because a gateway
   * that cannot answer is indistinguishable from a dead one to the user.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.watchdogFailures = 0
    this.watchdogTimer = setInterval(() => {
      void (async () => {
        if (this.disposed || this.stopping || this.effectivePort === null) return
        if (await probeHealth(this.effectivePort)) {
          this.watchdogFailures = 0
          return
        }
        this.watchdogFailures += 1
        if (this.watchdogFailures < 3) return
        this.watchdogFailures = 0
        this.lastError = '后台服务无响应（连续 3 次健康检查失败），正在重启'
        this.log.error(this.lastError)
        const pid = this.pid
        if (pid !== null) {
          await this.killPid(pid)
          this.child = null
          this.adoptedPid = null
          this.startedAt = null
        }
        void this.ensureStarted()
      })()
    }, 15_000)
    this.watchdogTimer.unref?.()
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
  }

  /** SIGTERM, wait, then SIGKILL. Tolerates a pid that is already gone. */
  private async killPid(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
    const deadline = Date.now() + STOP_GRACE_MS
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  /** Stop the service. Idempotent; resolves once the process is gone. */
  async stop(): Promise<void> {
    this.stopping = true
    this.stopWatchdog()
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const pid = this.pid
    if (pid !== null) {
      this.log.info(`正在停止后台服务（pid ${pid}）`)
      await this.killPid(pid)
    }
    this.child = null
    this.adoptedPid = null
    this.adoptedVersion = null
    this.startedAt = null
    rmSync(this.pidFile(), { force: true })
    this.state.patch({ server: { effectivePort: null } })
    this.stopping = false
    this.onChange()
  }

  async restart(): Promise<SpawnOutcome> {
    await this.stop()
    this.circuitOpen = false
    this.crashTimestamps = []
    return this.ensureStarted()
  }

  /** Release everything. Called from the plugin's `ctx.effect` disposer. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.stopWatchdog()
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    // Deliberately leave the child running: DSH shutting down is not a request
    // to stop the user's gateway. The next boot adopts it via the pid file.
    this.child = null
    this.onChange()
  }

  /** True when the child answers `/health` right now. */
  async healthy(): Promise<boolean> {
    if (this.effectivePort === null) return false
    return probeHealth(this.effectivePort)
  }
}
