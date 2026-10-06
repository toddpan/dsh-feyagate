/**
 * 安装编排：下载 → 校验 → 解压 → 落位。
 *
 * 这个文件里最重要的不是流程本身，而是**顺序**和**清理**：
 *
 *  * **先校验、后解压**。解压会把外部字节变成可执行文件；只有确认字节与
 *    发布侧一致之后才允许发生。校验失败就删掉下载文件并抛出 —— 绝不"先解开
 *    看看再说"，那样落进 staging 的东西已经没有意义，但已经消耗了解压器的
 *    攻击面（zip bomb、路径穿越）。
 *  * **staging 是唯一的写入点**。所有解压/改权限/签名都发生在一个随机命名的
 *    staging 目录里，最后整目录 `rename` 到 `versions/<version>`。中途失败时
 *    `versions/` 里不会留下半个安装（半个安装会让 UI 显示"已安装"而进程起不来）。
 *  * **一次失败只影响一个来源**。网络、404、校验不通过都只是"换下一个来源"，
 *    全部失败才抛聚合错误，且消息里逐条列出试过谁、为什么失败。
 */
import type { DownloadPlan } from './sources.js';
import type { PlatformTag } from '../util/platform.js';
export interface InstallBinaryOptions {
    root: string;
    platform: PlatformTag;
    version: string;
    binary: string;
    plans: DownloadPlan[];
    signal: AbortSignal;
    allowUnverified: boolean;
    /**
     * 显式重装。默认（false/未给）是幂等的：目标版本已装好就直接返回成功。
     * 但"修复/重装同一个版本"必须能真的重下一次，调用方（`install.ts` 的
     * `reinstall`）要么传这个开关，要么先把 `versions/<version>` 删掉 ——
     * 只靠默认行为重装会变成一次空操作，用户看到"已安装"却什么都没修。
     */
    reinstall?: boolean;
    onProgress: (p: {
        phase: 'downloading' | 'verifying' | 'extracting';
        percent: number | null;
        bytesDone: number | null;
        bytesTotal: number | null;
        message: string;
    }) => void;
    log: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
}
export interface InstallBinaryResult {
    version: string;
    versionDir: string;
    binaryPath: string;
    usedPlan: DownloadPlan;
    /** 实际在本地算出的 sha256（未校验时也记录，供用户事后核对）。 */
    sha256: string | null;
    /** 依次失败的来源与原因，失败时用于展示"我试过哪些"。 */
    attempts: Array<{
        label: string;
        error: string;
    }>;
}
/**
 * 按优先级依次尝试各来源，装出 `versions/<version>/<binary>`。
 *
 * 幂等：目标已存在且二进制在就直接返回；不做重复下载，也不去"修复"它
 * （修复是 repair 语义，由上层先删目录再调这里，或显式传 reinstall）。
 */
export declare function installBinary(options: InstallBinaryOptions): Promise<InstallBinaryResult>;
