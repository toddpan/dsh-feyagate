# ADR-0001：MCP 接入采用「插件自建常驻门面 + 官方桥指向门面」

> **这个文件解决什么问题**：回答"为什么桥不直连子进程，而要绕过插件自己的一道门面"，并写清这个决定的代价与失效条件。

- **Status**：Accepted（已落在 [`cordis.patch.yml`](../../cordis.patch.yml)）
- **Date**：2026-09-25
- **相关**：[`docs/design.md` §3](../design.md)、[ADR-0004](0004-binary-upgrade.md)、[ADR-0006](0006-api-and-origin.md)

---

## Context

DSH 内置 `@deepseek-ai/dsh-mcp-client`，MCP server 的配置方式是**Cordis patch 里的一行**（不是独立配置文件），支持 `stdio` 与 `streamable-http` 两种传输，工具公开名为 `mcp__<serverName>__<原始名>`。

我们的子进程 `miloco-mcp-server` 是**常驻 HTTP 服务**：`POST /mcp/http` 是 MCP Streamable HTTP 端点，`GET /health` 是健康检查；**不支持 stdio、不支持 SSE**。因此桥必须走 `streamable-http`，而 patch 行里的 `url` 是**boot 时求值的静态文本**。

三个把"直连"逼死的约束：

1. **端口是运行期的**。子进程默认 `38080`，但被占用时必须在 20 个端口内漂移（[`src/constants.ts`](../../src/constants.ts) 的 `DEFAULT_SERVER_PORT` / `PORT_SCAN_RANGE`）。漂移结果记在两个地方：本次实际绑定端口进 `state.json` 的 `server.effectivePort`，同时在启动这一轮写进生成的 `config.yaml`（`applyEffectivePort()`）。静态 YAML 写不出"运行期才知道的端口"。
2. **重连预算有限**。桥首次连接失败不阻塞启动，随后按 `500ms → ×2 → 30s` 退避重连；默认 `maxAttempts: 10`（约 2.5 分钟）后**移除工具并停止重连**。用户在 boot 之后才点"安装"（下载 20–30 MB），预算早已烧完 —— 现象是"装了插件但工具永远不出现"。
3. **不能运行期写 roster**。在插件运行期改写 profile 的 patch 来补端口，会与 `dsh plugin` 命令成为同一份 patch 的**双写者**，任何后续插件操作都可能覆盖掉。

## Decision

**插件自己跑一个恒在的、只绑 loopback 的 MCP 门面（默认 `127.0.0.1:38081`），桥指向它；门面按子进程状态决定返回空表还是代理转发。**

具体形态：

- `cordis.patch.yml` 插入**两行**：`feyagate-gateway`（插件本体）+ `feyagate-gateway-mcp`（官方桥，`serverName: feyagate`，`transport: streamable-http`，`url: http://127.0.0.1:<facadePort>/mcp`）。
- 门面端口由插件的 `apply()` 写进 `$DSH_HOME/dsh-feyagate/state.json` 的 `facade.port`；patch 用 `!!js` 表达式在 boot 时读该文件，**读不到就退化为 `38081`**（正好是首次启动的情形）。
- 门面行为：永远秒答 `initialize`；子进程未装/未起/升级中 → `tools/list` 返回**空表**（不报错）；子进程健康 → 代理 `tools/list`/`tools/call` 到子进程的 `/mcp/http`，并在就绪后发 `notifications/tools/list_changed`。
- 同时把 `toolCallTimeoutMs` 抬到 `180000`（默认 60000）：摄像头/视觉类调用合法地要几分钟（P2P 连接 + 抓拍 + VLM 往返）。
- 同时把桥的 `reconnect.maxAttempts` 抬到 `60`（默认 10）作为额外缓冲 —— 但这是**缓冲，不是解法**：门面在 `apply()` 里就起来，桥第一次连接就该成功。

## Consequences

**得到：**

- 子进程端口（含漂移）成为纯运行期细节：**改端口不需要重启 DSH**。
- "先开 DSH 再装服务"不再烧重连预算；用户点完安装，工具随 `list_changed` 出现。
- 升级窗口对模型零感知：门面短暂返回空表，进程换完再补齐，会话不中断。
- 不写 profile roster，与 `dsh plugin` 无双写冲突。

**付出：**

- 多一个常驻监听端口（`38081`）与一段需要自己实现的 MCP 协议子集（`initialize` / `tools/list` / `tools/call` / `notifications/tools/list_changed`）。
- 门面必须是**单点可信**：它挂了等于工具全挂。所以门面本身不做任何业务逻辑，只做转发与降级。
- 工具集换代要遵守桥的语义（整代替换、失败保留上一代），否则会出现"半个工具集"。

**已知口径不一致**：`maxAttempts` 被显式抬到 60 后，"预算约 2.5 分钟"这句叙述对**本 patch** 不再成立（60 次退避约 30 分钟）。门面的存在理由因此更偏向**约束 1（静态 YAML 端口）**；约束 2 是"没有门面时会在典型用户路径上必然踩到"的风险，而不是当前配置下的必然故障。

## Alternatives

### A. 桥直连子进程（静态端口）

patch 里写 `url: http://127.0.0.1:38080/mcp`，子进程端口固定不允许漂移。

- **否掉的原因**：约束 1 与约束 2 同时踩中 —— 端口一旦被占（例如用户还有一份既有的 `~/.feyagate` 安装，它默认也用 `38080`）就完全无解；且"装完插件才装服务"的路径上，桥的重连预算会先烧完，用户看到的是"插件坏了"。
- 保留价值：如果 `!!js` 读文件被证明不可行，这是**退化路径的一半** —— 但那时的形态是"门面端口固定 38081，改端口需重启 DSH"，仍然有门面。

### C. 运行期改写 profile roster 写端口

插件的 Host 代码在 `apply()` 里把子进程端口写进 profile 的 patch 文件。

- **否掉的原因**：`dsh plugin add/remove/update` 同样在写这份文件。两个写者、无锁、无合并语义 → 用户装第二个插件时可能丢掉端口写回，或反过来。**拒绝**，不进入候选。
- 更根本的问题：它把"运行期事实"刻进"构建期配置"，与约束 3（会打断 KV cache 前缀）同源 —— 任何运行期工具集变更对会话都是破坏性的。

### B. 插件自建 MCP 桥（不用官方桥）

插件自己 spawn、用 MCP client 库连子进程、用 `createMcpToolDefinition` 注册工具。

- **否掉的原因（当前）**：成本最高（要自己实现命名规范化含 sha256 冲突处理、工具集换代与回滚、图片结果的会话投影、超时与取消），而 A′ 已经用官方桥覆盖了相同的收益面。
- **触发条件（任一成立就必须换 B）**：
  1. 官方桥不再支持 `streamable-http`，或传输实现变化导致门面连不上；
  2. 桥的重连/换代语义变成"失败即关闭"或"半代工具集"，使"先空表后补齐"无法表达；
  3. 需要对工具做桥不支持的处理（按平台动态隐藏、参数改写、结果投影、多 server 聚合命名空间）；
  4. 需要桥不转发的会话级能力（sampling / roots / 进度通知）。
- 换 B 时本文所有门面行为（恒答 initialize、空表降级、就绪后换代）**保持不变**，只是把"官方桥指向门面"换成"插件桥指向门面"。

## 待验证

`cordis.patch.yml` 的 `!!js` 表达式依赖两条前提，**尚未实测**：

1. `!!js` 能读文件（`process.getBuiltinModule('node:fs')`）；
2. 入口行按顺序处理，且前一行的 `apply()` 已被 await（patch 注释如此断言）。

不成立时的处置：门面端口固定为 `38081`，"改门面端口需要重启 DSH"写进界面文案与 README 运维手册。
