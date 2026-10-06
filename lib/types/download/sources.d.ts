/**
 * 下载来源的收集与排序。
 *
 * 上游有四个可能的包来源，可靠性依次下降，所以顺序即优先级：
 *
 *   ① github —— 清单里记录的**精确** URL（含发布侧 sha256），唯一"该版本必然
 *      存在过"的来源；
 *   ② fota   —— 官方 OTA 渠道，运行时读 `fota.json`。它是**独立渠道**：
 *      文件名、版本号都和 GitHub 不一样（`miloco-mcp-server-1.2.19-Darwin-x86_64.tar.gz`），
 *      所以只能按 `type` 匹配，绝不能拿文件名去比对；
 *   ③ mirror —— 用户自建镜像前缀，URL 由 `<前缀>/<文件名>` 拼出，沿用 GitHub 的
 *      sha256（镜像只是搬运，内容应当逐字节一致）；
 *   ④ local  —— 用户自己指定的本地压缩包（内网/离线场景）。
 *
 * 任何一个来源都不允许把整体拖垮：FOTA 拿不到、镜像没配、本地文件不存在，
 * 都只让那一个来源"缺席"。缺席原因会写进 plan 的 `skipReason` 并留在返回
 * 列表里 —— 失败时 UI 才能说清"我试过/为什么没试哪些来源"。
 */
import type { ManifestAsset, ServerManifest } from '../types.js';
import type { PlatformTag } from '../util/platform.js';
export type SourceKind = 'github' | 'fota' | 'mirror' | 'local';
export interface DownloadPlan {
    kind: SourceKind;
    /** 面向用户的一句话来源描述，例如 "GitHub Releases v1.2.20"。 */
    label: string;
    /** 下载地址；`isLocalFile` 为 true 时是本地绝对路径。跳过项为 null。 */
    url: string | null;
    isLocalFile: boolean;
    expectedSha256: string | null;
    expectedMd5: string | null;
    /**
     * 归档类型。清单里已经写明（GitHub/镜像就是同一个文件），FOTA 与本地包则
     * 由各自的文件名推断 —— 解压器选错类型会直接报错，所以能带就带上，
     * 别让下游再猜一次。
     */
    archiveKind?: 'zip' | 'tar.gz' | 'exe';
    /**
     * 该来源为什么不可用。带此字段的 plan 只是"诊断记录"：
     * `installBinary` 会把它算作一次没试成的来源，绝不会拿它去下载。
     */
    skipReason?: string;
}
export declare function buildDownloadPlans(options: {
    manifest: ServerManifest;
    platform: PlatformTag;
    version: string;
    asset: ManifestAsset;
    /** 用户可配置的镜像前缀，例如 https://mirror.example.com/miloco */
    mirrorBase: string | null;
    /** 用户点选/配置的本地压缩包绝对路径 */
    localArchive: string | null;
    timeoutMs?: number;
}): Promise<DownloadPlan[]>;
