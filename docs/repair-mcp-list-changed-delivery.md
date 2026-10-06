# 修复报告：AI 会话拿不到 `mcp__feyagate__*` 工具（门面工具列表送达）

> 现象：插件设置界面/后台服务一切正常，但 AI 会话里**一个** `mcp__feyagate__*` 工具都没有。
> 范围：`src/mcp/facade.ts` + 两个验证脚本。未改子进程二进制，未改桥的 `cordis.patch.yml`。

## 0. 结论速览

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| D1 | 门面**逐字转发**握手中的子进程响应，只对 `tools/list` 做修复。子进程回 `capabilities:{resources:{},tools:{}}`，**没有** `tools.listChanged` | SDK 静默跳过 `list_changed` 处理器 → 门面推的通知全被丢弃 | `repairHandshake`：按请求 id 给 `initialize` / `server/discover` 响应补 `tools.listChanged:true` |
| D2 | 门面把 `stream.write()` 当作送达：只要有流活着就 `clearListChangedPending()` 停手 | 客户端尚未装处理器 / 流属于被取代的 generation 时，一次被吞 = 本会话永久空表，且日志全绿 | `armListChangedReplay`：以**客户端自己重新 `tools/list`** 为唯一送达确认，未确认则每 5s 重发（最多 12 次），用尽则**明确告警** |

两个缺陷叠加成用户看到的样子：门面"已通知工具列表变化（1 个客户端流）"之后什么都没有。

## 1. 证据链（均可复核）

**线上日志** `~/.dsh/dsh-feyagate/logs/server.log`（UTC；本地 = UTC+8）：

```
11:52:07.287 [plugin] MCP 门面已就绪：http://127.0.0.1:38083/mcp
11:52:13.148 [plugin] warn: 转发到后台服务失败（端口 38080）：fetch failed   ← 子进程当时还没监听
11:52:13.704 [plugin] 后台服务就绪：v1.2.21，端口 38080
11:52:13.806 [plugin] 已通知工具列表变化（1 个客户端流）                     ← 通知"已送达"
11:54:09.635 [plugin] 已通知工具列表变化（1 个客户端流）                     ← 第二次
```

此后子进程只收到 `tools/list` 之外的请求；两次通知没有换来任何一次重新列举，**也没有任何报错**。
2026-09-25 之后 `~/.dsh/storages/session_projcache/sessions/` 里**没有任何会话**带 `mcp__feyagate__*` 工具名，而宿主与门面的长连接一直在（`lsof -nP -iTCP:38083` 有 `ESTABLISHED`）——即"服务已注册、工具数为 0"。

**SDK 侧（`@modelcontextprotocol/client@2.0.0`）**：

- 能力门控：`dist/index.mjs:3091` 注释 *"Handlers are silently skipped if the server doesn't advertise the corresponding listChanged capability."*，`:3095` 实际条件 `this._serverCapabilities?.tools?.listChanged`。
- 能力来源分两种：现代协议走 `server/discover`（`:3296` `this._serverCapabilities = result.discover.capabilities`），legacy 才读 `initialize`（`:3241`）。
- 桥侧：`@deepseek-ai/dsh-mcp-client/lib/index.js:602` 注册 `listChanged:{tools:{autoRefresh:false,onChanged→refreshTools}}`，`:632` `refreshTools()` 开头 `if (!isCurrent(generation)) return` —— 被取代的 generation 会**静默 return**。

子进程侧（`strings` 读预编译二进制）：服务端只写出 `initialize/tools/list/ping/notifications/initialized`，`capabilities` 下只有 `tools/resources`，全二进制唯一的 `listChanged` 出现在它**作为小智客户端**的代码里。⇒ 只要握手走转发路径，能力位必被覆盖。

## 2. 修复内容（`src/mcp/facade.ts`）

1. `handshakeRequests(body)`：把 `initialize` 与 `server/discover` 按 **id → method** 收集（原来只有 `requestsInitialize` 布尔判断）。
2. `repairHandshakeResult(payload, requests)`：只处理 id 命中的握手响应；只给**已存在**的 `tools` 对象补 `listChanged:true`；不凭空造 `tools`，不碰 `resources`/`prompts`。按 id 匹配修掉了批处理误报（同批 `tools/list` 响应没有 `capabilities`，原实现会误判为"结构不符合预期"）。
3. `repairHandshake()`：非 JSON / 无法解析 / 结构不符一律**原样透传 + warn**，与 `repairToolsList` 同纪律；成功则分别记 `已为 initialize…` / `已为 server/discover…`。
4. `pushToolsChanged()` + `armListChangedReplay()` + `noteToolsListConfirmed()`：推送后**不**清 pending；每 5s 重发一次。**唯一确认**是客户端自己的 `tools/list` **带着工具回来**——空表不算（空表正是它要修的状态，见 §4 已知边界 M1）；确认到达即停手并记 `客户端已重新列举工具（工具列表变化投递确认）`；12 次重发用尽（含首次推送共 13 帧）记 `已重发 12 次工具列表变化…但客户端始终没有列举出任何工具…`，可诊断而不是静默。
5. `deliverListChanged()` 不再自行清除 pending（`stream.write()` 只说明字节进了 socket）。
6. `openStream` 的健康补推改走 `pushToolsChanged()`，因此握手窗口期打开的那条流也会被重发覆盖。

**未做**（有意）：子进程未就绪时让 `tools/list` 有界等待。理由：与门面"服务未装也立即给合法空答复、不烧桥重连预算"的存在理由冲突；且一旦逼近 SDK 请求超时，会把一次**合法空答复**变成**超时错误**。D2 已让"通知被吞"可恢复，不需要再拿首帧去赌。

## 3. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 能力位（真 SDK 2.0.0 + 真门面 + 桩子进程） | `node scripts/verify-mcp-initialize-capability.mjs` | exit 0；修复前 exit 1（复现） |
| 送达确认 + 空表假确认 | `node scripts/verify-mcp-list-changed-ack.mjs` | exit 0（A1–A5）；修复前 A1 失败（`2 → 2`，无重发） |
| 类型 / 清单 / 补丁 / 冒烟 | `npm run typecheck`、`npm run check`、`node scripts/smoke.mjs --offline` | 0 / 24-24 / 19-19 |
| 监督权 / 涂鸦 / 平台鉴权 | `check-supervise-ownership`、`check-tuya-qr`、`check-platform-auth` | 10-10 / 26-26 / 55-55 |

`verify-mcp-list-changed-ack.mjs` 是 D2 的回归：A1 断言"客户端不重新 list 时必须重发"，A2/A5 断言"重新 list 拿到工具后必须停手"，A4 断言"空表 list 不算确认、重发必须继续"（A4/A5 是第二轮验收 M1 的回归）。修复前 A1 必然失败。

## 4. 诚实边界与生效条件

- **必须重启 DSH 宿主才生效**：宿主在启动时加载插件，运行期没有热替换接口。当前进程里仍是旧构建。
- 本次修复**不能**保证"任何失效形态都被覆盖"：若客户端对每一次重发都不重新 list（处理器从未装上），门面只能告警。此时证据在日志里（`已重发 12 次…`），而不是又一次静默空表。
- **M1（已修）**：确认必须"带着工具回来"，因此"客户端重新 list 但拿到空表"不再终止重发。同一条保守语义有**两个相邻形态**，都不掩盖原故障：
  - 确认后子进程**再次**掉线、且此后没有新的健康边沿时，客户端会停在空表上（子进程恢复必然产生健康边沿，届时重新推送）。此期间门面是**静默**的：空表不会把 pending 重新点亮（第三轮验收 §2.3 实测：0 帧、0 确认、0 告警）。
  - 网关**合法地一个工具都没有**时（全新安装 / 尚未授权任何平台），永远不会出现"带着工具回来"，于是烧完 12 次重发并打出终局告警；那三条诊断建议在此情形下都不适用（子进程如实回了 13 次空表）。功能无损（空表本来就是正确答案），代价是 13 次多余往返 + 一行过度告警。**不要**改成"空表即确认"——那会把 M1 原样退回。第三轮验收已测：活体网关 93 个工具，常见态不受影响。
- **M2（未修，已评估）**：确认是**全局**的，不区分客户端流。若同时有两个 MCP 客户端，A 的 `tools/list` 会替 B 确认掉。DSH 里桥只有一个（`cordis.patch.yml` 单行、单 `serverName`），当前不可达；改成按流确认需要把 pending/预算改为每流状态，本轮未做。
- **M3（未修，已评估）**：`server/discover` 的能力补全是**防御性**的，不是现网主线。当前子进程对 `server/discover` 回 `-32601`，SDK 必然回退 legacy 握手，所以线上走的是 `initialize`。而且现代时代（2026-07-28）即使能力补全也**不能端到端工作**：该时代的客户端要求 `tools/list` 带 `resultType`，而子进程不返回它（实测 `SdkError: Invalid result for tools/list: missing required resultType`）。要真正支持现代时代，得由子进程实现该协议修订，门面不应伪造。
- 复现用的桩子进程与真实 `miloco-mcp-server` 在能力位上一致（都用二进制字符串表交叉确认），但**没有**在运行中的宿主上重放过 11:52 那一跳的真实时序。

### 重启后的最小观测清单（只读）

1. `lsof -nP -iTCP:38083` → 新 pid `LISTEN` + 一对 `ESTABLISHED`（若出现多对，说明"单桥"前提被打破，见 §4 M2）。
2. **主判据**：`~/.dsh/dsh-feyagate/logs/server.log` 出现 `客户端已重新列举工具（工具列表变化投递确认）`。
   ⚠️ 注意：`已为 initialize 响应补上 tools.listChanged…` **只在握手中子进程已就绪时**才会出现——冷启动时桥先连上门面、子进程还没起来，那次 `initialize` 由 `localAnswer` 本地应答（该路径**直接**广告 `tools.listChanged:true`，但不走转发、因此不打修复日志）。**看不到那条不等于失败**，判定只认本条第 2 项与第 3 项。
3. 通知之后 5s 内子进程日志应新增 `[MCP] tools/list`；且出现 `客户端已重新列举工具（工具列表变化投递确认）`。
4. 新开 AI 会话可见 `mcp__feyagate__*`；或让 AI 调用一次，再看子进程侧 `[MCP] tools/call`。
5. 反例：只出现 `已通知工具列表变化（1 个客户端流）` 而长时间没有 `客户端已重新列举工具（…投递确认）` ⇒ 通知又被吞，看第 2 步是否真的出现了补能力的日志（若第 2 步也缺，检查握手响应里 `capabilities.tools.listChanged`）。
6. 另一种反例，别去查 `tools/list`：看到 `已重发 12 次工具列表变化（含首次推送共 13 帧）…` 告警、且该网关此刻**一个工具都没有**（未授权任何平台）⇒ 那是 §4 M1 的已知过度告警，不是本次故障。
