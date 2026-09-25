#!/usr/bin/env node
/**
 * dsh-feyagate 安装链路自检（开发工具，不参与运行时）。
 *
 * 为什么需要它：这条链路里有几类错误在"跑真包"之前完全看不见 ——
 * 校验值算错却照样解压、校验失败后把坏包留在缓存里下次复用、
 * 顶层目录没被上移导致二进制找不到。这些都不会崩，只会安静装出个坏东西。
 * 所以这里用**构造出来的**归档（不联网）把关键行为钉死。
 *
 * 用法（先编译）：
 *   npm run build && node scripts/selfcheck-download.mjs
 *   node scripts/selfcheck-download.mjs --keep  # 失败时保留临时目录便于查看
 *
 * 诚实性约定：任何前置条件不满足（没编译、没有 tar 命令、本机平台不受支持）
 * 都以退出码 2 明确报错，绝不"跳过即通过"；断言失败一律退出码 1。
 * 这个文件是命令行程序，输出走 console 是它的接口 —— 库代码里的日志
 * 一律走调用方传入的 log，两者不冲突。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const keep = process.argv.includes('--keep')
const here = dirname(fileURLToPath(import.meta.url))

/**
 * 找出编译产物。
 *
 * 从本文件所在目录逐级上溯，找 `<祖先>/lib/download/index.js`，并且额外兼容
 * "本文件自己就被放在 lib/ 里"的情况。写成上溯而不是写死 `../../lib`，是因为
 * 这个脚本放在 `scripts/` 还是被拷进 `lib/` 都会有人跑 —— 写死层级的话，
 * 换位置就会静默地"找不到产物"。
 */
function findBuiltLib() {
  let dir = here
  for (let depth = 0; depth < 4; depth += 1) {
    dir = join(dir, '..')
    const nested = join(dir, 'lib', 'download', 'index.js')
    if (existsSync(nested)) return { dir: join(dir, 'lib'), entry: nested }
    const sibling = join(dir, 'download', 'index.js')
    if (existsSync(sibling)) return { dir, entry: sibling }
  }
  return null
}

function die(reason, hint) {
  console.error(`自检无法进行：${reason}`)
  if (hint !== undefined) console.error(hint)
  process.exit(2)
}

const built = findBuiltLib()
if (built === null) {
  die(
    '找不到编译产物 lib/download/index.js',
    '这个自检跑的是真正的编译结果，不是源码。请先在插件目录里执行：\n  npm install && npm run build',
  )
}
if (spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0) {
  die('本机没有可用的 tar 命令（自检用它生成不联网的构造归档）')
}

let installBinary
let detectPlatformTag
let binaryName
try {
  ;({ installBinary } = await import(pathToFileURL(join(built.dir, 'download', 'index.js')).href))
  ;({ detectPlatformTag, binaryName } = await import(pathToFileURL(join(built.dir, 'util', 'platform.js')).href))
} catch (error) {
  die(`加载编译产物失败：${error.message}`, '依赖没装全？请在插件目录里执行：npm install && npm run build')
}

const platform = detectPlatformTag()
if (platform === null) die(`本机平台 ${process.platform}/${process.arch} 不在支持列表内`)

const root = mkdtempSync(join(tmpdir(), 'feyagate-selfcheck-'))
const version = '1.2.99'
const binary = binaryName(platform)
const log = { info: () => {}, warn: () => {}, error: () => {} }
const signal = new AbortController().signal

/** 造一个和上游同构的 tar.gz：一个顶层目录，里面是二进制 + 一个 dylib。 */
function makeArchive(name, { withTopDir = true, payload = 'payload-v1' } = {}) {
  const stage = join(root, `fixture-${name}`)
  const inner = withTopDir ? join(stage, 'miloco-mcp-server') : stage
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, binary), `#!/bin/sh\necho ${payload}\n`)
  chmodSync(join(inner, binary), 0o644)
  writeFileSync(join(inner, 'libmiloco.dylib'), 'not really a dylib')
  const archive = join(root, name)
  const result = spawnSync('tar', ['czf', archive, '-C', stage, withTopDir ? 'miloco-mcp-server' : '.'], {
    // macOS 的 tar 默认会塞 ._ 元数据条目；真实发布包是 Linux 构建机出的，
    // 这里对齐真实形态，元数据鲁棒性另有专门断言。
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (result.status !== 0) die(`生成测试归档失败：tar 退出码 ${result.status}`)
  return {
    path: archive,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  }
}

function planFor(archive, overrides = {}) {
  return {
    kind: 'local',
    label: `本地安装包 ${basename(archive.path)}`,
    url: archive.path,
    isLocalFile: true,
    expectedSha256: archive.sha256,
    expectedMd5: null,
    archiveKind: 'tar.gz',
    ...overrides,
  }
}

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

console.log(`自检 lib: ${built.dir}`)
console.log(`自检平台: ${platform}（二进制名 ${binary}）`)
console.log(`临时目录: ${root}`)
console.log('')

await check('正常安装：校验 → 解压 → 上移顶层目录 → 落地可执行', async () => {
  const archive = makeArchive('happy.tar.gz')
  const installRoot = join(root, 'root-happy')
  const result = await installBinary({
    root: installRoot,
    platform,
    version,
    binary,
    plans: [planFor(archive)],
    signal,
    allowUnverified: false,
    onProgress: () => {},
    log,
  })
  assert(result.binaryPath === join(installRoot, 'versions', version, binary), `落地路径不符：${result.binaryPath}`)
  assert(result.sha256 === archive.sha256, '返回的 sha256 与实际不符')
  assert(existsSync(result.binaryPath), '二进制不存在')
  assert(readFileSync(result.binaryPath, 'utf8').includes('payload-v1'), '二进制内容不对')
  assert(existsSync(join(result.versionDir, 'libmiloco.dylib')), '同目录的 dylib 没跟着一起上移')
  if (platform !== 'win-x64') {
    const mode = statSync(result.binaryPath).mode & 0o777
    assert((mode & 0o111) !== 0, `二进制没有可执行位（mode=${mode.toString(8)}）`)
  }
  const again = await installBinary({
    root: installRoot,
    platform,
    version,
    binary,
    plans: [planFor(archive)],
    signal,
    allowUnverified: false,
    onProgress: () => {},
    log,
  })
  assert(again.binaryPath === result.binaryPath, '重复调用应当是幂等的')
})

await check('校验失败：抛错、删除下载文件、绝不落位', async () => {
  const archive = makeArchive('bad-sha.tar.gz')
  const installRoot = join(root, 'root-badsha')
  let threw = false
  try {
    await installBinary({
      root: installRoot,
      platform,
      version,
      binary,
      plans: [planFor(archive, { expectedSha256: 'f'.repeat(64) })],
      signal,
      allowUnverified: false,
      onProgress: () => {},
      log,
    })
  } catch (error) {
    threw = true
    assert(/校验失败|不一致/.test(error.message), `报错信息里应说明是校验失败：${error.message}`)
  }
  assert(threw, '校验值不匹配却安装成功了 —— 这是最严重的失效')
  assert(!existsSync(join(installRoot, 'versions', version)), '校验失败却留下了版本目录')
  const cached = join(installRoot, 'cache', basename(archive.path))
  assert(!existsSync(cached), '校验失败后没清掉缓存文件，下次可能被复用')
})

await check('没有校验值：默认拒绝，显式 allowUnverified 才装', async () => {
  const archive = makeArchive('unverified.tar.gz')
  const installRoot = join(root, 'root-unverified')
  const plan = planFor(archive, { expectedSha256: null })
  let threw = false
  try {
    await installBinary({
      root: installRoot,
      platform,
      version,
      binary,
      plans: [plan],
      signal,
      allowUnverified: false,
      onProgress: () => {},
      log,
    })
  } catch (error) {
    threw = true
    assert(/校验值|无法校验/.test(error.message), `应提示缺少校验值：${error.message}`)
  }
  assert(threw, '没有校验值时默认必须拒绝安装')
  assert(!existsSync(join(installRoot, 'versions', version)), '拒绝之后不该留下版本目录')

  const allowed = await installBinary({
    root: installRoot,
    platform,
    version,
    binary,
    plans: [plan],
    signal,
    allowUnverified: true,
    onProgress: () => {},
    log,
  })
  // 没有可信校验值，但我们可以如实记录"实际算出来的 sha256"
  assert(allowed.sha256 === archive.sha256, 'allowUnverified 时应记录实际 sha256')
})

await check('顶层目录名与内部条目同名 + macOS 元数据条目，仍能正确上移', async () => {
  const stage = join(root, 'fixture-samename')
  const inner = join(stage, 'miloco-mcp-server')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, binary), '#!/bin/sh\necho same-name\n')
  writeFileSync(join(stage, '._miloco-mcp-server'), 'apple double')
  writeFileSync(join(stage, '.DS_Store'), 'junk')
  const archivePath = join(root, 'samename.tar.gz')
  spawnSync('tar', ['czf', archivePath, '-C', stage, 'miloco-mcp-server', '._miloco-mcp-server', '.DS_Store'])
  const installRoot = join(root, 'root-samename')
  const result = await installBinary({
    root: installRoot,
    platform,
    version,
    binary,
    plans: [planFor({ path: archivePath, sha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex') })],
    signal,
    allowUnverified: false,
    onProgress: () => {},
    log,
  })
  assert(readFileSync(result.binaryPath, 'utf8').includes('same-name'), '二进制内容不对')
})

await check('归档里没有目标二进制：报错并列出顶层内容（不静默成功）', async () => {
  const stage = join(root, 'fixture-wrongname')
  mkdirSync(join(stage, 'miloco-mcp-server'), { recursive: true })
  writeFileSync(join(stage, 'miloco-mcp-server', 'some-other-file'), 'nope')
  const archivePath = join(root, 'wrongname.tar.gz')
  spawnSync('tar', ['czf', archivePath, '-C', stage, 'miloco-mcp-server'])
  const installRoot = join(root, 'root-wrongname')
  let message = ''
  try {
    await installBinary({
      root: installRoot,
      platform,
      version,
      binary,
      plans: [planFor({ path: archivePath, sha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex') })],
      signal,
      allowUnverified: false,
      onProgress: () => {},
      log,
    })
  } catch (error) {
    message = error.message
  }
  assert(message.includes(binary), `报错应点名找不到哪个二进制：${message}`)
  assert(message.includes('some-other-file') || message.includes('顶层内容'), `报错应列出实际内容：${message}`)
})

console.log('')
console.log(`通过 ${passed}，失败 ${failures.length}`)
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`)
  if (keep) console.log(`\n保留临时目录供排查：${root}`)
  else rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
if (keep) console.log(`保留临时目录：${root}`)
else rmSync(root, { recursive: true, force: true })
