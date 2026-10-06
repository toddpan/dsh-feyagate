/**
 * 服务器清单的读取、校验与查询。
 *
 * 清单（`manifest/server-manifest.json`）由构建期的 `scripts/gen-manifest.mjs`
 * 生成，是插件唯一可信的"上游发布了什么"的事实来源。为什么运行时不去猜 URL：
 * 上游同一个仓库的资产名每年都在漂移（`-windows-`/`-win-`、`mac-arm64-v1.2.20`
 * 与 `1.2.17-linux-arm64` 混用，有的版本干脆不发某个平台），拼 URL 的代码会在
 * 某些版本上静默下载到错误的东西。所以这里只做"读 + 校验 + 查询"，绝不构造。
 *
 * 校验策略：结构不合法就抛出带文件路径的明确错误，绝不静默返回空结果 ——
 * 「清单坏了」和「这个版本没有这个平台」是两件完全不同的事，前者必须让人看见。
 */
import type { PlatformTag, ResolvedAsset, RuntimeStatus, ServerManifest } from './types.js';
/**
 * 读取并校验捆绑的清单。失败时抛出，错误消息里一定带文件绝对路径 ——
 * 安装失败最常见的原因就是打包时清单没被带上，那时路径是唯一有用的线索。
 */
export declare function loadManifest(): ServerManifest;
/** 该平台真正发布过安装包的版本，升序（旧 → 新）。 */
export declare function listVersionsForPlatform(m: ServerManifest, p: PlatformTag): string[];
/** 该平台能装的最新版本；一个都没有时返回 null。 */
export declare function latestVersionForPlatform(m: ServerManifest, p: PlatformTag): string | null;
/** 解析出该平台该版本优先级最高的资产；没有则该版本在这个平台不可装。 */
export declare function resolveAsset(m: ServerManifest, p: PlatformTag, version: string): ResolvedAsset | null;
/** 状态栏需要的清单摘要（避免 UI 为了这几行再取一次清单）。 */
export declare function compatSummary(m: ServerManifest, p: PlatformTag): RuntimeStatus['manifest'];
/**
 * 这个版本在这个平台上能不能装。两道门：
 *
 *  1. `minSupportedServer` 是硬门槛 —— 低于它的子进程与当前插件的 HTTP/MCP
 *     接口不兼容，装上去只会得到一个起不来的服务，所以必须在下载之前拒绝。
 *  2. 清单里必须有该平台的资产，否则无从下载。
 *
 * 版本号不可解析时 `compareVersions` 把它排在一切之下，于是这里会走第 1 条
 * 拒绝：拼错的版本号永远不可能被当成"升级"放行。
 */
export declare function isVersionUsable(m: ServerManifest, p: PlatformTag, version: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
