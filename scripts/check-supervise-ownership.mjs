/**
 * Ownership check for the child-process supervisor.
 *
 * The install root is machine-wide (`~/.dsh/dsh-feyagate`), so several DSH
 * instances can share one `server.pid`. Without ownership, every instance sees
 * "the child is alive but not answering" — usually because it is someone else's
 * child, mid-restart — and kills it, so two instances take turns killing each
 * other's gateway. This exercises the rule that fixes that:
 *
 *   * the instance named in `server.pid` may replace a hung child;
 *   * everyone else is a **guest**: it may adopt and use that child, but when the
 *     child stops answering it reports that honestly instead of killing it;
 *   * once the owner is gone (or with an older/unowned pid file) we take
 *     ownership and may restart it ourselves — self-healing is preserved.
 *
 * It drives the real `Supervisor` from `lib/`, with a fast watchdog so the whole
 * check runs in a couple of seconds rather than 45.
 *
 * Usage: node scripts/check-supervise-ownership.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const base = join(projectRoot, '.smoke-ownership')
const root = join(base, 'root')
const VERSION = '9.9.9'

const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  const ok = condition === true
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * A stand-in child that answers `/health` and then stops listening after
 * `healthyForMs` — the "hung gateway" the watchdog exists for. It closes its
 * listener (rather than accepting and never answering) so probes fail at once,
 * keeping this check fast; the process itself stays alive, which is the point.
 */
function startHungChild(port, healthyForMs) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const { createServer } = require('node:http')
      const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      })
      server.listen(${port}, '127.0.0.1')
      setTimeout(() => server.close(), ${healthyForMs})
      setInterval(() => {}, 600000)   // stay alive after the listener is gone
      `,
    ],
    { stdio: 'ignore' },
  )
  return child
}

/** A live process that is not us, used as the recorded owner. */
function startForeignOwner() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
}

async function main() {
  if (!existsSync(join(projectRoot, 'lib', 'supervise', 'process.js'))) {
    throw new Error('先构建：npm run build')
  }
  const { Supervisor } = await import(join(projectRoot, 'lib', 'supervise', 'process.js'))
  const { StateStore } = await import(join(projectRoot, 'lib', 'state.js'))
  const { LogBuffer } = await import(join(projectRoot, 'lib', 'log.js'))

  console.log('\n== 属主与看门狗检查 ==\n   规则：属主可以替换卡死的子进程，访客只能如实报告\n')

  const makeSupervisor = (label) => {
    const labelRoot = join(base, label)
    if (existsSync(labelRoot)) rmSync(labelRoot, { recursive: true, force: true })
    const state = new StateStore(labelRoot)
    const log = new LogBuffer()
    // A binary that exists (so the version counts as active) but exits at once,
    // so a replaced child fails fast instead of burning the 20s health budget.
    mkdirSync(join(labelRoot, 'versions', VERSION), { recursive: true })
    writeFileSync(join(labelRoot, 'versions', VERSION, 'miloco-mcp-server'), '#!/bin/sh\nexit 1\n')
    state.patch({ currentVersion: VERSION })
    const supervisor = new Supervisor({
      root: labelRoot,
      platform: 'mac-arm64',
      state,
      log,
      watchdogIntervalMs: 200,
      watchdogFailures: 2,
    })
    return { supervisor, state, log, pidFile: join(labelRoot, 'server.pid') }
  }

  // ── 场景 1：pid 文件写明属主是另一个活着的实例 ⇒ 访客不杀它
  {
    const { supervisor, log, pidFile } = makeSupervisor('guest')
    const port = await freePort()
    const child = startHungChild(port, 1500)
    const owner = startForeignOwner()
    await sleep(300)

    writeFileSync(
      pidFile,
      JSON.stringify({ pid: child.pid, port, version: VERSION, startedAt: Date.now(), ownerPid: owner.pid }),
    )

    const adopted = await supervisor.ensureStarted()
    check('接管了那个进程（含属主信息）', adopted.adopted === true && adopted.port === port, `adopted=${adopted.adopted} port=${adopted.port}`)

    const record = JSON.parse(readFileSync(pidFile, 'utf8'))
    check('访客没有篡改属主（pid 文件仍指向原来的属主）', record.ownerPid === owner.pid, `ownerPid=${record.ownerPid} 期望=${owner.pid}`)
    check(
      '日志说明属主是另一个 DSH 实例',
      log.tail(50).some((line) => line.text.includes('属主是另一个 DSH 实例')),
      log.tail(3).map((line) => line.text).join(' | ').slice(0, 120),
    )

    // The child was healthy at adoption and goes quiet right after: exactly the
    // situation the watchdog used to "fix" by killing someone else's process.
    await sleep(1800)
    check('子进程无响应后，访客没有杀掉它', isAlive(child.pid), `pid=${child.pid}`)
    check('访客也没有拉起第二个进程', supervisor.pid === child.pid, `pid=${supervisor.pid}`)
    check(
      '访客如实报告"属于另一个实例"（不假装成功）',
      log.tail(80).some((line) => line.text.includes('属于另一个仍在运行的 DSH 实例')),
      log.tail(2).map((line) => line.text).join(' | ').slice(0, 120),
    )

    // ── 属主消失 ⇒ 才允许重启（自愈能力没有被这次修复丢掉）
    owner.kill('SIGKILL')
    await sleep(1500)
    check('属主消失后，看门狗才替换那个卡死的进程', !isAlive(child.pid), `pid=${child.pid} alive=${isAlive(child.pid)}`)
    check('并且确实自己拉起了（pid 已换）', supervisor.pid !== child.pid, `${child.pid} → ${supervisor.pid}`)

    await supervisor.dispose()
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }

  // ── 场景 2：无人拥有的 pid 文件（旧版写的，或属主已退出）⇒ 接管并成为属主
  {
    const { supervisor, pidFile } = makeSupervisor('claim')
    const port = await freePort()
    const child = startHungChild(port, 60_000)
    await sleep(300)

    writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port, version: VERSION, startedAt: Date.now() }))

    const adopted = await supervisor.ensureStarted()
    check('无属主的进程可以被接管', adopted.adopted === true && adopted.port === port, `adopted=${adopted.adopted}`)

    const record = JSON.parse(readFileSync(pidFile, 'utf8'))
    check('接管后把自己登记为属主（下次卡死时由自己负责）', record.ownerPid === process.pid, `ownerPid=${record.ownerPid} 期望=${process.pid}`)

    await supervisor.dispose()
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }

  rmSync(base, { recursive: true, force: true })
  console.log(`\n== 结果：${checks - failures.length}/${checks} 通过 ==`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('全部通过。')
  }
}

await main()
