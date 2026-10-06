/**
 * 归档解压。
 *
 * 解压是整条安装链路上唯一"把外部字节变成可执行文件"的一步，所以这里的安全
 * 检查不是锦上添花，而是必须自己一个字节一个字节地判：
 *
 *  1. **路径穿越（zip-slip / tar-slip）**：每个条目解出来的绝对路径必须仍在
 *     `destDir` 之内，否则跳过。绝对路径、盘符（`C:\`）、含 `..` 的条目一律
 *     拒绝 —— 上游包一旦被替换（仓库被接管、镜像被投毒），这几条是唯一的防线。
 *  2. **不创建符号链接/硬链接/设备节点**：链接可以把写入重定向到 destDir
 *     之外（先建一个指向 `/etc` 的链接，再往里写文件）。zip 侧我们从不调用
 *     symlink 而是自己写普通文件，tar 侧在 filter 里把非普通文件/目录的条目
 *     全部挡掉。
 *  3. **zip bomb**：单条目与总量都设上限，条目数也设上限。
 *  4. **目标目录必须全新**：不清空别人的目录，宁可报错让上层换个 staging。
 *
 * 「跳过并记警告」的警告走 `onProgress.message` —— 这个签名里没有 logger，
 * 而进度回调是唯一能把这些信息带回 UI 的通道（上层会把它写进任务日志）。
 */
export interface ExtractProgress {
    entriesDone: number;
    entriesTotal: number | null;
    message: string;
}
export interface ExtractResult {
    filesWritten: number;
    topLevelEntries: string[];
}
/**
 * 按文件名判断归档类型。来源侧（清单/镜像/本地文件）的"类型"信息不一定可靠，
 * 而解压器必须选对，所以这个判断集中在一处，谁需要谁来用。
 */
export declare function detectArchiveKind(fileName: string): 'zip' | 'tar.gz' | 'exe' | null;
export declare function extractArchive(options: {
    archive: string;
    kind: 'zip' | 'tar.gz' | 'exe';
    destDir: string;
    onProgress?: (p: ExtractProgress) => void;
}): Promise<ExtractResult>;
/**
 * 归档里只有一个顶层目录时，把它的内容上移一层。
 *
 * 上游两种打包方式并存：Windows 包有一个顶层目录（`miloco-mcp-server/`），
 * mac/Linux 包是平铺的。上移之后两种形态在磁盘上就一致了，调用方只需在
 * 固定位置找二进制。
 *
 * 两个细节是踩过的坑：
 *  * macOS 的 tar/zip 会写入 `._*`（AppleDouble）与 `.DS_Store` 这类纯元数据
 *    条目，它们会让"只有一个顶层目录"的判定失效 —— 必须无视。
 *  * 顶层目录名可能和它内部的条目同名（`miloco-mcp-server/miloco-mcp-server`），
 *    直接 rename 会撞到目录自身（EISDIR）。所以先把整个顶层目录改成一个随机
 *    临时名，再把内容搬上来，最后删掉空壳。
 */
export declare function flattenSingleTopDir(destDir: string): Promise<boolean>;
/** 给二进制补上可执行位。Windows 上 chmod 没有意义，失败也只是忽略。 */
export declare function ensureExecutableMode(file: string): Promise<void>;
/**
 * macOS 上的隔离属性与临时签名。
 *
 * 从浏览器/网盘下下来的 zip 会被打上 `com.apple.quarantine`，Gatekeeper 会
 * 直接拒绝运行（"已损坏"或"无法验证开发者"）；上游二进制又通常是 ad-hoc
 * 签名的，改动 dylib 后签名失效。所以：先对所有 Mach-O 去掉隔离属性，再做
 * 一次 ad-hoc 重签（`codesign --sign -`）——先 dylib 后主二进制，因为主
 * 二进制的签名会引用 dylib 的签名。
 *
 * 没装 Xcode 命令行工具的机器上 `codesign` 可能不存在，那样只记 warning：
 * 装不上比装不上还报错更糟。非 macOS 直接返回空结果。
 */
export declare function fixMacQuarantine(dir: string): Promise<{
    deQuarantined: boolean;
    signed: string[];
    warnings: string[];
}>;
