#!/usr/bin/env node
/**
 * Verify the profile-patch contract.
 *
 * The whole architecture hangs on one assumption: at boot, the loader evaluates
 * the patch's `url` expression and the bridge therefore connects to whatever port
 * the facade is actually listening on. If that fails, the bridge points at a stale
 * port, the tools never appear, and the failure looks like "the plugin is broken"
 * rather than "two ports disagreed".
 *
 * Reading the loader's source suggests it works (patch rows initialise in order,
 * with `apply()` awaited, and `!!js` scalars are evaluated with `ctx` in scope).
 * This script turns that inference into an executable check:
 *
 *   1. the two insert rows exist, in the right order, naming this package;
 *   2. the `url` expression, evaluated exactly as the loader evaluates it, reads
 *      `$DSH_HOME/dsh-feyagate/state.json` and yields the port recorded there;
 *   3. with no `state.json` yet, it still yields a usable loopback default
 *      instead of throwing during boot.
 *
 * Runs offline. `node scripts/check-patch.mjs`
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')
const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  if (condition !== true) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${condition === true ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

const patchText = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')

// Parse exactly the way DSH parses it (`dsh-plugin-manager/lib/types/patch.js`
// and `dsh-app-boot`): a YAML sequence, `!!js` resolved to its raw scalar text,
// and **every** collected error fatal. An indentation mistake in a multi-line
// quoted scalar is caught here rather than during the user's next boot.
const document = parseDocument(patchText, {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
})
const parseError = document.errors[0]
check('patch 是合法 YAML（DSH 解析失败会中断 profile 启动）', parseError === undefined, parseError?.message ?? '')
check('顶层是 YAML 序列（profile patch 的固定形状）', isSeq(document.contents))

const top = document.toJS() ?? []
check('顶层只有一行', top.length === 1, `${top.length} 行`)
check('这唯一的一行是 insert 行（不带 id 表示追加到入口列表末尾）', isMap(document.contents?.items?.[0]) && document.contents.items[0].has('insert'))

const rows = top[0]?.insert ?? []
check('insert 了两行', rows.length === 2, `${rows.length} 行`)
check('第一行是插件本体', rows[0]?.id === 'feyagate-gateway', String(rows[0]?.id))
check('第二行是 MCP 桥', rows[1]?.id === 'feyagate-gateway-mcp', String(rows[1]?.id))

// Row order is the whole reason the facade is already listening when the bridge
// makes its first attempt, so it is asserted rather than assumed.
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
check('第一行指向本包', rows[0]?.name === packageJson.name, `${rows[0]?.name} vs ${packageJson.name}`)
check('第二行使用官方 MCP 桥', rows[1]?.name === '@deepseek-ai/dsh-mcp-client')
check(
  '桥指向门面而不是子进程（url 由表达式决定，不是写死的端口）',
  typeof rows[1]?.config?.url === 'string' && rows[1].config.url.includes('facade'),
)
check('桥使用 Streamable HTTP', rows[1]?.config?.transport === 'streamable-http')
check('桥有独立 serverName（工具前缀 mcp__feyagate__）', rows[1]?.config?.serverName === 'feyagate')
check('启动失败不阻塞 DSH 启动', rows[1]?.config?.failOnStartupError === false)
check('工具调用超时放宽到 3 分钟（摄像头/VLM 往返）', rows[1]?.config?.toolCallTimeoutMs >= 120_000)
check('重连预算被抬高（默认 10 次不够装一次服务）', (rows[1]?.config?.reconnect?.maxAttempts ?? 0) > 10)

// ── evaluate the expression the way the loader does ─────────────────────────

const expression = rows[1]?.config?.url
if (typeof expression !== 'string') {
  check('可以拿到 url 表达式', false)
} else {
  // `vendor/loader/src/config/entry.ts` builds this evaluator with `ctx` in scope.
  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
  const scratch = mkdtempSync(join(tmpdir(), 'feyagate-patch-'))
  const originalHome = process.env.DSH_HOME
  const originalOverride = process.env.DSH_FEYAGATE_HOME

  try {
    // 1. no state.json yet: boot must still get a usable URL, not an exception.
    process.env.DSH_HOME = scratch
    delete process.env.DSH_FEYAGATE_HOME
    let fallback = null
    let threw = null
    try {
      fallback = evaluate({}, expression)
    } catch (error) {
      threw = error
    }
    check('state.json 不存在时不抛异常（否则 DSH 启动就会炸）', threw === null, threw === null ? '' : String(threw))
    check('回落到固定的 loopback 默认端口', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(String(fallback)), String(fallback))
    const defaultPort = Number(/127\.0\.0\.1:(\d+)/.exec(String(fallback))?.[1] ?? 0)
    check('默认端口不是 0 也不是特权端口', defaultPort > 1024 && defaultPort < 65536, `port=${defaultPort}`)

    // 2. state.json present with a drifted port: the bridge must follow it.
    const drifted = 39871
    mkdirSync(join(scratch, 'dsh-feyagate'), { recursive: true })
    writeFileSync(
      join(scratch, 'dsh-feyagate', 'state.json'),
      JSON.stringify({ facade: { port: drifted }, server: { port: 39000 } }),
    )
    const followed = evaluate({}, expression)
    check(
      `读到 state.json 后跟随漂移端口（${drifted}）`,
      followed === `http://127.0.0.1:${drifted}/mcp`,
      String(followed),
    )

    // 3. corrupt state.json must not break boot either.
    writeFileSync(join(scratch, 'dsh-feyagate', 'state.json'), '{ not json')
    let corruptThrew = null
    let corruptValue = null
    try {
      corruptValue = evaluate({}, expression)
    } catch (error) {
      corruptThrew = error
    }
    check('state.json 损坏时不抛异常', corruptThrew === null, corruptThrew === null ? '' : String(corruptThrew))
    check('state.json 损坏时回落到默认端口', corruptValue === fallback, String(corruptValue))

    // 4. the plugin honours its documented HOME override, so tests and
    //    multi-profile setups do not fight over one state file.
    const override = mkdtempSync(join(tmpdir(), 'feyagate-override-'))
    try {
      writeFileSync(join(override, 'state.json'), JSON.stringify({ facade: { port: 39777 } }))
      process.env.DSH_FEYAGATE_HOME = override
      check('遵守 DSH_FEYAGATE_HOME 覆盖', evaluate({}, expression) === 'http://127.0.0.1:39777/mcp', String(evaluate({}, expression)))
      check('两者同时存在时覆盖优先于 DSH_HOME 下的默认位置', evaluate({}, expression) !== `http://127.0.0.1:${drifted}/mcp`)
    } finally {
      rmSync(override, { recursive: true, force: true })
      delete process.env.DSH_FEYAGATE_HOME
    }
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    if (originalOverride === undefined) delete process.env.DSH_FEYAGATE_HOME
    else process.env.DSH_FEYAGATE_HOME = originalOverride
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── the patch must not duplicate rows the profile already owns ──────────────

check('patch 行只有 insert 键（不删除、不覆盖用户的既有行）', Object.keys(top[0] ?? {}).join(',') === 'insert', Object.keys(top[0] ?? {}).join(', '))

console.log(`\n== 结果：${checks - failures.length}/${checks} 通过 ==`)
if (failures.length > 0) {
  console.error('\n失败项：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
