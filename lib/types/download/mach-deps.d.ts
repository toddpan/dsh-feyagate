/**
 * 装完二进制之后的最后一道静态检查：`otool -L` 读出 Mach-O 主程序声明的
 * `@executable_path` / `@loader_path` 依赖，逐一确认文件真的随包解压出来了。
 *
 * 上游 v1.2.20 的 mac-arm64 zip 一度只打包了 9 个动态库里的 1 个，dyld 在健康
 * 检查之前就 SIGABRT，用户看到的是一句 exit code 加一段汇编味的报错。这道检查
 * 让同类事故在启动之前就变成一句人话：「发布包缺少 lib/xxx.dylib」。它放在切
 * 版本之前：缺失时抛错走安装失败路径，正在运行的旧版本原样保留。
 *
 * 只在 darwin 上执行（otool 属于 macOS 工具链）；otool 不在（未装 Xcode CLT）
 * 时记一条日志就跳过——预检是加固，不能反过来变成新环境的启动门槛。Windows
 * 的 PE 依赖是另一套工具链（dumpbin），不在这里覆盖。
 */
/** 布局参数能用到的最小日志面；调用方传插件的 LogBuffer 即可。 */
export interface MachODepsLog {
    warn(text: string): void;
}
export interface MachODepsCheck {
    /** 实际核对的声明数；0 表示没检查（非 darwin 平台或 otool 不可用）。 */
    checked: number;
}
/**
 * 校验 `<versionDir>/<binary>` 声明的每个随包动态库都真实存在，缺了就抛出一句
 * 可直接展示给用户的错误。返回核对的声明数，调用方可据此记一条通过日志。
 */
export declare function verifyMachODeps(versionDir: string, binary: string, platform: string, log?: MachODepsLog): Promise<MachODepsCheck>;
