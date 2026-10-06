/**
 * 校验值计算。
 *
 * 流式计算是硬要求：安装包最大 60MB，一次性 `readFileSync` 会在 DSH 主进程里
 * 多出 60MB 常驻内存，而这正好发生在用户点"安装"、桌面最需要响应的时候。
 */
/** 小写 hex 的 sha256（流式）。 */
export declare function sha256File(file: string): Promise<string>;
/** 小写 hex 的 md5（流式）。FOTA 渠道只提供 md5。 */
export declare function md5File(file: string): Promise<string>;
/**
 * 给人看的一句话说明"这次装包会被怎么校验"。
 *
 * sha256 优先：它来自发布侧的 `.sha256` sidecar 或清单生成时的实算；
 * md5 只出现在 FOTA 渠道（`fota.json` 里就一个 md5 字段），抗碰撞能力弱，
 * 所以只在完全没有 sha256 时使用。
 */
export declare function describeVerification(expectedSha256: string | null, expectedMd5: string | null): string;
