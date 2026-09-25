# dsh-feyagate-gateway

> **这个文件解决什么问题**：让三类读者各自在 3 分钟内找到自己要看的东西 —— 想装的人拿到最短安装路径，想贡献的人拿到开发环境与目录职责，关心合规的人拿到"仓库里到底有什么、没有什么"。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
npm 包名 `@dsh-external/dsh-feyagate-gateway` · 版本 `0.3.1`

> **0.3.1 变更**：重新生成 `manifest/server-manifest.json`。上游 `miloco-mcp-server` v1.2.20 的 mac-arm64 产物
> 已于 2026-09-25 重新打包并覆盖发布（旧包缺 4 个依赖库导致启动即 `dyld: Library not loaded`，且 MQTT 未编入
> 导致华为设备能登录却无法控制）。清单里的 sha256 必须跟着更新，否则安装会以**校验不通过**结束 ——
> 请先升级插件到 `0.3.1` 再安装/升级后台服务。

---

## 一句话

**FeyaGate（飞阳网关）的 DSH 插件**：在 DSH 里托管本机的**后台服务** `miloco-mcp-server`（自动下载 → 校验 → 安装 → 守护 → 升级 → 失败回滚），把它的 **76 个 MCP 工具**（数量出自 `FeyaGate_MCP_API.md` §4）接进 DSH，并在设置面板里提供「服务 / 账号 / 授权」三个管理界面。

插件本体开源（MIT）；真正的智能家居逻辑在闭源二进制里，**二进制不进这个仓库、不随 npm 包分发**，运行时从权利人自己的渠道下载并按清单校验（见 [NOTICE](NOTICE)）。

**用词约定（全文一致）**：平台账号相关一律说「**登录**」，只有许可证才说「**授权**」；本机这个进程一律叫「**后台服务**」，不叫「网关」；「飞阳网关」是产品名与设置入口名。

---

## 架构一眼看完

```
┌─────────────────────────────── DSH 宿主进程 ────────────────────────────────┐
│                                                                            │
│  ┌────────────────────────┐        ┌─────────────────────────────────────┐ │
│  │ 浏览器半侧 lib/client.js│  同源  │ Host 半侧（插件本体，进程内运行）    │ │
│  │ 设置 › 飞阳网关         │ ◄────► │ /dsh-feyagate/* 管理 API            │ │
│  │ [服务][账号][授权]      │  HTTP  │ 安装·校验·守护·升级·生成 config.yaml │ │
│  └────────────────────────┘        └──────┬──────────────────┬───────────┘ │
│                                           │ ① spawn / 健康轮询 │ ② 常驻    │
│  ┌───────────────────────────────┐        │    /health         │          │
│  │ @deepseek-ai/dsh-mcp-client   │  HTTP  │                    ▼          │
│  │ serverName: feyagate          │ ─────► │        ┌────────────────────┐ │
│  │ 工具名 mcp__feyagate__*       │        │        │ MCP 门面 :38081    │ │
│  └───────────────────────────────┘        │        │ 秒答 initialize    │ │
│         ▲ 模型在对话里调用                 │        │ 就绪后代理工具调用 │ │
│         │                                  │        └─────────┬──────────┘ │
└─────────┼──────────────────────────────────┼──────────────────┼────────────┘
          │                                  ▼                  │ ③ 代理
          │                   ┌──────────────────────────────┐  │
          │                   │ 后台服务 miloco-mcp-server   │◄─┘
          │                   │ 127.0.0.1:38080（可漂移）    │
          │                   │ POST /mcp/http · GET /health │
          │                   │ 落盘 ~/.dsh/dsh-feyagate/    │
          │                   └───────────┬──────────────────┘
          │                               │ HTTPS / P2P / MQTT
          │                               ▼
          │        小米云 · 涂鸦云 · 美的云 · 易微联 · 华为云 · Home Assistant
          │                               ▲
          │                               │ 局域网
          └─────────────── 米家摄像头 · 小爱音箱 · 小智终端
```

三条要点：

1. **桥连的是插件自己的常驻门面，不是子进程**。门面端口写进 `state.json`，由 [`cordis.patch.yml`](cordis.patch.yml) 里的 `!!js` 表达式在 boot 时读取；子进程没装也能秒回 `initialize`（只返回空工具表），因此"先启动 DSH 再装服务"不会烧掉 MCP 桥的重连预算，升级窗口对模型也是零感知。`tools/list_changed` 的送达是**最终一致**的：桥的 SSE 流建立时若子进程已健康，门面立即补发一次；通知发出时若暂无客户端流，则标记 pending 并有界重发（5s/次、上限 12 次）——两种时序下桥都不需要重启 DSH 即可拿到工具列表。
2. **子进程真实端口是运行期细节**。默认 `38080`，被占用时在 20 个端口范围内漂移；期望端口进 `state.json` 的 `server.port`，实际生效的端口在启动这一轮写进生成的 `config.yaml`，不写进任何静态配置。
3. **安装根目录本身是不可移动的**。`config.yaml` 就放在根目录，子进程把设备身份与许可证锚定在 `config.yaml` 所在目录 —— 根目录一换就等于换了一份身份（见下方「数据在哪里」与 [ADR-0002](docs/adr/0002-install-directory.md)）。

---

## 安装与最短路径

### 1. 装插件

```bash
dsh plugin --profile <profile> add @dsh-external/dsh-feyagate-gateway
```

`<profile>` 是你要装进去的 profile 名（例如 `web`）。这条命令把参数原样转发给 pnpm，并在 `package.json` 里看到 `dsh.bundle.patch` 后把本插件的 bundle 追加进 `dsh.profile.bundles` —— **不需要手改 profile 文件**。装完重启（或让 HMR 重合成配置层）后，设置面板左侧会多出一行「**飞阳网关**」。

### 2. 装后台服务（唯一必须做的一件事）

打开 **设置 › 飞阳网关 › 服务 › 概览**，点 **安装后台服务**。安装向导会依次做五件事，每一步都有真实进度：

```
① 下载  ████████░░░░  56%  17.1 MB / 30.4 MB · 1.8 MB/s
② 校验  sha256 与同版本 .sha256 比对        ← 不通过就删除文件并中止
③ 解压  释放到 versions/<version>/
④ 写入  可执行权限（macOS 还会去 quarantine + ad-hoc 重签）
⑤ 启动  切 current 指针 → 拉起进程 → 轮询 /health
```

> MVP **不会**在你点之前偷偷下载任何东西。没装就是没装，界面只会给你一个按钮。

### 3. 确认工具接上了

安装完成后，在对话里问一句「列出我的智能家居设备」。模型应该能调用到形如 `mcp__feyagate__*` 的工具（例如 `mcp__feyagate__device_list`）。

> 公开工具名由 MCP 桥做函数名规范化（原始名里有 `/`，如 `device/list`），**以运行时 `tools/list` 的结果为准**；本仓库文档里写的名字是形状示意。

### 4. 登录平台账号

**在设置界面里点着登录**：`设置 › 插件 › 飞阳网关 › 平台登录`，米家 / 涂鸦 / 美的 / 易微联 / 华为五张卡片各自一个流程（涂鸦直接显示可扫的二维码，米家是「拿授权地址 → 粘回回调地址」两步）。**哪张卡片能用由后台服务自己报的能力决定**：本机 v1.2.19 没有华为工具，华为卡片就明确写「本构建不支持」而不是给一个必然失败的按钮；后台服务升到 v1.2.20 后这张卡片自己出现，插件不用跟着升级。

凭据（账号、密码、验证码）只在**本机回环**内交给后台服务进程：插件不落盘、不写日志、不回显，写操作全部校验 Origin，密码输入框提交后即清空。详见 [ADR-0009](docs/adr/0009-platform-login-in-settings-page.md)。

**对话里也能走**（工具清单见 [FeyaGate_MCP_API.md](../feyagate-skill-gh/FeyaGate_MCP_API.md)）——两者调的是同一批工具：小米走浏览器 OAuth、涂鸦走二维码、美的/易微联走账号密码、华为走两步验证码。

**涂鸦（唯一一条完全在聊天里走完的授权链）** —— 你只需要做两件事：

1. 先在涂鸦 App 里查一次自己的用户代码：**我的 → 设置 → 账号与安全 → 用户代码**，把它发给模型（形如 `AY1790336520…`）。
2. 模型回复里会出现一张**二维码图片**（不是 token 文本）。用涂鸦 App 右上角「+ / 扫一扫」扫它，再在 App 里点「确认登录」。

之后不用你再说话：插件在服务端替模型轮询（单次最多等 35 秒），扫到即返回，模型会告诉你已登录，并可以接着 `device_list` 看设备。

> 为什么必须由插件出图：上游 `auth/tuya_qr` 只回一个 `token`（`tuyaSmart--qrLogin/?token=…`）——那是给**摄像头**扫的载荷，聊天里没有可扫的东西，用户会被卡在「请扫描下方二维码」却没有二维码。插件把 token 渲染成 PNG（`/dsh-feyagate/auth/tuya/qr.png?token=…`）并写进工具结果与工具描述，见 [docs/verify-tuya-auth-flow.md](docs/verify-tuya-auth-flow.md)。
>
> 图片没显示时（客户端不渲染图片）：工具结果里同时给了 `qr_text_url`（方块字符版二维码，任何客户端都能显示）；也可以直接把该地址粘进浏览器。

最短路径到"控制一盏灯"：装插件 → 装后台服务 → 对话里让模型登录米家 → 让模型 `device/list` 找到灯 → 开灯。

---

## 功能清单

### MVP（0.1.x 目标）

| 能力 | 说明 |
|---|---|
| 后台服务托管 | 按 `manifest/server-manifest.json` 解析平台资产 → 多源降级下载 → **先校验后解压** → 落到 `versions/<version>/` → 切 `current` 指针 |
| 进程守护 | spawn / PID 文件 / 孤儿与多实例清理 / `/health` 轮询（40 × 500ms）/ 崩溃退避重启（1s→30s）/ 熔断（60 秒内 5 次崩溃停止自动重启） |
| 端口管理 | 默认 `38080`，占用时在 20 个端口内漂移；期望端口留在 `state.json` 的 `server.port`，本次实际端口记进 `server.effectivePort` 并写进生成的 `config.yaml` |
| config.yaml 生成 | 插件是**唯一写者**，字段归属见 [ADR-0003](docs/adr/0003-generated-config.md)；子进程会回写的字段读回合并，不覆盖 |
| MCP 接入 | 官方 `@deepseek-ai/dsh-mcp-client` 桥指向插件常驻门面（`127.0.0.1:38081`），工具以 `mcp__feyagate__*` 出现；`tools/list_changed` 最终送达（流建立补发 + pending 有界重发），装服务/改端口后桥无需重启 DSH |
| 76 个 MCP 工具（数量出自 `FeyaGate_MCP_API.md` §4 的自述） | 设备/摄像头/场景/定时/触发规则/记忆/技能/小智/授权查询，全部经门面代理到子进程 |
| 设置界面 · 服务 | 概览 / 安装与重装 / 升级与版本 / 端口与网络 / 日志与诊断 / 危险区 |
| 设置界面 · 授权 | 许可证与试用期：版本、状态、到期、宽限、授权码写入、设备 ID、各平台试用剩余 |
| 设置界面 · 账号总览 | **只读**：平台清单、登录状态、设备数、试用剩余（清单以服务端下发为准，本地不写死） |
| 设置界面 · 平台登录 | 五个平台的图形化登录/退出：米家两步 OAuth（自动从回调地址里抠 `code`）、涂鸦二维码（服务端完成最长 35 秒的扫码等待）、美的/易微联账号口令、华为两步验证码（**按 `retry_without_code` 分流，不白费一个验证码**）；能力协商驱动，缺哪个平台就说清缺什么；授权过期时给出"去授权标签"而不是"密码错了" |
| 升级与回滚 | 检查更新 → 升级到 `versions/<new>/` → 健康确认失败自动回滚 `lastKnownGood`；断电安全靠 `pending` 标记 |
| 随插件分发的 Skill 文档 | `skills/feyagate-gateway/SKILL.md`，教模型怎么正确调用这 76 个工具 |
| 插件自身升级 | **只做"检测到新版本 + 提示 + 给可复制的升级命令"**（见下） |

### 二期（明确**不是**"已支持"）

- 常驻门面的工具集热更新（子进程就绪后发 `notifications/tools/list_changed`）之外的**多端点管理**：局域网 ESP32 网关、远端 miloco，条目分「本机托管」与「远端只连」。
- Home Assistant（上游 `miloco-mcp-server` 与桌面端都**没有** HA provider，只有 ESP32 固件有；要做只能直连 ESP32 的 `/api/v1/platform/ha/*` 或 HA 自己的 WebSocket）。
- 设备页与摄像头页（连接 / 断开 / 抓拍 / 采集参数）、智能页（小智 AI / Vision AI / 触发规则 / 记忆 / 技能）。
- 插件内一键升级（spawn `dsh plugin update` + 宿主重启）。
- 诊断包导出、镜像源配置界面。

### 明确不做

- 不做自研 DRM：许可证事实源在子进程，插件只呈现与转发。
- 不读写已有的 `~/.feyagate` 安装（只做只读探测，用于提示"检测到既有安装"，见 [ADR-0002](docs/adr/0002-install-directory.md)）。
- 不在运行期动态增减工具集（会打断 KV cache 前缀；平台开关要求重连）。
- 不下载、不镜像、不分发小米专有库 `libmiot_camera_lite`。

---

## 设置界面

界面注册在**唯一一个** `settings.section`（id `feyagate`，label「飞阳网关」，order 30）下；插件级参数挂在 `settings.plugin.item`，可复用 DSH 通用的「已覆盖 / 恢复默认 / 未保存 / 保存失败」表单语义。参数表（[`src/settings.ts`](src/settings.ts) 的 `PluginSettings`）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `serverPort` | `38080` | 子进程的期望端口 |
| `facadePort` | `38081` | 门面端口（改它需要重启 DSH） |
| `bindAddress` | `127.0.0.1` | 可选 `0.0.0.0`（开局域网，必须看警告） |
| `cloudServer` | `cn` | 小米云区域 |
| `autoStart` | `true` | DSH 启动时自动拉起子进程 |
| `mirrorBase` | `null` | 自建镜像前缀（降级链的第三环） |
| `localArchive` | `null` | 本地安装包路径（降级链的最后一环） |
| `allowUnverified` | `false` | 允许安装"完全没有校验值"的资产（界面里是显式确认） |

**安装根目录不在参数里**：它固定是 `~/.dsh/dsh-feyagate`（或 `$DSH_HOME/dsh-feyagate`）。这不是漏了，是因为换目录等于换设备身份。

> **地图不是按钮**：DSH 的 `settings.section` 只拿到 `close()`，拿不到跨页跳转能力，所以界面里的跨页指引一律写成可复制的文字路径（`设置 › 插件 › 插件配置 › 飞阳网关`）。

| Tab | MVP 做到哪 | 解决什么问题 |
|---|---|---|
| **服务** | 概览 / 安装与重装 / 升级与版本 / 端口与网络 / 日志与诊断 / 危险区 | 「后台服务在不在、什么版本、坏在哪、怎么修」 |
| **账号总览** | 只读总览（平台清单 + 登录状态 + 设备数 + 试用剩余） | 「一屏看清哪个平台是红的」 |
| **平台登录** | 五个平台的登录/退出（能力协商驱动，缺什么说什么） | 「直接在界面里把账号登进去」，不必先学会跟模型描述工具调用 |
| **设备** | ❌ 二期 | 「设备都被看见了吗、摄像头能看吗」 |
| **智能** | ❌ 二期 | 小智 AI / Vision AI / 触发规则 / 记忆 / 技能 |
| **授权** | 许可证与试用期（授权码写入、各平台状态、设备 ID） | 「免费能用什么、授权解锁什么、还剩几天」 |

每个 tab 顶部有一条**常驻服务状态条**（10 秒轮询、页面不可见时暂停），把运维面的结论带到每一页：

```
● 运行中 · v1.2.20 · 端口 38080 · 3/7 平台已登录 · 试用剩 12 天   [检查更新]
○ 未安装 · 尚未下载后台服务                                       [安装]
▲ 降级运行 · 华为设备控制不可用（命令通道未建立）                  查看原因
```

**截图占位**（`docs/images/` 目录本仓库暂不创建，避免提交二进制；下面按顺序补图）：

<!-- TODO(screenshot) 设置 › 飞阳网关 › 服务 › 概览：状态条 + Hero + 健康检查 + 快捷统计 -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 服务 › 安装与重装：五阶段进度条（下载中，带字节数与速度） -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 服务 › 升级与版本：有新版本卡片 + 版本历史（含「回滚到此版本」） -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 服务 › 端口与网络：端口校验错误（FG-PORT-001，带占用 PID） -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 服务 › 日志与诊断：日志行 + 自检项 -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 授权：免费版横幅 + 各平台授权状态表 -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 账号总览：平台总览卡片（只读） -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 平台登录：涂鸦二维码 + 扫码等待中 -->
<!-- TODO(screenshot) 设置 › 飞阳网关 › 平台登录：华为卡片在 v1.2.19 上如实显示「本构建不支持」 -->
<!-- TODO(screenshot) 设置 › 插件 › 插件配置 › 飞阳网关：插件参数卡 -->
<!-- TODO(screenshot) 首次安装引导（settings.onboarding 步骤） -->

界面设计规格（逐屏字段、状态词表、错误文案三层结构、可用性走查、验收清单）在 [UX 设计文档](../../docs/design/feyagate-dsh-plugin-ux.md)；本文只描述**已确认的 MVP 范围**，两者不一致处见下方「已知不一致」。

---

## 为什么需要 `manifest/server-manifest.json`

因为**上游资产命名逐版本漂移，运行时拼文件名必然失败**。这不是假设，是同一仓库同一年的实测事实：

| 版本 | 平台 | 真实资产名 | 备注 |
|---|---|---|---|
| v1.2.20 | mac-arm64 | `miloco-mcp-server-mac-arm64-v1.2.20.zip` | 「规范」形态 |
| v1.2.20 | mac-x64 | `miloco-mcp-server-mac-x64-v1.2.20.tar.gz` | **完全没有 zip** |
| v1.2.20 | win-x64 | —— | **这个版本没有任何 Windows 资产**，所以 Windows 默认目标停在 1.2.19 |
| v1.2.19 | win-x64 | `miloco-mcp-server-1.2.19-windows-x64.zip` | 版本号在前、写 `windows` 而不是 `win` |
| v1.2.19 | win-x64 | `miloco-mcp-server.exe` | 还有一个**裸可执行文件**，没有压缩包 |
| v1.2.17 | linux-arm64 | `miloco-mcp-server-linux-arm64-v1.2.17.tar.gz` | linux-arm64 的**最新版本停在 1.2.17** |

所以本仓库自带一份**权威清单**：逐平台记录真实文件名、体积、URL 与 sha256（没有 `.sha256` sidecar 的资产记 `null`）。清单同时承载：

- `pluginCompat.minSupportedServer` / `maxTestedServer`：低于下限拒绝运行，高于上限提示"未测试"。
- `channel.stable`：**逐平台**的默认目标版本（Windows 与 linux-arm64 因此不会去追一个根本不存在的版本）。
- `fotaType`：FOTA 兜底源里各平台对应的 `type` id（mac-arm64 与 linux-arm64 **没有** FOTA 条目，实测）。

**维护者更新清单**：

```bash
node scripts/gen-manifest.mjs                     # 抓取全部 release，重算 sha256
node scripts/gen-manifest.mjs --tag v1.2.20       # 只更新一个 tag
node scripts/gen-manifest.mjs --compute-missing   # 对没有 sidecar 的资产下载一次并本地算 sha256
                                                  # （默认只补每个平台的默认目标）
```

`--compute-missing` 的意义：`sha256: null` 的资产**必须先由用户显式确认才能安装**。它对"默认目标"把这条路走通，更早的钉版本仍然留在不可校验状态，因此不在 happy path 上。

`package.json` 里另有 `npm run check:manifest`（→ `scripts/verify-manifest.mjs`）用于校验清单自洽（资产 URL 与文件名一致、`channel` 指向存在的资产、`pluginCompat` 区间合法），适合接进 CI。

---

## 运维手册

### 数据在哪里

安装根目录默认 `~/.dsh/dsh-feyagate`（`$DSH_HOME` 存在时是 `$DSH_HOME/dsh-feyagate`）：

```
~/.dsh/dsh-feyagate/
├── state.json                 插件唯一的可变账本：current / lastKnownGood / pending / 端口 / facade 端口 / 设置
├── config.yaml                ★ 生成物（插件是唯一写者），子进程按 `--config` 读它
├── data/                      ★ 子进程数据：token、license.json、device_id.txt、memory、skills、快照
├── logs/server.log            子进程 stdout/stderr + 插件日志，单行截断 4000 字符
├── versions/<version>/        每个版本一个不可变目录（下载→校验→解压的落点）
├── cache/                     下载的压缩包与解压暂存
└── current                    指针文件（不是软链接，为了 Windows），内容是一行版本号
```

**`config.yaml` 为什么在根目录而不是 `config/` 子目录里**：这不是风格选择。子进程把**所有相对路径**按 `config.yaml` 所在目录展开（`src/config.cpp` 的 `resolve_path` 作用于 `license_file`、每个 `*_token_file`、`memory.data_dir`、`skill.*_dir`），并且 `src/main.cpp` 用它推导自己的数据目录（`device_id.txt`、`token_usage.json`）。所以"`config.yaml` 旁边那个目录"**就是**数据根。放进 `config/` 会让 `data/` 悄悄变成 `config/data/`，还会挪走 `license.json` —— 那正是设备 ID 与授权绑定的地方，用户升级一次插件就会被云端当成新设备、重新领一份免费试用。这就是 [`src/paths.ts`](src/paths.ts) 把文件放在根目录的原因。

**唯一不可移动的东西就是安装根目录**。移动或重建它 = 换一份 `device_id` = 授权与免费试用重新绑定。因此插件从不"迁移"这个目录，只往里写。备份时请整目录一起备。

### 改端口

- HTTP 端口（子进程）：**设置 › 飞阳网关 › 服务 › 端口与网络** → 保存 → 会提示"端口改动需要重启后台服务才会生效"，并自动重启。默认 `38080`，被占用时自动漂移并在界面上显示真实端口。
- 门面端口：默认 `38081`，写进 `state.json`。**改动它需要重启 DSH**，因为 MCP 桥的 URL 来自 boot 时求值的 `cordis.patch.yml`。
- 绑定地址：默认只绑 loopback。要开局域网必须显式开启，界面会同时给出"本地接口不校验身份"的警告。

### 日志

- 界面：**服务 › 日志与诊断**，可切级别（对应子进程的 `LOGV/LOGD/LOGI/LOGW/LOGE`）、按行数与关键字过滤、复制全部。
- 文件：`~/.dsh/dsh-feyagate/logs/server.log`（同一份环形缓冲区同时喂界面与文件，所以界面里能看到"崩溃行 + 守护进程的反应"的因果顺序）。

### 回滚

三种情形：

1. **升级后没通过健康检查** → 自动回滚到 `lastKnownGood`，界面留一条常驻橙条，提供「重试升级 / 查看失败日志 / 保留旧版本并忽略此版本」。
2. **升级中途断电/崩溃** → `state.json` 里的 `pending` 在下次启动仍未确认，**自动回滚**。这就是 `versions/` 不可变 + `current` 指针 + `pending` 三件套存在的理由。
3. **手动回滚** → **服务 › 升级与版本 › 版本历史**，点「回滚到此版本」（本机已有该版本目录时才可用；没有则需要重新下载）。

### 卸载

**先停服务**（服务 › 危险区 › 停止服务），再删目录：

```bash
# 1) 停服务（界面：设置 › 飞阳网关 › 服务 › 危险区 › 停止服务）
# 2) 删后台服务与数据（不可恢复：平台凭据、设备、记忆、技能、快照、日志）
rm -rf ~/.dsh/dsh-feyagate

# 3) 卸载插件本体
dsh plugin --profile <profile> remove @dsh-external/dsh-feyagate-gateway
```

只想留数据、只删二进制？删 `~/.dsh/dsh-feyagate/versions` 与 `current` 即可（界面上的「卸载服务」做的就是这件事，凭据与配置保留）。

清理时**不要**动根目录以外的东西：不要删 `config.yaml` 与 `data/`（那是设备身份与授权），也不要动 `~/.dsh/profiles/<profile>/`（那是 DSH 自己的）。只想留数据、只删二进制？删 `~/.dsh/dsh-feyagate/versions` 与 `current` 即可（界面上的「卸载服务」做的就是这件事，凭据与配置保留）。

---

## 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 启动时提示 `feyagate-gateway … did not activate` / `failed to import` | 装的是**源码目录或 git 依赖**，而 `lib/` 是构建产物、不在仓库里；宿主 `import` 不到入口 | 在该包目录跑 `npm install && npm run build`（`prepare` 脚本会在 `npm install` 时自动构建；`dsh plugin add <本地路径>` 用 `link:` 语义、不会触发它）。npm 安装的正式包自带 `lib/`，不受影响 |
| 工具列表里没有 `mcp__feyagate__*` | ① 插件没装进当前 profile；② MCP 桥行没生效；③ 桥连不上门面（门面端口被改但没有重启 DSH）；④ 后台服务尚未装/尚未健康（门面如实回空表）；⑤ **上游工具清单不合规**：零参数工具的 `inputSchema` 是 `{}`（缺 `type:"object"`），严格客户端会**整份拒收** `tools/list` ⇒ 一个工具都注册不上（服务却显示"已连接"） | ① `dsh plugin --profile <p> why @dsh-external/dsh-feyagate-gateway`；② 检查 profile 的 bundle 列表里有没有本插件；③ 设置 › 飞阳网关 › 服务 看状态条，重启 DSH 让 patch 重新求值；④ 装/启动后台服务后**无需重启 DSH**：服务健康后门面自动（必要时补发）`tools/list_changed`，桥随即 re-sync 出工具；⑤ **已修**：门面转发 `tools/list` 时会把不合规的 `inputSchema` 补齐成 `{type:"object", properties:{}}`（见 [docs/verify-mcp-inputschema-fix.md](docs/verify-mcp-inputschema-fix.md)），升级插件后重启 DSH 即可。判断方法：插件的 `logs` 里会有一行 `已修正 N 个工具的 inputSchema` |
| 工具列表里**有**工具但调用失败 | 后台服务没起 / 正在升级 / 门面还没代理到子进程 | 看状态条：`未安装` → 点安装；`异常` → 看日志；`升级中` → 等 10–20 秒 |
| 服务起不来：**端口被占用** | HTTP 端口被别的进程占了（常见：另一份 miloco / 既有 `~/.feyagate` 安装） | 界面报 `FG-PORT-001` 并给出占用 PID；点「换一个端口」（插件会在 20 个端口内漂移）或结束占用进程 |
| 服务起不来：**macOS 未签名被拦** | Gatekeeper 拦下未公证的第三方二进制 | 界面报 `FG-PERM-001`，给两条路：系统设置 › 隐私与安全性 ›「仍要打开」，或复制 `xattr -dr com.apple.quarantine <安装目录>/versions/<ver>/miloco-mcp-server`。受 MDM 管理的机器绕不过去 |
| 服务起不来：**依赖缺失** | 上游产物漏带运行库。**已实测**：`mac-arm64 v1.2.20` 的二进制声明依赖 `lib/libyaml-cpp.0.9.dylib`、`libavcodec.62.dylib`、`libavutil.60.dylib`、`libswscale.9.dylib`，而归档里只有 `libmiot_camera_lite.dylib` —— dyld 立即中止，进程活不过 20 毫秒 | 插件报 `FG-PKG-004`「安装包缺少运行库」，**并在同一条错误里附上子进程自己打印的 dyld 原文**（折叠在「技术细节」）。这是上游发布包的问题，换一个版本或等上游修；Linux 侧是否有同类缺失**尚未实测**，按日志里的 `error while loading shared libraries` 判断。华为控制另需 `libmosquitto`，缺失时是**降级**不是故障（`brew install mosquitto` 后重启服务） |
| 服务起不来：**健康检查超时** | 20 秒内 `/health` 无 2xx（端口冲突 / 被安全策略拦 / 依赖缺失三类之一） | 报 `FG-BOOT-001`，界面给「查看日志 / 换端口重试 / 重新安装」三个出口；不要只看转圈，日志末行一定有原因。**子进程若在就绪前就退出，插件立刻失败并把它最后 12 行输出一起报出来**，不会再让你等满 20 秒；启动期退出也不会进入崩溃重启循环 |
| **GitHub 不可达** | 代理 / 防火墙 / 企业策略拦了 `github.com` | 触发多源降级：GitHub Releases → FOTA（`oneapi.sooncore.com/ota/fota.json`，带 md5）→ 可配置镜像 → 本地包。界面报 `FG-NET-001`，给「重试 / 改用镜像地址 / 复制诊断信息」 |
| **校验失败** | 下载不完整、代理缓存了坏文件，或资产没有 sha256 sidecar | `FG-PKG-001`：插件**删除已下载文件并中止**，文案直接给出"期望 vs 实际"的摘要。`FG-NET-004`：服务器没提供校验文件 → 出于安全**不会安装**，需要换源或走本地包；清单里 `sha256: null` 的资产必须由你显式确认才装 |
| **摄像头功能不可用** | ① Windows 平台不支持（依赖米家 P2P 协议库，只支持 macOS / Linux）；② 米家未登录；③ 小米专有库 `libmiot_camera_lite` 在上游包里缺失 | ①②界面会直接说明并给动作；③显示为「**降级运行 + 原因**」：摄像头不可用，其它平台照常工作 |
| 华为设备**能看不能控** | 命令通道（消息中心 MQTT 长连接）未建立：华为云没有 REST 写通道，控制必须走 MQTT | 界面显示「命令通道未建立 —— 状态可读，控制会失败」+ 修复指引（缺 `libmosquitto` 时 `brew install mosquitto`，装完需重启服务）。这是**降级**，不是错误 |
| 授权 / 试用相关显示 | 免费平台、90 天试用、7 天宽限、授权码 `FG-XXXX-XXXX-XXXX` | 授权页如实呈现服务端下发状态（本地不写死平台清单）；**读工具始终可用，写工具在试用过期后需要授权** —— 界面会明确写"状态可查看；控制设备需要授权或有效试用"，不要说成"功能全部不可用" |
| 界面报「宿主离线」/ 403 | 浏览器与 DSH 宿主断开，或页面不是从本机打开的（远程部署），或部署把设置设为只读 | `FG-HOST-001` / `FG-API-403`：后台服务只能在运行 DSH 的那台电脑上管理；写操作会被禁用并说明原因 |

完整错误码表（`FG-<域>-<三位号>`，域为 `NET / PKG / PERM / PORT / BOOT / PLAT / HW / LIC / HOST / API`）见 [docs/user-guide.zh.md](docs/user-guide.zh.md)。

---

## 开源与合规边界

完整口径见 [NOTICE](NOTICE)，三条红线：

1. **仓库不含任何二进制**。不收 `miloco-mcp-server` 的可执行文件、压缩包或它的一部分 —— 仓库里没有，npm 包里没有，任何 release 附件里也没有。运行时从权利人自己运营的渠道下载，落到**用户自己的机器**上。
2. **二进制的许可由它自己的渠道决定**，与本项目的 MIT 无关。想再分发二进制、或想运营镜像的人，必须自行满足权利人的条款。社区 fork 必须**不要**以本项目名义发布二进制镜像；下载源可配置，fork 应指向自己的渠道。
3. **小米专有库 `libmiot_camera_lite` 永不分发**。不下载、不镜像、不捆绑、不再分发。上游部分构建不含它，此时摄像头不可用、其它平台正常，插件把这种情况显示为"降级运行 + 原因"，而不是静默失败或假装功能存在。

**一处诚实的未知**：`miloco-mcp-server` 的源码树带 MIT 许可证文件，README 又写明摄像头原生库是小米专有、"闭源"是分发策略而非许可证结论；其自述基于 Xiaomi Miloco 项目，**上游血统的许可证未在本项目内审计**。产物若静态/动态链接了 LGPL 组件（例如 Linux 上的 FFmpeg 系列），再分发需满足相应义务 —— 这些义务属于**发布产物的人**，本项目不做审计。若你是权利人并希望更正此处表述，请开 issue。

---

## 贡献指南

### 开发环境

- Node.js ≥ 20.16.0（`engines.node` 与 `engines.dsh >= 0.1.5-rc.1`）。
- **全新克隆的入口只有一条命令**：`npm install && npm test`。`lib/` 是构建产物、不在仓库里，所以下面那些依赖 `lib/` 的检查必须先 `npm run build`；`npm test` 已经包含构建。
- 构建：`npm run build`（= `bash scripts/build.sh`，产出 `lib/index.js` 与 `lib/client.js`）。也可分开跑：`npm run build:client`（tsdown 打浏览器半侧 lazy-CJS）、`npm run typecheck`（tsc 只检查不产出）。
- **静态检查**（不需要构建，改完随手就能跑）：`npm run check` = `typecheck` + `check:manifest` + `check:patch`。
- **需要构建的检查**：`npm run check:runtime` = 下载层自检 + 离线冒烟（`smoke.mjs --offline`）+ 属主/看门狗（`check-supervise-ownership.mjs`）+ 涂鸦二维码（`check-tuya-qr.mjs`）+ 平台授权（`check-platform-auth.mjs`）。
- **完整验收**：`npm test` = `build` + `check` + `check:runtime` + `smoke:install`，共 **237 项计数断言**（24 补丁格式 + 5 下载层 + 19 离线冒烟 + 10 属主/看门狗 + 26 涂鸦二维码 + 54 平台授权 + 99 安装生命周期），另有类型检查与清单结构校验。安装生命周期覆盖：装 / 升级 / 回滚 / 校验不符拒装 / 无校验值默认拒装 / 真重装 / SIGKILL 自愈 / **接管未就绪进程** / 卸载留数据 / **启动即失败快速失败 + 失败不留脏状态 + 同版本重试真的重试**。
- 清单维护：`npm run manifest`（重新生成）、`npm run check:manifest`（CI 校验）。
- 端到端冒烟：`npm run smoke`（默认会真的去 GitHub 下载；加 `--offline` 跳过）。

> 冒烟脚本会往 `.smoke/`（`smoke-install.mjs` 用 `.smoke-install/`）写下载物与状态，两者都已在 `.gitignore` 里。

浏览器半侧有一个**必须遵守的契约**：产出必须是 `window.__ModuleLoader__.load({ id, factory })` 形态的 lazy-CJS（[`tsdown.config.ts`](tsdown.config.ts) 的 banner/footer 已经在做这件事）。只有前端 baseline 白名单里的模块可以留成裸 `require(...)`，其余必须打进 bundle；额外需要的前端包要写进 `package.json` 的 `dsh.client.inject`。

### 目录结构

```
app/dsh-feyagate/
├── package.json              exports["."]（Host）/ exports["./client"]（浏览器半侧）、dsh.bundle.patch、dsh.client
├── cordis.patch.yml          ★ 插入两行：feyagate-gateway（本体）+ feyagate-gateway-mcp（官方 MCP 桥）
├── tsconfig.json             Host 半侧 tsc：src/ → lib/
├── tsdown.config.ts          浏览器半侧 lazy-CJS bundle → lib/client.js
├── LICENSE / NOTICE          MIT / 合规口径（不含二进制、专有库永不分发）
├── manifest/server-manifest.json      ★ 权威清单：逐平台真实文件名 + sha256 + 兼容区间 + 默认通道
├── scripts/gen-manifest.mjs  ★ 唯一维护清单的入口（见「为什么需要清单」）
├── scripts/build.sh          tsc + tsdown 串起来，产出 lib/
├── scripts/verify-manifest.mjs CI 校验清单自洽
├── scripts/check-tuya-qr.mjs  涂鸦二维码：编码后用独立解码器读回
├── scripts/check-platform-auth.mjs  平台授权：能力协商 / 凭据边界 / 门禁与分流
├── scripts/smoke.mjs         端到端冒烟：真下载 → 真校验 → 真解压 → 真启动
├── skills/feyagate-gateway/SKILL.md   随插件分发的模型技能文档
├── src/                      Host 半侧
│   ├── constants.ts          端口/路径/协议路径/退避参数，全部常量集中在此
│   ├── types.ts              契约：manifest、state、RuntimeStatus、JobSnapshot、API 信封
│   ├── paths.ts              落盘布局与 `current` 指针读写
│   ├── state.ts              state.json 原子写 + `pending` 握手 + 指针兜底
│   ├── log.ts                环形日志缓冲（喂界面与文件）
│   ├── util/atomic.ts        tmp+rename 原子写
│   ├── util/platform.ts      平台标签映射、版本比较、二进制名
│   ├── manifest.ts           清单解析、按平台解析资产、兼容区间判定
│   ├── config-gen.ts         config.yaml 唯一写者：MANAGED_FIELDS / SEED_ONLY_FIELDS
│   ├── settings.ts           插件参数（PluginSettings）读写与校验
│   ├── launcher.ts           子进程命令行与工作目录
│   ├── supervise/process.ts  spawn / PID / 孤儿清理 / 优雅停止
│   ├── supervise/health.ts   就绪探测、`/health` 轮询、空闲端口探测
│   ├── runtime.ts            状态机：not-installed → … → running / degraded / error
│   ├── install.ts            安装 / 升级 / 回滚 / 卸载，全部表达为 job
│   ├── jobs.ts               长任务账本（phase / percent / attemptedSources / noop）
│   ├── download/sources.ts   多源降级链：github → fota → mirror → local
│   ├── download/fetch.ts     带进度与取消的下载
│   ├── download/verify.ts    流式 sha256 / md5
│   ├── download/extract.ts   zip / tar.gz / 裸 exe，拍平 + chmod 755 + macOS 去隔离
│   ├── child-api.ts          子进程 REST / MCP 调用封装
│   ├── api.ts                同源管理 API `/dsh-feyagate/*`（写操作校验 Origin）
│   ├── mcp/facade.ts         常驻门面：恒答 initialize、空表降级、就绪后代理
│   ├── download/index.ts     下载子模块的统一出口
│   ├── index.ts              插件入口：Config schema、apply()、ctx.effect 清理
│   └── client/               浏览器半侧
│       ├── index.tsx         设置面板：服务 / 账号 / 授权（React）
│       └── contract.ts       Host ↔ 浏览器半侧共享的类型契约
└── docs/
    ├── design.md             工程内设计文档（双半侧边界、MCP 选型、状态机、字段归属）
    ├── user-guide.zh.md      面向最终用户的操作手册
    ├── verify-mcp-inputschema-fix.md
    ├── verify-platform-login.md
    ├── verify-tuya-auth-flow.md
    │                         验证记录：AI 看不到工具的真实根因（上游 inputSchema 不合规）与修复
    └── adr/0001…0008         8 条架构决策记录（0008：多实例共享安装根时的接管策略）
```

### 每个脚本做什么

| 脚本 | 作用 |
|---|---|
| `scripts/gen-manifest.mjs` | 抓 GitHub Releases，逐资产识别平台与打包类型，抓 `.sha256` sidecar，算出逐平台默认版本，写出 `manifest/server-manifest.json`。支持 `--tag` 与 `--compute-missing` |
| `scripts/build.sh` | 先 `tsc -p tsconfig.json` 编 Host（含 `.d.ts` → `lib/types/`），再 `tsdown` 打浏览器半侧 |
| `scripts/verify-manifest.mjs` | CI 校验：清单自洽（资产 URL 与文件名一致、`channel` 指向存在的资产、`pluginCompat` 区间合法） |
| `scripts/selfcheck-download.mjs` | 下载/校验/解压层的单元自检（用构造出来的归档，不联网）：校验失败必须删掉坏包且绝不落位、无校验值默认拒绝、顶层目录上移、找不到二进制时报错而不是静默成功 |
| `scripts/check-patch.mjs` | 校验 `cordis.patch.yml`：用与 DSH 完全相同的解析方式（`parseDocument` + `tag:yaml.org,2002:js`）解析，并**实际执行** `url` 表达式，确认它能读到 `state.json` 的漂移端口 |
| `scripts/check-tuya-qr.mjs` | 涂鸦授权：token→二维码（PNG 与文本兜底**都用独立解码器 `jsqr` 读回**，不只看「产生了图片」）、`chat_display` 文案、路由端到端、非法 token 400（26 项断言） |
| `scripts/check-platform-auth.mjs` | 平台授权（插件 API 边界 + 假子进程）：能力协商（缺华为时卡片就该缺席）、涂鸦扫码**一次请求等到 `authorized`**（上游被问 ≥2 次）、用户代码错不伪造二维码、美的/易微联/华为的登录与失败文案、米家「粘整段回调地址 → 抠出 `code`」，**授权门禁 `capability_denied` → 403 并指向授权标签**、华为 `retry_without_code` **不当成失败**、退出登录 501 如实说上游没有、**密码不出现在插件日志/状态/任何响应里**、其他 Origin 的登录请求 403、服务未运行时 503（54 项断言） |
| `scripts/check-supervise-ownership.mjs` | 属主与看门狗：pid 文件写明属主时**访客不得杀掉别人的子进程**（只如实报告），属主消失后才允许替换，无人拥有的会被接管并登记自己为属主（10 项断言，用快速看门狗参数，约 3 秒） |
| `scripts/smoke.mjs` | 插件对外契约：`apply()`、门面在无子进程时的应答、HTTP API、Origin 校验。加 `--offline` 跳过需要下载的内网测试 |
| `scripts/smoke-install.mjs` | 安装生命周期：用**合成发行包**跑 校验 → 解压 → 激活 → 启动 → 健康 → 转发 → 升级 → 回滚 → 崩溃自愈 → 接管未就绪进程 → 卸载保数据 → 启动即失败（90 项断言） |
| `npm run check` | 静态检查三件套：类型 + 清单 + patch。**不需要构建**，改完随手可跑 |
| `npm run check:runtime` | 需要构建的检查：下载层自检 + 离线冒烟 + 属主/看门狗 + 涂鸦二维码 + 平台授权 |
| `npm test` | `build` + `check` + `check:runtime` + `smoke:install`，本仓库的完整验收（237 项计数断言） |
| `npm run typecheck` | `tsc --noEmit`，只检查不产出 |
| `npm run build:client` | 只跑 tsdown，快速迭代浏览器半侧 |

### 改代码前请先读

- [`docs/design.md`](docs/design.md)：双半侧职责边界、为什么桥指向门面、状态机、配置字段归属表。
- [`docs/verify-mcp-inputschema-fix.md`](docs/verify-mcp-inputschema-fix.md)：**AI 看不到 `mcp__feyagate__*` 工具**的根因链与修复证据（含真机复验与复现命令）。
- [`docs/verify-tuya-auth-flow.md`](docs/verify-tuya-auth-flow.md)：**涂鸦授权卡在「请扫码」却没有二维码**的根因、三层适配设计与验证证据（独立解码器回环 + 真机探针）。
- [`docs/verify-platform-login.md`](docs/verify-platform-login.md)：设置界面里五个平台登录的**能力协商、凭据边界、门禁与 `retry_without_code` 分流**怎么验的（54 项断言 + 真机探针输出）。
- [ADR-0009](docs/adr/0009-platform-login-in-settings-page.md)：**为什么把登录从"只在聊天里"搬进设置页**，以及为此承诺的凭据边界。
- [`docs/adr/`](docs/adr)：7 条已定决策与它们的**替代方案被否的理由**。改架构前先看有没有撞上其中一条。
- [`../../docs/DSH-插件机制研究报告.md`](../../docs/DSH-插件机制研究报告.md)：DSH 插件机制的实证结论（每条带文件:行号）。

### 提交约定

- 术语必须与 [UX 文档 §7.3](../../docs/design/feyagate-dsh-plugin-ux.md) 的唯一推荐用词一致（平台侧「登录」、许可证侧「授权」、本机进程「后台服务」）。
- 不确定的事实写成"未核实/待确认"，不要写成断言。文档里的每个端口、路径、命令都必须能在本仓库或引用文档里找到出处。

---

## 实现状态（诚实声明）

本 README 描述的是 **0.3.1 的形态**，`src/` 与 `scripts/` 里的文件都已落地并可构建：

- ✅ 双半侧都已在源码里：Host（`index.ts`、`runtime.ts`、`install.ts`、`supervise/*`、`mcp/facade.ts`、`api.ts`、`config-gen.ts`、`download/*`、`child-api.ts`、`settings.ts`）与浏览器半侧（`client/index.tsx` + `client/contract.ts`）。
- ✅ 工具链齐全：`scripts/{build.sh,gen-manifest.mjs,verify-manifest.mjs,check-patch.mjs,smoke.mjs,smoke-install.mjs}`，`lib/` 是构建产物（已 gitignore）。
- ⏳ 尚未做的**不是代码**，而是发布侧的事：npm 包发布、CI 接线、**在装有真实 `miloco-mcp-server` 的机器上跑一次验收**、设置界面的截图（本文里还是 `TODO(screenshot)` 占位）。

### 已经实测过的部分

`npm test` 全绿（24 + 5 + 19 + 10 + 26 + 54 + 99 项断言，另有清单结构校验）。具体覆盖：

| 验证对象 | 证据 |
|---|---|
| patch 能被 DSH 解析，且 `!!js` 表达式在 boot 时读到 `state.json` 的漂移端口 | `scripts/check-patch.mjs` 24/24：用官方同款 `parseDocument` + `tag:yaml.org,2002:js` 解析，再按加载器的方式 `new Function('ctx','expr','with(ctx){return eval(expr)}')` 求值；同时验证 `state.json` 缺失/损坏时不抛异常（否则 DSH 启动就会炸） |
| 门面在**没有任何子进程**时就能应答 `initialize`、`tools/list` 返回空数组、`tools/call` 明确报错 | `scripts/smoke.mjs`：这是整套架构的前提 |
| 门面把上游不合规的 `inputSchema: {}` **补齐**成对象 schema，且修完的整份 `tools/list` 能通过**真实 SDK** 的 `ListToolsResult` 校验 | `scripts/smoke-install.mjs` 第 1 节：合成子进程里**故意**放一个零参数工具（`auth/platforms`，`inputSchema: {}`），断言 ① 门面输出 `type:"object"` ② 已合规的 schema 逐字节未被改写 ③ **同一时刻直连子进程拿到的仍是 `{}`**（对照，证明是门面修的）④ 用 DSH 自带 `@modelcontextprotocol/client` 的 `specTypeSchemas.ListToolsResult` 校验通过 |
| 管理 API 的 Origin 校验、设置校验、端口漂移 | `scripts/smoke.mjs` |
| 校验失败后**删除坏包**（否则下次会复用半截文件）、找不到二进制时报错而非静默成功 | `scripts/selfcheck-download.mjs` 5/5 |
| 校验值不匹配必须拒绝，且不破坏现有安装 | `scripts/smoke-install.mjs` 第 4 节：清单里给真实 sha256，本地文件被改一个字节 → 拒绝，并在错误里同时给出期望值与实际值 |
| 无校验值默认拒绝、显式确认后放行（设置与单次覆盖两条路径） | `scripts/smoke-install.mjs` 第 5 节 |
| zip 与 tar.gz 两条解压分支、单层顶层目录拍平、可执行位、`config.yaml` 落在安装根目录且 `0600` | `scripts/smoke-install.mjs` 第 1–2 节 |
| 启动 → 健康检查 → 门面转发真实工具列表 → REST `{code,data}` 解包 | `scripts/smoke-install.mjs` 第 1 节 |
| 升级后回滚目标仍然可用、回滚后服务健康 | `scripts/smoke-install.mjs` 第 2–3 节 |
| 子进程被 `SIGKILL` 后自动拉起（换 pid、重启计数 +1） | `scripts/smoke-install.mjs` 第 7 节 |
| 设置界面里的五个平台登录：能力协商、凭据不落盘不进日志、授权门禁、华为免验证码分流 | `scripts/check-platform-auth.mjs` 54/54（真实 API handler + 假子进程，MCP 与"子进程连接被拒"两条路径都覆盖）；真机探针（v1.2.19 + 本机已登录米家）：能力协商只报 10 个授权工具、华为卡片自动缺席、米家授权地址真实生成、涂鸦假用户代码 400 原样透传、米家退出 501、**后台服务与用户米家登录均未被扰动** |
| 上游只回 token 时，门面把它变成聊天里可扫的二维码（`chat_display`），并用工具描述告诉模型「贴图 + 自己轮询、别反问用户」 | `scripts/smoke-install.mjs`（假子进程 + 调用计数器）：描述注入、`chat_display` 指向插件路由、**对照直连子进程只有 bare token**、一次调用等到 `authorized`（子进程被问 ≥3 次）、上游字段只加不改；`scripts/check-tuya-qr.mjs` 26 项含**真实解码回环** |
| pid 文件写明属主时，**访客不杀别人的子进程**；属主消失后才替换；无人拥有的接管后登记自己为属主 | `scripts/check-supervise-ownership.mjs` 10/10（用 `watchdogIntervalMs`/`watchdogFailures` 把 45 秒压缩到约 3 秒） |
| **接管尚未就绪的进程，而不是杀掉它重启**（共享安装根下多实例互杀的回归） | `scripts/smoke-install.mjs` 第 8 节：pid 文件指向一个「1.5 秒后才应答 `/health`」的进程，启动后必须**等到它健康并接管**，且该进程**不能被 SIGTERM** |
| 卸载删除版本目录但**保留 `data/`** | `scripts/smoke-install.mjs` 第 9 节 |
| **重装**必须真的重装（默认幂等会让它静默变成空操作），且不得把当前版本悄悄换成别的版本 | `scripts/smoke-install.mjs` 第 6 节：先把已安装的程序改坏，重装后逐字节恢复、服务重新健康、版本未变 |
| `webui_dir` 必须是**版本目录内的绝对路径**（相对路径下子进程必然找不到，只打一行 warning 就禁用内置 WebUI） | `scripts/smoke-install.mjs` 第 1 节 |
| 任务只登记**真正尝试过**的下载来源（未配置的镜像不算"试过"） | `scripts/smoke-install.mjs` 第 1 节 |

#### 真实发行包上的端到端（不是合成载荷）

mac-arm64 `v1.2.20`，从 GitHub Releases 真下载 **6,901,681 字节**，本地实算 sha256 = `5fd06524…bd6b`，与 `manifest/server-manifest.json` 中的值**逐字符一致**（该字节数与校验值已独立复核）。随后：解压出 5 个条目（`config.yaml` / `lib/` / `README.txt` / `webui/` / `miloco-mcp-server`，**顶层没有目录**，所以平铺是空操作）→ 去除 macOS 隔离属性 → **先签 `lib/libmiot_camera_lite.dylib` 再签主程序**（顺序颠倒会把已签好的依赖覆盖成无效签名）→ `mode 755` → `file` 报 `Mach-O 64-bit executable arm64` → `codesign --verify` 主程序与 dylib 均 OK → 二次调用幂等返回。

`src/download/*` 另有 34 项行为用例与 14 项网络用例（自签 HTTPS 覆盖 302 跟跳、503 重试、404 不重试、重定向到 http 被拒、重定向上限、空闲超时、取消、ftp 拒绝），以及一次 11,219,258 字节的真实下载与清单校验。

**仍未覆盖的**：DSH profile 里真实加载一次（`npm test` 用假 Cordis 上下文），以及设置页在真实 GUI 中的渲染。

所有行为描述（端口、路径、状态机、字段归属、API 与门面、界面字段）都来自**已落地的源码**与三份确认过的设计文档。文档与实现冲突时以源码为准，并请顺手改这份文档。

### 已知不一致（需要维护者或用户拍板）

1. ~~`cordis.patch.yml` 的注释与 `maxAttempts: 60` 口径矛盾~~ **已修正**：注释现在写明"默认 10 次 / 约 2.5 分钟"是本插件要抬高的**默认值**，60 次只是缓冲；门面的真正理由是"静态 YAML 端口拿不到运行期端口"。见 [ADR-0001](docs/adr/0001-mcp-integration.md)。
2. ~~`!!js` 表达式读 `state.json` 的前提未实测~~ **已实测**：见 `scripts/check-patch.mjs`（24 项）。仍未在真实自启动流程里验证的是"入口行按补丁顺序初始化、且 `apply()` 被 await"——它由 `vendor/loader/src/config/entry.ts` 的 `_start()`/`await fiber.await()` 支撑，属源码级证据。不成立时的退化路径是"改门面端口需重启 DSH"，即固定 `38081`。

   ⚠️ **改这个文件时最容易踩的坑**：`url: !!js "…"` 是多行引号标量，**收尾那一行也必须比 `url:` 缩进更深**。收尾行与键同缩进时，解析器会在内容行就认为标量结束，整个 patch 解析失败 —— 而 `dsh-app-boot` 遇到解析错误是**直接抛错**，后果是 profile 起不来。`scripts/check-patch.mjs` 就是为这个坑写的，`build.sh` 会跑它。
3. `dsh.client.inject` 只列 `@deepseek-ai/dsh-client-ui-slots`，而 [`tsdown.config.ts`](tsdown.config.ts) 允许外部化的名单有 8 项（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`-client-store`、`-client-ui-slots`、`-client-ui-primitives`）。这是**有意的不对称**：外部化名单是"允许留成裸 require 的上限"，`inject` 是"实际依赖的清单"，而 `client/index.tsx` 刻意不引 primitives。**如果界面以后开始引 primitives 或 store，必须同步加进 `inject`**，否则前端加载会失败。
4. ~~`server.ws_port` 无常量~~ **已修正**：新增 `DEFAULT_WS_PORT`（`constants.ts`），`config-gen.ts` 引用它。它不暴露在界面上 —— 插件自身不跑 WebSocket（MCP 桥走 Streamable HTTP），但子进程要求该字段存在。
5. `huawei.device_id` / `device_name`：子进程读取它们，但插件**不生成**（不在 `MANAGED_FIELDS` 里），源码里也没有对应的回写函数。这两个值的来源尚未核实。
6. **多个 DSH 实例共享一个安装根**（`~/.dsh/dsh-feyagate`：`state.json` / `server.pid` / `versions/` / `cache/` 各一份）。本机实测有三个实例跑同一个 profile，2026-09-25 18:16–18:20 期间后台服务被 `Received signal 15` 杀了 8 次、每次退避重启 —— 每个实例启动时都看到"别人的子进程还没应答健康检查"，于是**杀掉它并自己拉一个**，形成互杀。已修两处（见 [ADR-0008](docs/adr/0008-shared-install-root.md)）：① 给"活着但尚未应答"的进程 **30 秒宽限**（`ADOPT_GRACE_MS`），期间轮询并优先**接管**（`scripts/smoke-install.mjs` 第 8 节）；② **属主模型**：pid 文件记录 `ownerPid`，看门狗只重启**属于自己**（或属主已退出）的进程；别人的子进程卡死时只如实报告"属于另一个仍在运行的 DSH 实例"，不再杀它（`scripts/check-supervise-ownership.mjs` 10 项）。门面的代理目标也改为优先用它自己 supervisor 的端口，不再依赖机器级共享的 `state.json.effectivePort`。**仍未解决**：在任一实例点「停止服务」仍会停掉共享的那一个（这是显式操作）；建议日常只保留**一个** DSH 实例使用本插件。

---

## License

[MIT](LICENSE) © 2026 FeyaGate Contributors

本许可证**只覆盖本仓库的源码与文档**，不覆盖运行时下载的 `miloco-mcp-server` 二进制，详见 [NOTICE](NOTICE)。

---

## English summary

**dsh-feyagate-gateway** is an open-source (MIT) plugin for DeepSeek Harness that manages a local **miloco-mcp-server** background service and exposes its **76 MCP tools** to the model as `mcp__feyagate__*`.

- **Dual-half npm package + Cordis plugin.** Host half (`exports["."]`) owns download, checksum, install, supervision and upgrade. Browser half (`exports["./client"]`) renders one `settings.section` with Service / Accounts (read-only overview) / License tabs.
- **Two rows in `cordis.patch.yml`:** the plugin itself, plus the stock `@deepseek-ai/dsh-mcp-client` bridge (`serverName: feyagate`). The bridge points at the plugin's **always-on loopback MCP facade** (default `127.0.0.1:38081`, recorded in `state.json` and read by a `!!js` expression at boot), never directly at the child process. The child's real port (default `38080`, drifts when occupied) therefore stays a runtime detail, and installing the service after boot does not burn the bridge's reconnect budget.
- **Layout:** `~/.dsh/dsh-feyagate/` with `state.json`, a generated `config.yaml` **at the root** (the child resolves every relative path, including `data/`, against the directory holding that file, and binds its device identity and license there — so the root never moves), child-owned `data/`, `logs/server.log`, immutable `versions/<version>/`, `cache/`, and a `current` pointer file.
- **Integrity:** authoritative `manifest/server-manifest.json` (real upstream file names + sha256, because asset naming drifts between releases), sources degraded in order GitHub Releases → FOTA → configurable mirror → local package, always **verify before extracting**; assets without a checksum require explicit user opt-in.
- **No binaries in this repository**, ever. The Xiaomi proprietary `libmiot_camera_lite` is never downloaded or redistributed; when upstream omits it, cameras are unavailable and the plugin reports a degraded state with a reason.
- **Plugin self-upgrade** reuses `dsh plugin update` and requires a host restart; the MVP only detects a new version and shows a copyable command.
