#!/usr/bin/env node
/**
 * 清单门禁的自检（不联网、不构建）。
 *
 * 为什么需要它：`verify-manifest.mjs` 曾经把"默认版本没有校验值"只当 warning，
 * 并且检查的是 `assets[0]` 而不是运行时 `resolveAsset()` 会挑中的那个资产。
 * 结果是 0.3.3 在 Windows 上发布了一份"点安装必然被拒"的清单（上游 v1.2.19 的
 * Windows zip 没有 `.sha256` sidecar），而 `npm run build` 全绿。
 *
 * 这个自检用**当前仓库里的真清单**做底稿，只改动被测的那一处，所以它同时钉死
 * 三件事：真清单是好的、"默认版本不可校验"必须报错、判定用的是运行时那种排序
 * （zip 优先于 tar.gz）而不是数组下标。
 *
 * 退出码：0 通过；1 断言失败；2 前置条件不满足（找不到清单）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pickPrimaryAsset, validateManifest } from './manifest-rules.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, '..', 'manifest', 'server-manifest.json')

let base
try {
  base = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(`自检无法进行：读不到 ${manifestPath}（${error.message}）`)
  process.exit(2)
}

let assertions = 0
const failures = []

function check(label, condition, detail) {
  assertions += 1
  if (!condition) failures.push(`${label}${detail === undefined ? '' : ` —— ${detail}`}`)
}

/** 深拷贝底稿，再让 `mutate` 改一处；返回校验结果。 */
function inspect(mutate) {
  const copy = structuredClone(base)
  mutate(copy)
  return validateManifest(copy)
}

const mentions = (problems, needle) => problems.some((line) => line.includes(needle))

// ── ① 仓库里的真清单必须没有错误 ──────────────────────────────────────────
{
  const { problems, warnings } = validateManifest(base)
  check('真清单没有 error', problems.length === 0, problems.join('；'))
  check('真清单的 warning 是数组', Array.isArray(warnings))
}

// ── ② 把 win-x64 的默认版本退回 1.2.19（0.3.3 事故的形状）必须报错 ────────
{
  const { problems } = inspect((copy) => {
    copy.channel.stable['win-x64'] = '1.2.19'
  })
  check('默认版本无校验值 ⇒ error', mentions(problems, 'win-x64'), problems.join('；'))
  check('错误文案点名了资产文件', mentions(problems, 'miloco-mcp-server-1.2.19-windows-x64.zip'), problems.join('；'))
}

// ── ③ 判定必须跟着运行时排序走，而不是 assets[0] ─────────────────────────
// 故意把"可校验的 tar.gz"放在数组第一位，把"不可校验的 zip"放在后面：
// 下标判定会放行，运行时却会选 zip（KIND_RANK: zip < tar.gz），于是装不上。
{
  const version = '1.2.21'
  const { problems } = inspect((copy) => {
    copy.channel.stable['win-x64'] = version
    copy.versions[version].assets['win-x64'] = [
      {
        file: 'miloco-mcp-server-windows-x64-v1.2.21.tar.gz',
        kind: 'tar.gz',
        size: 3721917,
        url: `https://example.invalid/${version}/miloco-mcp-server-windows-x64-v1.2.21.tar.gz`,
        sha256: 'a'.repeat(64),
      },
      {
        file: 'miloco-mcp-server-windows-x64-v1.2.21.zip',
        kind: 'zip',
        size: 3721917,
        url: `https://example.invalid/${version}/miloco-mcp-server-windows-x64-v1.2.21.zip`,
        sha256: null,
      },
    ]
  })
  check('主资产按 zip 优先而非下标 ⇒ error', mentions(problems, 'miloco-mcp-server-windows-x64-v1.2.21.zip'), problems.join('；'))
}

// ── ④ 把同一个 zip 补上校验值 ⇒ 必须放行 ─────────────────────────────────
{
  const version = '1.2.21'
  const { problems } = inspect((copy) => {
    copy.channel.stable['win-x64'] = version
    copy.versions[version].assets['win-x64'] = [
      {
        file: 'miloco-mcp-server-windows-x64-v1.2.21.zip',
        kind: 'zip',
        size: 3721917,
        url: `https://example.invalid/${version}/miloco-mcp-server-windows-x64-v1.2.21.zip`,
        sha256: 'b'.repeat(64),
      },
    ]
  })
  check('默认版本带校验值 ⇒ 无 error', problems.length === 0, problems.join('；'))
}

// ── ⑤ 选主资产的规则本身：zip 优先、同类型优先带校验值 ───────────────────
{
  const picked = pickPrimaryAsset([
    { kind: 'tar.gz', sha256: null },
    { kind: 'zip', sha256: null },
    { kind: 'exe', sha256: 'c'.repeat(64) },
  ])
  check('zip 优先于 tar.gz/exe', picked?.kind === 'zip', `实际 ${picked?.kind}`)

  const sameKind = pickPrimaryAsset([
    { kind: 'zip', sha256: null },
    { kind: 'zip', sha256: 'd'.repeat(64) },
  ])
  check('同类型优先带校验值', sameKind?.sha256 === 'd'.repeat(64))
}

if (failures.length > 0) {
  for (const line of failures) console.error(`  error ${line}`)
  console.error(`清单门禁自检失败：${failures.length}/${assertions} 项断言不通过`)
  process.exit(1)
}
console.log(`  清单门禁 ok：${assertions} 项断言`)
