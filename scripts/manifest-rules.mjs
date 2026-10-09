/**
 * 清单规则（`manifest/server-manifest.json`）—— CLI 与自检**共用同一份实现**。
 *
 * 为什么要单独成模块：这次线上事故的根因不是"清单写错了"，而是"判定规则只在
 * 脚本里以 warning 形式存在"。`verify-manifest.mjs` 当时检查的是 `list[0]`，
 * 而运行时 `resolveAsset()` 按 `zip > tar.gz > exe` 加"优先带校验值"排序后再选，
 * 两者不是同一个资产；并且缺校验值只报警告、不改退出码，于是
 * `npm run build` 全绿，发出去的包在 Windows 上点安装必然被
 * `install.ts` 的校验门拒绝（上游 v1.2.19 的 Windows zip 没有 `.sha256` sidecar）。
 *
 * 所以规则只有一份，且默认通道指向"装不上"的资产是 **error 不是 warning**。
 */

export const PLATFORMS = ['mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64', 'win-x64']

/** 归档类型优先级：数字越小越优先。必须与 `src/manifest.ts` 的 KIND_RANK 一致。 */
const KIND_RANK = { zip: 0, 'tar.gz': 1, exe: 2 }

export function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

/**
 * `src/manifest.ts` 里 `assetRank` 的镜像：先按归档类型，再让同类型里
 * "有 sha256"的排在前面。故意用未导出的 TS 实现来对照：这份规则的唯一职责
 * 就是**预测运行时会选哪个资产**，选错等于没校验。
 */
export function assetRank(asset) {
  const kind = KIND_RANK[asset?.kind]
  const kindRank = kind === undefined ? Number.MAX_SAFE_INTEGER : kind
  return kindRank * 2 + (asset?.sha256 === null || asset?.sha256 === undefined ? 1 : 0)
}

/** 运行时 `resolveAsset()` 会挑中的那个资产；空数组返回 null。 */
export function pickPrimaryAsset(list) {
  let best = null
  for (const asset of list) {
    if (best === null || assetRank(asset) < assetRank(best)) best = asset
  }
  return best
}

/**
 * 校验并汇总。返回 `{ problems, warnings, versions }`：
 *   * `problems` 非空 ⇒ 调用方必须失败（`npm run build` / `check` 退出码 1）；
 *   * `warnings` 只影响可读性，不影响可用性。
 */
export function validateManifest(manifest) {
  const problems = []
  const warnings = []

  if (manifest?.manifestVersion !== 1) {
    problems.push(`manifestVersion 应为 1，实际为 ${manifest?.manifestVersion}`)
  }

  const versions = manifest?.versions ?? {}
  const versionKeys = Object.keys(versions)
  if (versionKeys.length === 0) problems.push('versions 为空')
  const allVersions = [...versionKeys].sort(compareVersions)

  for (const [version, entry] of Object.entries(versions)) {
    if (typeof entry?.releaseTag !== 'string' || entry.releaseTag === '') {
      problems.push(`${version}: 缺少 releaseTag`)
    }
    const assets = entry?.assets ?? {}
    for (const [platform, list] of Object.entries(assets)) {
      if (!PLATFORMS.includes(platform)) {
        problems.push(`${version}: 未知平台键 ${platform}`)
        continue
      }
      if (!Array.isArray(list)) {
        problems.push(`${version}/${platform}: assets 不是数组`)
        continue
      }
      for (const asset of list) {
        if (typeof asset?.file !== 'string' || asset.file === '') {
          problems.push(`${version}/${platform}: 资产缺少 file`)
        }
        if (!['zip', 'tar.gz', 'exe'].includes(asset?.kind)) {
          problems.push(`${version}/${platform}/${asset?.file}: 未知 kind ${asset?.kind}`)
        }
        if (typeof asset?.url !== 'string' || !asset.url.startsWith('https://')) {
          problems.push(`${version}/${platform}/${asset?.file}: url 必须是 https://`)
        }
        if (asset?.sha256 !== null && asset?.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(asset.sha256))) {
          problems.push(`${version}/${platform}/${asset?.file}: sha256 格式不正确`)
        }
        if (typeof asset?.size !== 'number' || asset.size <= 0) {
          warnings.push(`${version}/${platform}/${asset?.file}: size 缺失或为 0`)
        }
      }
    }
  }

  for (const platform of PLATFORMS) {
    const stable = manifest?.channel?.stable?.[platform] ?? null
    if (stable === null) {
      warnings.push(`${platform}: channel.stable 为空（该平台没有可用版本）`)
      continue
    }
    if (!(stable in versions)) {
      problems.push(`${platform}: channel.stable 指向不存在的版本 ${stable}`)
      continue
    }
    const list = versions[stable]?.assets?.[platform] ?? []
    if (list.length === 0) {
      problems.push(`${platform}: channel.stable=${stable} 但该版本没有 ${platform} 资产`)
      continue
    }
    // 这里是这次事故的位置：检查的必须是**运行时会选中的那个资产**，
    // 而且"默认装不上"必须是 error —— 用户点界面上的按钮就会撞上它。
    const primary = pickPrimaryAsset(list)
    if (primary !== null && (primary.sha256 === null || primary.sha256 === undefined)) {
      problems.push(
        `${platform}: 默认版本 ${stable} 的主资产 ${primary.file} 没有 sha256 —— ` +
          '运行时会按"上游未提供校验值"拒绝安装，等于该平台点按钮必失败。' +
          '请把 channel.stable 指向带校验值的资产，或在清单里补上 sha256',
      )
    }
    if (versions[stable]?.releaseTag === undefined) {
      problems.push(`${platform}: 版本 ${stable} 缺少 releaseTag`)
    }

    // 非默认版本可能出现在「指定版本」列表里；缺校验值不是错误（用户可显式确认），
    // 但要让维护者一眼看到哪些版本装起来会多一道确认。
    const unverifiable = Object.keys(versions).filter((version) => {
      const assets = versions[version]?.assets?.[platform]
      if (!Array.isArray(assets) || assets.length === 0) return false
      const asset = pickPrimaryAsset(assets)
      return asset === null || asset.sha256 === null || asset.sha256 === undefined
    })
    if (unverifiable.length > 0) {
      warnings.push(`${platform}: 这些版本的主资产没有校验值，安装时需用户显式确认：${unverifiable.join(', ')}`)
    }
  }

  const min = manifest?.pluginCompat?.minSupportedServer
  if (typeof min !== 'string' || !(min in versions)) {
    problems.push(`pluginCompat.minSupportedServer=${min} 不在 versions 中，升级门槛会永远拒绝或永远放行`)
  }

  const worst = allVersions[0]
  if (worst !== undefined && typeof min === 'string' && compareVersions(min, worst) < 0) {
    warnings.push(`minSupportedServer=${min} 低于清单中最老的版本 ${worst}`)
  }

  return { problems, warnings, versions: allVersions }
}
