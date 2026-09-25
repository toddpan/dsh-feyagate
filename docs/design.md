# dsh-feyagate-gateway 工程设计

> **这个文件解决什么问题**：把「这个插件长什么样、为什么长这样」一次说清，让一个新接手的工程师**只读这一篇**就能开始改代码 —— 双半侧各干什么、MCP 为什么绕一道门面、安装/升级/回滚的状态机怎么走、`config.yaml` 的每个字段归谁写、安全边界在哪。

**本文与其他文档的关系**（本文自洽可读，不要求你先读它们）：

| 文档 | 它负责什么 | 本文与它的关系 |
|---|---|---|
| [`../../docs/design/feyagate-dsh-plugin-需求与设计确认稿.md`](../../../docs/design/feyagate-dsh-plugin-需求与设计确认稿.md) | 需求复述、范围确认、风险清单、分期 | 本文假定它的结论已确认（独立目录、默认端口、MVP 范围等），不重复论证 |
| [`../../docs/design/feyagate-dsh-plugin-ux.md`](../../../docs/design/feyagate-dsh-plugin-ux.md) | 界面逐屏规格、状态词表、错误文案、验收清单 | 本文只讲**界面背后的机制**；界面长什么样看 UX 文档 |
| [`../../docs/DSH-插件机制研究报告.md`](../../../docs/DSH-插件机制研究报告.md) | DSH 插件机制的实证结论（每条带文件:行号） | 本文引用它的结论时只给结论，出处看那份报告 |
| [`../adr/`](adr) | 7 条已定决策与**被否方案的理由** | 本文给全貌，ADR 给单点的取舍细节 |

---

## 1. 目标与非目标

### 目标（MVP）

1. **让模型能用上 76 个 FeyaGate 工具**（数量与工具名以 `app/feyagate-skill-gh/FeyaGate_MCP_API.md` §4 为准），且工具在"没装后台服务 / 正在升级 / 服务崩了"三种情况下都不会从工具列表里消失。
2. **把二进制运维这件事变成三个按钮**：安装、升级、回滚。底层是真下载、真校验、真守护、真回滚，不是按钮动画。
3. **给出可核验的证据**：真实版本号、真实校验和、真实端口、真实日志、真实 PID。
4. **不移动用户已有的身份**：许可证与 `device_id` 锚定在固定目录，插件只往里写，从不迁移。

### 非目标（MVP 明确不做）

- **不做多端点管理**：只管本机托管的那一个后台服务。局域网 ESP32 网关、远端 miloco 属于二期。
- **不做完整平台登录界面**：MVP 的账号页是只读总览，登录动作由模型在对话里调用 `auth/*` / `xiaomi/auth_*` 工具完成；图形化登录页二期做。
- **不自研 DRM**：许可证事实源在子进程，插件只呈现与转发。
- **不做插件热替换**：DSH 没有自更新 API，换包版本必须重启宿主进程；MVP 只做"检测 + 提示 + 给可复制的命令"。
- **不在运行期动态增减工具集**：会打断 KV cache 前缀（见 §3.4）。
- **不读写既有的 `~/.feyagate` 安装**：只做只读探测，探测到就给"attach：只连不管"的提示（见 [ADR-0002](adr/0002-install-directory.md)）。
- **不下载/分发小米专有库** `libmiot_camera_lite`（见 §8）。

---

## 2. 双半侧职责边界

插件是一个 **npm 包 + Cordis 插件**，同一个包里两个半侧，通过 `package.json` 的 `exports` 分开：

| 半侧 | 入口 | 运行位置 | 权限 | 能做什么 | 不能做什么 |
|---|---|---|---|---|---|
| **Host** | `exports["."]` → `lib/index.js`（Node ESM，`apply(ctx, config)`） | DSH 宿主进程内 | 宿主用户的**完整权限**，在工作区沙箱**之外** | 读写任意路径、spawn 子进程、自由联网、监听本地端口、注册工具与设置命名空间 | 不能碰 DOM；不能拿浏览器的剪贴板/文件选择器 |
| **浏览器** | `exports["./client"]` → `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 形态的 lazy-CJS） | DSH Web GUI 页面内 | 浏览器权限，只能同源 HTTP | 渲染 `settings.section` 里的三个 tab、调插件自己的同源管理 API | 不能直接读文件、不能 spawn、不能拿到 DSH 宿主的任意能力 |

```
       浏览器半侧（lib/client.js）                      Host 半侧（lib/index.js）
   ┌────────────────────────────────┐          ┌──────────────────────────────────┐
   │ settings.section「飞阳网关」    │  同源    │ 管理 API  /dsh-feyagate/*        │
   │  [服务] [账号] [授权]           │ ───────► │  state.json（唯一可变账本）       │
   │ 常驻服务状态条（10s 轮询）      │  HTTP    │  安装 / 校验 / 解压 / 切 current  │
   │ 进度来自 Host（切页不丢）       │ ◄─────── │  spawn / 健康轮询 / 退避 / 熔断   │
   └────────────────────────────────┘          │  config.yaml 唯一写者             │
                                               │  常驻 MCP 门面 :38081             │
                                               └──────────────────────────────────┘
```

三条硬约束（来自 DSH 契约，不是选择）：

1. **浏览器半侧必须是 lazy-CJS**，构建产出固定叫 `lib/client.js`，否则启动报错。[`tsdown.config.ts`](../tsdown.config.ts) 用 banner/footer 把 `window.__ModuleLoader__.load(...)` 包在产物外层。
2. **UI 没有"贡献点"**：界面靠本插件的 `cordis.patch.yml` 把插件行插进 profile，前端在 `apply(ctx)` 时**运行时**注册插槽。设置界面只有一条路能表达层级：注册**一个** `settings.section`，内部自建二级导航 —— 因为 DSH 的设置导航是**扁平列表**，多注册只会得到多个相同齿轮图标。
3. **跨页跳转能力拿不到**：`settings.section` 注册方只收到 `close()`。所以界面里"去插件配置"/"去授权页"只能是**文本路标**，不能是按钮。

**为什么进度状态放 Host 侧**：用户在下载中途切走 tab、甚至关掉设置面板再回来，看到的必须是**当前真实进度**，或者诚实的"任务已丢失，请重新开始"。进度放在组件 state 里，切页即丢，只能假装"还在跑" —— 这是设计上明确禁止的。

---

## 3. MCP 接入方案选型

### 3.1 四个候选

| 方案 | 形态 | 结论 |
|---|---|---|
| **A** | 静态桥行：插件 patch 插一行官方 `dsh-mcp-client`，`url` 直接指向子进程端口 | 被 A′ 取代 |
| **A′** | **插件自建常驻 MCP 门面**（固定端口，恒答 `initialize`），桥指向门面；子进程未装/未起 → 返回空工具表；就绪后代理过去 | **采用**（已落在 [`cordis.patch.yml`](../cordis.patch.yml)） |
| **B** | 插件自己 spawn，用 MCP client 库 + `createMcpToolDefinition` 自建桥 | 兜底，触发条件见 §3.5 |
| **C** | 插件在运行期改写 profile roster 把端口写进去 | **拒绝** |

**C 被拒绝的理由**：`dsh plugin` 命令本身就在写同一份 patch，插件运行期再去改 = 同一份 patch 出现**双写者**，用户下次装/卸/升任何插件都可能把运行期写入覆盖掉。这类"看起来能跑、装第二个插件就坏"的方案不进入选型。

### 3.2 三个真实约束

这三条是选型的全部依据：

1. **静态 YAML 里的端口**。`cordis.patch.yml` 是 boot 时求值的静态文本。子进程的 HTTP 端口必须可配置、还会在占用时漂移，而 patch 里的 `url` 在写文件时就得是确定的字符串。→ 直接指向子进程（方案 A）意味着**改端口必须改文件 + 重启 DSH**，而漂移端口更是无从表达。
2. **桥的重连预算**。`dsh-mcp-client` 首次连接失败不阻塞启动，但按 `500ms → ×2 → 30s` 退避重连；默认 `maxAttempts: 10`，**连续 10 次失败后移除该 server 的工具并停止重连**（约 2.5 分钟）。用户在 boot 之后才点"安装"（下载 20–30 MB），预算早就烧完了 —— 表现就是"装了但工具永远不出现"，用户会认为插件坏了。
   本仓库的 patch 把 `maxAttempts` 显式抬到 `60`，把预算拉长到约 30 分钟；但这只是**缓冲**，不是解法：真正的解法是让桥**第一次就连上**一个永远在的东西。
3. **运行期写 roster**。任何"运行期动态增减工具集"的动作都会打断 KV cache 前缀。所以 MVP 不做运行期工具集变更；平台开关这类改动要求**重启子进程/重连**，让工具集在一次会话内保持稳定。

### 3.3 为什么是 A′

门面是一个**插件自己监听的、恒在的小型 MCP server**（默认 `127.0.0.1:38081`）：

| 情形 | 门面对桥的应答 |
|---|---|
| 子进程未安装 | `initialize` 秒回成功；`tools/list` 返回**空表** |
| 子进程已装未起/正在升级 | 同上（空表），并记录原因供界面显示 |
| 子进程健康 | 代理 `tools/list` 与 `tools/call` 到子进程的 `/mcp/http`；子进程就绪后发 `notifications/tools/list_changed` |

三条约束因此同时被满足：

- **端口问题消失**：桥连的永远是门面；子进程端口（含漂移）是纯运行期细节，改端口不需要重启 DSH。
- **预算问题消失**：桥第一次连接就成功（门面在插件 `apply()` 里就起来），"先开 DSH 后装服务"不再烧预算。
- **不动 roster**：patch 只写门面端口，运行期不改任何 YAML。

**门面端口怎么让 patch 知道**（唯一需要"提前知道"的值）：`apply()` 把端口写进 `state.json`，patch 里用 `!!js` 表达式在 boot 时读该文件，读不到就退化为默认 `38081`：

```yaml
url: !!js "(() => { ... read $DSH_HOME/dsh-feyagate/state.json ... })()"
```

> ⚠ **这两条前提尚未经过实测 spike**：① `!!js` 表达式能否读文件；② "入口行按顺序处理、前一行插件的 `apply()` 已被 await" 是否成立（patch 注释如此断言，但本研究未独立验证）。若不成立，退化路径是：**门面端口固定 38081**，"改门面端口需要重启 DSH"写进界面文案。这是设计稿里 R14 的待验证项。

一次升级窗口的时序（对模型零感知）：

```
用户点「升级」
   │
   ├─ 门面：仍在监听，tools/list 暂时返回空表（父进程侧不报错）
   ├─ 插件：停子进程 → 下新版本 → 校验 → 解压到 versions/<new>/ → 切 current
   ├─ 插件：拉新进程 → 轮询 /health → 成功
   └─ 门面：恢复代理 → 发 notifications/tools/list_changed
                                                    │
                                        模型侧：工具集整体换代，会话不中断
```

### 3.4 被这条选型连带确定的约束

- **工具集合整体换代**：桥的实现是"整代替换"，同步失败保留上一代、注册冲突回滚整代，绝不给半个工具集。门面必须遵守同一语义。
- **公开工具名由桥生成**：公开名 = `mcp__<serverName>__<原始名>`，`serverName` 是 `feyagate`；原始名里有 `/`（如 `device/list`），需经函数名规范化（有损时追加 12 位 sha256）。**文档里写的名字是形状示意，以运行时 `tools/list` 为准。**
- **工具调用超时抬高**：patch 把 `toolCallTimeoutMs` 设为 `180000`（默认 60000）。摄像头/视觉类调用合法地要几分钟（P2P 连接 + 抓拍 + VLM 往返），默认 60 秒会把正常调用掐断。
- **不重复注册**：同一 `serverName` 出现两个入口时后者加载失败，所以 patch 里 `feyagate-gateway-mcp` 的 id 必须稳定且唯一。

### 3.5 什么时候必须换成方案 B

方案 B（插件自建桥）不是"更高级的版本"，而是**A′ 失效时的兜底**。触发条件，任一成立即必须换：

1. 官方桥**不再支持 `streamable-http`**，或桥的传输实现变了导致门面无法被连上。
2. 桥的**重连/换代语义**变成"失败即关闭"或"半代工具集"，使得门面"先空表后补齐"的时序无法表达。
3. 需要对工具做**桥不支持的处理**：例如按平台动态隐藏工具、对 `tools/call` 做参数改写或结果投影、把多个 MCP server 聚合成一个命名空间。
4. 需要 `stdio` 之外的会话级能力（采样、roots、进度通知）而桥不转发。

换 B 的代价要提前知道：需要自己实现命名规范化（含 sha256 冲突处理）、`tools/list` 换代与失败回滚、图片结果的会话投影、调用超时与取消。**所以能留在 A′ 就不要动。**

---

## 4. 目录与文件职责表

### 4.1 包根

| 路径 | 职责 | 谁读它 |
|---|---|---|
| `package.json` | 双半侧 `exports`、`dsh.bundle.patch`、`dsh.client.inject`、`peerDependencies`、engines | DSH boot（读 `dsh.*`）与 pnpm |
| `cordis.patch.yml` | 插入**两行**：`feyagate-gateway`（本体）+ `feyagate-gateway-mcp`（官方桥，`serverName: feyagate`，含 `!!js` 端口表达式） | DSH boot |
| `tsconfig.json` | Host 半侧 tsc：`src/` → `lib/` + `lib/types/` | 构建 |
| `tsdown.config.ts` | 浏览器半侧打包：lazy-CJS banner/footer、外部化白名单、`lib/client.js` | 构建 |
| `manifest/server-manifest.json` | **权威清单**：逐平台真实文件名 + sha256 + 版本 + 兼容区间 + 默认通道 | Host 半侧（下载前） |
| `skills/feyagate-gateway/SKILL.md` | 随插件分发的模型技能文档（参数命名陷阱、推荐调用顺序） | DSH 技能加载 |
| `LICENSE` / `NOTICE` | MIT / 合规口径 | 人 |

### 4.2 `src/`（Host 半侧）

| 文件 | 职责 | 已落地 |
|---|---|---|
| `constants.ts` | 所有可能需要改的常量（端口、退避、超时、路径、协议路径）集中一处；**禁止在别处再写字符串字面量** | ✅ |
| `types.ts` | 契约层：`ServerManifest`/`ManifestAsset`、`PersistedState`、`RuntimeStatus`、`JobSnapshot`、`ApiEnvelope`、`ServerInfo`/`LicenseInfo` | ✅ |
| `paths.ts` | 落盘布局、`current` 指针读写、已安装版本枚举、`ensureLayout` | ✅ |
| `state.ts` | `state.json` 原子写、字段归一化（手改/旧版本也能安全读）、**`pending` 握手**、指针兜底 | ✅ |
| `log.ts` | 环形日志缓冲（界面 + 文件同一份），单行截断 4000 字符 | ✅ |
| `util/atomic.ts` | tmp + rename 原子写；JSON 容错读 | ✅ |
| `util/platform.ts` | `PlatformTag` 映射、二进制名、版本解析/比较、macOS 判定 | ✅ |
| `index.ts` | 插件入口：Config schema、`apply()`、装配、`ctx.effect` 清理 | ✅ |
| `manifest.ts` | 清单解析、按平台解析"装哪个资产"、兼容区间判定、FOTA 兜底条目解析 | ✅ |
| `download/sources.ts` | 多源降级链：GitHub Releases → FOTA（未配置的平台跳过）→ 镜像前缀 → 本地包；每一环产出"计划"或"跳过原因" | ✅ |
| `download/fetch.ts` | 带进度与取消的下载（重定向跟随、重试、超时） | ✅ |
| `download/verify.ts` | 流式 sha256（优先）/ md5（FOTA）；`describeVerification()` 产出给人看的一句话 | ✅ |
| `download/extract.ts` | zip / tar.gz / 裸 exe 解压，单层目录拍平，chmod 755，macOS 去 quarantine + ad-hoc 重签（先 dylib 后主二进制） | ✅ |
| `install.ts` | 安装/升级/回滚/卸载，全部表达为 job；`pending` 的写入与 boot 时的未确认回滚判断 | ✅ |
| `jobs.ts` | 长任务账本：phase / percent / bytes / attemptedSources / noop | ✅ |
| `supervise/process.ts` | spawn、PID 文件、孤儿与多实例清理、优雅停止（SIGTERM → 5s → SIGKILL）、崩溃退避与熔断 | ✅ |
| `supervise/health.ts` | 就绪探测（40 × 500ms）、`/health` 轮询、空闲端口探测（`findFreePort`，门面与子进程共用） | ✅ |
| `runtime.ts` | 把 supervisor / jobs / 平台判定收敛成 `RuntimeStatus.state`（含"平台不受支持"与 boot 失败两类 error） | ✅ |
| `mcp/facade.ts` | 常驻门面：恒答 `initialize`、空表降级、代理转发、`list_changed`；端口写进 `state.json` 后才算就绪 | ✅ |
| `config-gen.ts` | **`config.yaml` 唯一写者**：`MANAGED_FIELDS`（每次覆盖）/ `SEED_ONLY_FIELDS`（只在缺失时写入）/ 读回合并 | ✅ |
| `settings.ts` | 插件参数（`PluginSettings`：端口、绑定地址、云区域、自启、镜像、本地包、允许未校验）读写与校验 | ✅ |
| `launcher.ts` | 子进程命令行（`--config <root>/config.yaml`）与工作目录推导 | ✅ |
| `child-api.ts` | 子进程 REST（`/api/v1/gateway/*`）与 MCP（`POST /mcp/http`）调用封装 | ✅ |
| `api.ts` | 同源管理 API `/dsh-feyagate/*`：路由、信封、**写操作校验 Origin** | ✅ |
| `client/index.tsx` | 浏览器半侧：唯一 `settings.section` + 三 tab + 状态条（React） | ✅ |
| `client/contract.ts` | Host ↔ 浏览器半侧共享的类型契约 | ✅ |
| `download/index.ts` | 下载子模块统一出口 | ✅ |

> 与最初计划的差异（实现落地后校正）：崩溃退避/熔断落在 `supervise/process.ts`（参数仍来自 `constants.ts` 的 `RESTART_BACKOFF_MS` / `CRASH_WINDOW_MS` / `MAX_CRASHES_PER_WINDOW`），没有单独的 `supervise/restart.ts`；管理 API 的文件叫 `api.ts` 而不是 `http-api.ts`；没有单独的 `license.ts` —— 授权相关调用在 `child-api.ts` + `api.ts` 里，因为插件**只呈现与转发**，不自研 DRM。

### 4.3 脚本与文档

| 路径 | 职责 |
|---|---|
| `scripts/gen-manifest.mjs` | ✅ 重新生成权威清单（`--tag`、`--compute-missing`） |
| `scripts/build.sh` | ✅ tsc（含 `.d.ts` → `lib/types/`）+ tsdown |
| `scripts/verify-manifest.mjs` | ✅ CI 校验清单自洽 |
| `scripts/smoke.mjs` | ✅ 端到端冒烟（真下载 / 真校验 / 真解压 / 真启动） |
| `docs/design.md` | 本文 |
| `docs/user-guide.zh.md` | 面向最终用户的操作手册 |
| `docs/adr/0001…0008` | 8 条决策记录 |
| `docs/verify-mcp-inputschema-fix.md` | 验证记录：上游 `inputSchema` 不合规导致桥丢掉全部工具（已修 + 真机复验） |
| `docs/verify-tuya-auth-flow.md` | 验证记录：涂鸦授权在 DSH 聊天里走完全流程（门面适配工具结果 + 插件出图 + 服务端长轮询） |

---

## 5. 状态机

### 5.1 服务状态（界面状态条的取值来源）

`RuntimeStatus.state`（[`src/types.ts`](../src/types.ts)）与 UX 状态词一一对应：

```
                      ┌──────────────┐
       首次          │ not-installed│◄─────────── 解压失败/回滚失败且无可用版本
        │            └──────┬───────┘
        │                   │ 用户点「安装后台服务」
        │                   ▼
        │            ┌──────────────┐  下载 → 校验 → 解压 → 写权限
        │            │  installing  │  （JobSnapshot.phase 驱动界面五阶段条）
        │            └──────┬───────┘
        │                   │ 切 current 指针
        │                   ▼
        │            ┌──────────────┐  进程已起，/health 未通过（40×500ms）
        │            │   starting   │──────────────┐
        │            └──────┬───────┘              │ 超时/退出
        │                   │ /health 2xx          ▼
        │                   ▼               ┌──────────────┐
        │            ┌──────────────┐       │    error     │ ← 崩溃熔断 / 端口冲突
        │            │   running    │       └──────┬───────┘
        │            └───┬──────┬───┘              │ 重启 / 重新安装
        │                │      │ 子系统不可用      │
        │  用户停服务    │      ▼                  ▼
        │                │  ┌──────────────┐   ┌──────────────┐
        └───────────────►│  │   degraded   │   │   updating   │（见 5.2）
                         │  └──────────────┘   └──────────────┘
                         ▼
                  ┌──────────────┐
                  │   stopped    │
                  └──────────────┘
```

- **`degraded` 不是错误**：主进程健康但子系统不可用 —— 华为命令通道未建立（缺 `libmosquitto`）、摄像头子系统不可用（Windows 或缺小米专有库）、Vision 未配 Key。界面上是 warn 色 + "查看原因"，**禁止红屏**。
- **`error` 必须给三出口**：查看日志 / 重启 / 重新安装。不得只显示"启动失败"。
- 状态词、色值、图标、允许动作的完整表在 UX 文档 §5.1；本文只保证 `RuntimeStatus` 能表达它。

### 5.2 安装 / 升级状态机与 `pending` 握手

核心不变式：**新版本在被证明健康之前，绝不被当作可信版本；被证明健康之前如果进程死了，下次启动必须回滚。**

```
安装或升级到 vX：
  1. 停子进程（SIGTERM → 5s → SIGKILL）
  2. 解析资产（manifest）→ 下载 → 校验 → 解压到 versions/vX/   ← 不可变目录，失败则删掉整个目录
  3. state.markPending(vX)        ← ★ 落盘："我正要起一个还没证明过自己的版本"
  4. 切 current 指针 → versions/vX
  5. 拉进程 → 轮询 /health
       ├─ 成功 → state.confirmHealthy(vX)
       │           = currentVersion=vX、lastKnownGood=旧版本、pending=null
       └─ 失败 → 停进程 → 回滚到 lastKnownGood（切回 current 指针）→ 拉起旧版本 → 界面常驻橙条
  ────────────────────────────────────────────────────────────────────────────
  下次 DSH boot：
     读 state.json；若 pending != null（说明上次激活没走完 confirm）
       → 不信任 current，直接回滚到 lastKnownGood 并如实告知
```

这一套是针对三种真实故障设计的：

| 故障 | 被哪一步挡住 |
|---|---|
| 升级中途断电/杀进程 | `pending` 在下次 boot 未确认 → 自动回滚 |
| 新版本能解压但起不来（依赖缺失、ABI 变化） | 第 5 步健康检查失败 → 回滚到 `lastKnownGood` |
| 新版本起来了但 5 分钟后崩 | 守护的崩溃退避 + 熔断；`lastKnownGood` 仍是旧版本，界面给「回滚到此版本」 |

其余规则：

- `versions/<version>/` **不可变**：装新版本从不覆盖旧目录，回滚因此是"切指针"级操作。
- `current` 是**文件不是软链接**（Windows 上软链接需要特权）。
- 指针是**兜底事实源**：激活时最后写它，启动时若指针与 `state.json` 不一致，**信指针**。
- 失败后 **24 小时内不自动重试**升级（避免失败循环）。
- **版本探测的硬约束**：子进程没有 `--version`/`--validate`，`/health` 也不含版本。版本只能来自**安装时自己写的版本戳**，辅以启动日志行交叉校验；读不到就在界面上写 `未知（版本戳缺失，建议重新安装）`，**不要猜**。

### 5.3 崩溃重启状态机

```
进程退出（非用户停止）
   │
   ├─ 记 restarts++
   ├─ 60 秒窗口内崩溃次数 > 5 ？ ──是──► circuitOpen=true，停止自动重启
   │                                     状态 error + 界面写明"已连续崩溃 N 次，已停止自动重启"
   └─ 否 → 按退避表等一等再拉起：1000 → 2000 → 5000 → 10000 → 20000 → 30000 ms（封顶）
              │
              └─ /health 通过 → 清零退避步进，回到 running
```

- 用户**显式停止**不会触发重启（要区分"退出原因"）。
- 崩溃必须留痕：Hero 内联 + 页面顶部常驻橙条 + 最后一条日志行（含退出码）。**禁止用会消失的 toast 承载崩溃。**

### 5.4 长任务（`JobSnapshot`）

`JobKind = install | upgrade | rollback | repair | uninstall`，`JobPhase = queued → resolving → downloading → verifying → extracting → activating → starting → confirming → done | failed | cancelled`。

- `percent: null` 表示总量未知，界面用不确定进度条 —— **不许假百分比**。
- `attemptedSources[]` 记录已经试过的下载源，失败时展示（用户据此判断"是不是只有 GitHub 不通"）。
- `noop` 表示任务结束但**没有留下任何变更**（不需要清理）。
- 任务的真相在 Host 侧：关面板不取消任务；重开面板按 Host 状态渲染"进行中 / 已完成 / 已丢失"三态。

---

## 6. `config.yaml` 字段归属表

**前提**：插件是 `config.yaml` 的**唯一写者**，把它标记为生成物。子进程会用 `YAML::LoadFile` → 改节点 → **整文件重写**（`src/config.cpp` 的 `save_*` 系列），所以：

1. **注释与排版会在子进程第一次回写时丢失** → 文件必须以机器可读为准，界面与文档都说"不要手改"（[`src/config-gen.ts`](../src/config-gen.ts) 写的那三行注释就是给"人"看的，不是持久标记）。
2. 子进程重写的是**整棵 YAML 树**（它不认识的键会被原样保留），所以插件拥有的字段不会被子进程吃掉。
3. **子进程运行期间插件不改写 `config.yaml`**：两边都是"读-改-写整文件"，同时写就是最后写者胜。需要改端口/绑定地址时：**先停服务，再改，再起服务**。

归属不是靠文档约定，而是靠代码里的**两个名单**（[`src/config-gen.ts`](../src/config-gen.ts) 的 `MANAGED_FIELDS` 与 `SEED_ONLY_FIELDS`），所以下表以代码为准：

| 分类 | 字段 | 行为 |
|---|---|---|
**为什么 `webui_dir` 必须被改写**：发布包把 `webui/` 放在**版本目录**里（真实 mac-arm64 v1.2.20 包顶层是 `config.yaml` / `lib/` / `README.txt` / `webui/` / `miloco-mcp-server`，没有顶层目录），而子进程解析该字段时以**安装根目录**为基准。保持上游默认的 `webui` 会让 `set_mount_point` 失败，子进程只打一行 `WebUI directory not found (web UI disabled)` —— 一个功能静默消失。改成绝对路径并在每次启动时重指，既让它真的可用，也避免升级后仍挂着旧版本的资源。版本目录里没有 `webui/` 时不写（免得留下悬空绝对路径）。

| **`MANAGED_FIELDS`（每次都覆盖）** | `server.http_port`、`server.bind_address`、`server.webui_dir`、`server.ws_port`、`auth.token_file`、`tuya.token_file`、`midea.token_file`、`ewelink.token_file`、`huawei.token_file`、`memory.data_dir`、`skill.user_dir`、`skill.builtin_dir` | 每次生成都按插件的当前意图写入，反映真实启动参数 |
| **`SEED_ONLY_FIELDS`（只在缺失时写入）** | `camera.*`（6 项）、`auth.cloud_server`、`xiaozhi.reconnect_interval_ms`、`vision.enabled` / `base_url` / `model`、`trigger.enabled`、`memory.enabled`、`skill.enabled` | **升级不会把用户改过的值改回去**，这是"升级安全"的关键 |
| **子进程拥有并会回写** | `xiaozhi.endpoint` / `xiaozhi.endpoints`（`save_xiaozhi_endpoint(s)`，回写时把第一个端点同步进 `endpoint` 做兼容）、`vision.*` 的其余键（`save_vision_config`）、`trigger.*` 的其余键（`save_trigger_config`） | 插件只读回显示，**不覆盖** |
| **插件直接写入但不进名单** | `license.license_file`（`data/license.json`）、各 `*_token_file` 的具体值（`data/<platform>_token.json`） | 路径必须相对根目录保持稳定 |
| **不生成、不触碰** | `license.server_url` / `license.product`、`huawei.device_id` / `device_name`、`xiaozhi.server_name` / `server_version` | 子进程按自己的默认值或自身逻辑处理。**`huawei.device_id` 由谁写尚未核实**（源码里没有对应 `save_*`），不要想当然 |

生成物的默认值（`generateConfig`）：`http_port = 38080`（或漂移后的实际端口）、`bind_address = 127.0.0.1`、`webui_dir = webui`（**启动前会被 `applyWebuiDir()` 改写成 `<root>/versions/<当前版本>/webui` 的绝对路径**，原因见下）、`ws_port = 8765`、`cloud_server = cn`、`vision.enabled = false`、`trigger.enabled = false`、`memory.enabled = true`、`skill.enabled = true`，以及 `data/...` 相对路径。文件以 `0600` 写入 —— 用户配好 Vision 之后，这里就有 API Key。

**读回合并策略**（`config-gen` 的契约）：

1. 生成时**只补自己的字段**，其余键（包括来自更新版本、插件从没听说过的键）原样保留。
2. 需要显示子进程回写过的字段（小智端点、Vision、触发规则）时**读回**，以读到的值为准显示，**不覆盖写回**。
3. 界面要改一个插件拥有的字段时：读当前文件 → 只替换该字段 → 整文件原子写（tmp + rename）→ 重启服务生效。
4. **绝不"用模板整体覆盖"**一个已经运行过的 `config.yaml`：那会抹掉用户的 xiaozhi/vision/trigger 配置。
5. 文件**存在但解析不了**时：抛错并提示"备份并删除它，插件会重新生成"，**不静默按默认值覆盖**（否则用户能从"服务起不来"变成"配置没了"）。
6. `server.http_port` 在**启动这一轮**可能被单点改写（`applyEffectivePort`）：期望端口留在 `state.json`，文件反映本次真实的绑定端口。

> **布局不变式（已由实现定案）**：`config.yaml` **放在安装根目录**（`<root>/config.yaml`），`data/` 是它的兄弟目录。原因见 [`src/paths.ts`](../src/paths.ts) 的文件头注释 —— 子进程把所有相对路径按 `config.yaml` 所在目录展开，并把它当作设备身份与授权的锚点；放进 `config/` 子目录会让 `data/` 变成 `config/data/`、挪走 `license.json`，用户升级一次就会领到一份新的免费试用。这是 [ADR-0003](adr/0003-generated-config.md) 拍板的 ② 方案。

---

## 7. 安全与完整性策略

### 7.1 下载与安装

- **权威清单**：不做"版本 + 平台 → 拼文件名"。清单记录**真实存在过的文件名**，因为上游命名逐版本漂移（v1.2.20 的 mac-x64 只有 tar.gz、完全没发 Windows；v1.2.19 的 Windows 叫 `miloco-mcp-server-1.2.19-windows-x64.zip` 且还有一个裸 `miloco-mcp-server.exe`）。
- **多源降级，按序尝试**：GitHub Releases → FOTA（`oneapi.sooncore.com/ota/fota.json`，自带 md5）→ 可配置镜像前缀 → **本地包**（离线安装路径）。已试过的源记进 `JobSnapshot.attemptedSources[]`。
- **先校验后解压，顺序不可交换**：校验失败 → **删除已下载文件** → 中止。绝不"先解开再删"。
- **无校验值 = 必须用户显式确认**：清单里 `sha256: null` 的资产（没有 `.sha256` sidecar 且未被 `--compute-missing` 补过）不允许静默安装。
- **FOTA 只能当兜底**：它缺 mac-arm64/linux-arm64 条目，且各平台版本错位（1.2.19 / 1.2.20 / 1.2.17），所以不能当权威版本源。
- **落盘前清空目标版本目录**：解压中断/失败 → 清掉整个 `versions/<ver>/`，回到"未安装"，**绝不留下半套二进制**。
- **macOS**：去 `com.apple.quarantine` + ad-hoc 重签；失败时给出可复制的命令与"MDM 机器无法绕过"的诚实边界。

### 7.2 运行期

- **默认只绑 loopback**。要开局域网必须显式开启，且界面同时给出"本地接口不校验身份"的警告。
- **管理 API 同源 + Origin 校验**，前缀 `/dsh-feyagate/*`。非本机浏览器（远程部署）打开时：所有写操作禁用并说明原因。
- **业务凭据留在子进程的 `data/` 且 `0600`**。DSH 的 `credentials` 只用于**插件自己**的外部服务凭据 —— 不拿它存平台 token。
- **诊断信息脱敏**：技术细节层与诊断包都不含账号、密码、令牌与摄像头画面；日志里的本机用户名替换为 `~`。
- **插件无权限声明机制**（DSH 事实）：Host 代码以用户完整权限在宿主进程内运行。本插件的自我约束是：只写自己的安装根目录、只 spawn 自己下载的二进制、只访问清单与下载源里写明的地址。

### 7.3 子进程能力降级（不静默失败）

| 缺失项 | 表现 | 插件如何呈现 |
|---|---|---|
| 小米专有库 `libmiot_camera_lite` | 摄像头不可用，其它平台正常 | **降级运行 + 原因**，不假装功能存在、也不整体报错 |
| `libmosquitto`（Linux/macOS） | 华为命令通道建立不了 → 华为设备"能看不能控" | 降级 + 原因 + 修复命令（`brew install mosquitto`，装完需重启服务） |
| 上游产物无 `skills/` | 内置技能不可用 | 默认 `skill.builtin_dir` 留空，界面说明"内置技能不可用" |
| 平台不支持摄像头（Windows） | 摄像头功能整体不可用 | 明确写"当前平台暂不支持摄像头功能"+ 平台支持表 |

---

## 8. 开源边界

| 类别 | 决定 |
|---|---|
| 插件源码、`config.yaml` 模板、清单、ADR/文档、构建脚本 | ✅ 全部开源（MIT） |
| `LICENSE` + `NOTICE` | ✅ NOTICE 写明：本仓库**不含**任何二进制；二进制版权归权利人；小米专有库**永不**随包分发/下载 |
| 二进制本体（zip / tar.gz / 裸 exe / pkg） | ❌ **不进仓库、不打进 npm 包**；改为"清单 + 多源下载" |
| 二进制镜像分发 | ⚠ 只能在**权利人自己的渠道**；社区 fork 必须指向自己的渠道，不得以本项目名义发镜像 |
| 既有 `~/.feyagate` 安装 | ❌ 默认不读不写，仅只读探测 + attach 提示 |

**两处诚实的未知**（写进 NOTICE，不当成结论）：

1. `miloco-mcp-server` 源码树带 MIT 许可证文件，README 又写明摄像头原生库是小米专有 —— **"闭源"是分发策略，不是许可证结论**。发布产物的实际授权口径由权利人决定。
2. 其自述基于 Xiaomi Miloco 项目，**上游血统的许可证未在本项目内审计**；Linux 产物是动态链接（`libssl3` / `libyaml-cpp0.7` / `libfmt8` / `libavcodec58` 等），若捆绑 LGPL 组件，再分发义务属于发布产物的人。

详见 [ADR-0007](adr/0007-open-source-boundary.md)。

---

## 9. 未决与待验证

| # | 事项 | 状态 | 处置 |
|---|---|---|---|
| 1 | `!!js` 能否读 `state.json`、入口行是否按序且 `apply()` 已 await | **待验证** | 15 分钟 spike，见 §3.3 与 [ADR-0001](adr/0001-mcp-integration.md)。不成立则门面端口固定 38081 并把"改它要重启 DSH"写进文案 |
| 2 | `<root>/data` 与 `<root>/config/data` 的双目录问题 | **已定案** | 取 ② 方案：`config.yaml` 放在安装根目录，`data/` 是它的兄弟。见 §6 与 [ADR-0003](adr/0003-generated-config.md) |
| 3 | `server.ws_port` 归属与常量 | **已定案** | `DEFAULT_WS_PORT`（`constants.ts`）→ `config-gen.ts` 引用，符合"端口只写一次"；界面不暴露（插件不跑 WebSocket，MCP 桥走 Streamable HTTP，但子进程要求该字段存在） |
| 4 | `huawei.device_id` / `device_name` 由谁写 | **未核实** | 当前插件不生成。需要核实子进程是否在别处持久化，再决定是否纳入 `MANAGED_FIELDS` |
| 5 | `dsh.client.inject` 与 tsdown 外部化名单不一致 | **待对齐** | 决定浏览器半侧能否加载 `dsh-client-ui-primitives`（前端 baseline 白名单共 9 个模块） |
| 6 | `cordis.patch.yml` 的 `maxAttempts: 60` 与"预算 2.5 分钟"叙述口径 | **已说明** | 见 [ADR-0001](adr/0001-mcp-integration.md) |
| 7 | `src/index.ts`（入口）与 `src/client/index.tsx`（界面）的落地形态 | **已落地** | 入口注入 Config schema、注册 API 与 MCP 门面、用 `ctx.effect` 做清理；界面注册唯一 `settings.section`。发布前仍需真实设备端到端验收 |
