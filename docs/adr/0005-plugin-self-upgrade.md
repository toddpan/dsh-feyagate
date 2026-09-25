# ADR-0005：插件自身升级复用 `dsh plugin` + 宿主重启；MVP 只做提示

> **这个文件解决什么问题**：回答"插件自己怎么升级"，以及为什么 MVP 不做一键升级、为什么不能热替换。

- **Status**：Accepted
- **Date**：2026-09-25
- **相关**：[ADR-0004](0004-binary-upgrade.md)（升级的是后台服务，本 ADR 升级的是插件自身）、[`../../../../docs/DSH-插件机制研究报告.md`](../../../../docs/DSH-插件机制研究报告.md) §7

---

## Context

DSH **没有为插件提供任何自更新 API**：没有宿主侧 updater 服务、没有 update manifest、没有版本检查端点、没有"下载到插件目录并重载"的框架能力。检索全部 `*.d.ts` 里 `checkForUpdate|updateAvailable|autoUpdate|updater`，唯一命中是 `@deepseek-ai/dsh-client-ui-settings-general` 里的 `DesktopUpdatePresentation` / `DesktopUpdateBridge` —— 那是 **Electron 桌面应用自身**的更新 UI，其类型注释明确写着 "Optional carrier API; it cannot select artifacts or authorize installation."，与插件无关。

现存的、能拼出"升级"的三块能力：

| 能力 | 说明 | 证据 |
|---|---|---|
| 装包（走网络） | `plugin_manager.install_bundle` / `dsh plugin add` 通过 pnpm 从 registry/git/path 拉取；live profile 立即应用 | `$DSH/dsh-plugin-manager/lib/types/tools.js:69-76` |
| 配置热更 | HMR 监视 profile manifest 与用户 patch 文件，重读 bundle 层并重合成 | `$DSH/dsh-hmr/README.md:27` |
| 前端 bundle 热更 | SSE `/plugins/events` 推 `rebuilt`，页面内替换插件 bundle（不刷新页面） | `$DSH/dsh-client-hmr/README.md:31-40` |

**硬限制**（两处原文）：

- `$DSH/dsh-hmr/README.md:88-89`：*"Module replacement requires Node loader internals... **Replacing installed package versions still requires a restart through Plugin Manager.**"*
- `$DSH/dsh-plugin-manager/README.md:130`（Known Limitations）：*"**Package replacements require restarting the process to load a fresh JavaScript module generation.**"*

即：**配置层可以热更，JS 代码换代必须重启进程。**

## Decision

**插件的自身升级走官方 CLI，不做热替换；MVP 只做"检测到新版本 + 提示 + 给可复制的升级命令"。**

### 1. MVP 的实际行为

- 检测：比对 npm registry 上的最新版本与本地 `package.json` 的 `version`（检测失败静默，只在服务 › 升级与版本页留一行"上次检查失败 · 重试"）。
- 提示：常驻服务状态条的按钮文案变化（`检查更新` → `发现 0.2.0`）+ 升级页卡片。**补丁级不弹窗**（打扰度分级见 UX 文档 §6.2）。
- 给出**可复制的命令**，由用户自己执行：

```bash
dsh plugin --profile <profile> add @dsh-external/dsh-feyagate-gateway@<version>
# 或（pnpm 原生子命令，被原样转发）
dsh plugin --profile <profile> update @dsh-external/dsh-feyagate-gateway
```

- 明确告知**必须重启 DSH 进程**才生效；Desktop shell 下把这件事交给 shell。
- 界面上区分两件事，措辞不能混：**后台服务的升级**（本插件能做，秒级，可回滚）与**插件自身的升级**（本插件不做，需要重启 DSH）。

### 2. 二期（一键升级）的形态与前置条件

形态是"暴露一个动作给 `plugin_manager.install_bundle`"，而不是"插件自己 fetch 新版本并写盘"：

- `plugin_manager.install_bundle` 自带审批门禁、注册表回退链、失败回滚、bundle 重新选择；
- 该操作要求 `danger-full-access` 或**本次调用批准**，在 Desktop shell 下应由 shell 接管；
- 完成后仍需**宿主重启**才算换代码。

技术上传言式的替代做法（插件 Host 代码自己 `fetch` 新版本、写进 profile 的 `node_modules`）被明确否决，理由见 Alternatives。

### 3. 与"后台服务升级"的隔离

两个升级路径**完全独立**：

| | 后台服务（`miloco-mcp-server`） | 插件自身（`@dsh-external/dsh-feyagate-gateway`） |
|---|---|---|
| 谁执行 | 插件的 Host 代码 | 用户 / DSH CLI |
| 需要重启 DSH？ | ❌ 不需要 | ✅ 必须 |
| 会不会中断工具 | 短暂（门面返回空表，见 [ADR-0001](0001-mcp-integration.md)） | 会（进程重启期间工具不存在） |
| 失败回滚 | 自动（`pending` 握手） | 由 pnpm/DSH 的注册表回退处理 |
| MVP 形态 | 完整实现 | 只检测 + 提示 |

## Consequences

**得到：**

- 不与框架对抗：升级路径就是框架提供的那一条，pnpm 锁、兼容性检查、失败回滚都由框架负责。
- 用户清楚"点这个要重启 DSH"，不会期待"点完立刻生效"。
- 插件不需要在用户机器上写 `node_modules`，不会破坏 pnpm 的锁文件。

**付出：**

- MVP 的升级体验是"手动复制一条命令 + 重启"，比一键升级差；这是**有意的取舍**（见下）。
- 需要自己实现"检测新版本"（读 registry），并在失败时静默降级。
- 版本号有两处要同步（`package.json` 的 `version` 与代码里可能出现的展示版本），需要约定单一事实源（`package.json`）。

## Alternatives

### 插件自己 fetch 新包并热替换

- **否掉的原因**：① JS 换代必须重启进程，热替换在框架层面不成立（上面两处原文）；② 绕过 pnpm 锁与兼容性检查（`compatibility.json` 的 DSH 版本豁免机制就失效了）；③ 需要写用户的 `node_modules`，与 pnpm 的内容寻址存储冲突。**技术上"能"，工程上不可接受。**

### MVP 直接做一键升级（spawn `dsh plugin update` + 重启宿主）

- **否掉的原因**：① `install_bundle` 需要 `danger-full-access` 或逐次批准，MVP 里让它静默跑违反审批语义；② 重启宿主会打断用户正在进行的会话，必须由用户显式触发而非插件代办；③ Desktop shell 下应由 shell 接管，插件自己 spawn 会与 shell 的策略打架。→ **留给二期**，且二期也要用户点、要审批。

### 只靠 HMR 热更配置层

- **否掉的原因**：HMR 能重合成配置层（bundle 列表、patch 合并），但换不了 JS 代码代际。把它当升级手段会让用户以为升级生效了，实际跑的还是旧代码 —— 比不做更糟。**但 HMR 有它的用处**：改配置后重合成，这一点保留。

### 用 Electron desktop 的更新通道（`DesktopUpdateBridge`）分发插件

- **否掉的原因**：那是桌面应用自身的更新载体，其类型注释明确写了它不能选择产物、不能授权安装（`it cannot select artifacts or authorize installation`）。在非 Desktop 环境（Web/TUI）根本不存在。**不采用。**

## 待确认

- 是否在 MVP 就提供"打开 DSH 插件页"的**文字路标**（不能是跳转按钮：`settings.section` 拿不到 `openSection`）。当前决定：给文字路径 `设置 › 插件`，不给按钮。
- 检测版本的 registry 来源与频率（默认：随"检查更新"按钮与服务状态条的周期检查一起做，不额外增加网络请求）。
