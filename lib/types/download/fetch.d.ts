/**
 * 下载原语：流式写文件 + 拉取小文本（FOTA 清单）。
 *
 * 这里刻意不用 Node 的 http 模块，也不把响应体整块读进内存：安装包有
 * 10–60MB，而插件和 DSH 主进程在同一个进程里，一次 `arrayBuffer()` 就能让
 * 桌面上多出一个 60MB 的常驻 Buffer。所以一律流式落盘。
 *
 * 另一个刻意的选择是**手动处理重定向**（`redirect: 'manual'` 而不是
 * `'follow'`）：Node 自带的上限是 20 跳，而我们要求最多
 * `DOWNLOAD_MAX_REDIRECTS` 跳，并且每一跳都必须仍是 https —— 从 https 跳到
 * http 意味着后续字节可被中间人替换，配合 sha256 校验虽然能挡住，但没校验值
 * 的包就完全没有防线了，所以直接拒绝。
 */
export interface DownloadProgress {
    bytesDone: number;
    bytesTotal: number | null;
}
/** 判断一个异常是不是"用户取消"。上层据此区分取消与失败，不再继续换源。 */
export declare function isAbortError(error: unknown): boolean;
/**
 * 下载到本地文件。成功返回写入的字节数。
 *
 * 失败时目标文件可能残留（半截文件），由调用方负责删除 —— 本函数不删，
 * 因为"谁决定重试/换源"只有调用方知道。
 */
export declare function downloadToFile(options: {
    url: string;
    dest: string;
    signal: AbortSignal;
    onProgress?: (p: DownloadProgress) => void;
    timeoutMs?: number;
    retries?: number;
}): Promise<{
    bytes: number;
}>;
/**
 * 拉取一段小文本（用于 FOTA 清单）。有大小上限：拿到的要是别的东西
 * （比如一个 HTML 错误页），宁可直接失败，也不要拿它去解析。
 */
export declare function fetchText(url: string, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<string>;
