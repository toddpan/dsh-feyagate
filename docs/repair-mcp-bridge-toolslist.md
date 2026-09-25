# 修复说明：MCP 桥工具列表不可用（无需重启 DSH）

> 交付：t5（integration round 1） · 2025-09
> 汇总 t1 需求分析 → t2 实现 → t3 验证 → t4 审查四个任务的全部结论。
> 相关文档：[设计文档](design-mcp-bridge-toolslist-fix.md) · [验证报告](verify-mcp-bridge-toolslist.md)

## 1. 改了什么

只改了 4 个文件（源码 2 + 文档 2），**未动** `cordis.patch.yml`、`supervisor`、桥（`@deepseek-ai/dsh-mcp-client`）与 SDK：

| 文件 | 改动 |
|---|---|
| `src/mcp/facade.ts` | ① `FacadeOptions` 新增必填 `isChildHealthy`（健康探测注入）；② `openStream` 改 async：流建立后若子进程已健康或存在未送达通知，**立即补发** `tools/list_changed`；③ `notifyToolsChanged` 拆出 `deliverListChanged()`，投递数为 0 时置 `listChangedPending` 并有界重发（5s/次、上限 12 次 ≈ 60s，定时器 `unref`）；④ 公开 `clearListChangedPending()` 重置重试预算；⑤ `stop()` 清理定时器与 pending，无 dangling |
| `src/runtime.ts` | ① 构造门面时注入 `isChildHealthy: () => supervisor.healthy()`；② 健康**下降**沿（healthy→unhealthy）调 `clearListChangedPending()`，避免陈旧通知误投、并让下一次健康边沿重新计预算 |
| `README.md` | 三条要点第 1 条、MCP 接入特性行、故障排查表：说明 `list_changed` 最终送达（补发 + 有界重发），装/启动服务后**无需重启 DSH** |
| `skills/feyagate-gateway/SKILL.md` | 常见错误表新增「刚装/启动后台服务后工具列表暂空」行：等约 1 分钟门面自动送达，无需重启 |

## 2. 为什么这样修

**根因**（t1 逐行定位）：facade 把工具列表变化建模成**一次性 fire-and-forget** 通知——`notifyToolsChanged` 无 pending 状态、`openStream` 不检查子进程健康；而桥侧 `StreamableHTTPClientTransport` 只在 `connect()` 时开一次 GET SSE 流、从不重开流、从不主动重发 `tools/list`，只被动等 `list_changed` 触发 re-sync。两端无状态对账，「子进程 healthy 边沿」与「桥 SSE 流建立」两个独立时序**错过一次即本会话永久空表**，只能重启 DSH。

**修法**（architect 推荐方案 A+B，排除 D、C 留作可选保险）：把 facade 从「发一次」升级为「**最终送达**」——

- **A（openStream 补发）**：流建立时若子进程已健康，立刻发一次 `list_changed`。覆盖「服务先健康、桥后连」时序。幂等（桥收到只 re-sync，重复无害）。
- **B（pending 有界重发）**：通知发出时无流可投 → 置 pending，5s/次重试直到某条流收到或 12 次上限（≈60s）自停并打日志。覆盖「healthy 边沿早于所有流」时序。
- **childPort 读 effectivePort 即健康**：supervisor 只在 `/health` 通过后才把 `effectivePort` 写进 `state.json`（`stop()` 置 null），故门面每请求读到端口时子进程必然健康，无需改读取逻辑；`cordis.patch.yml` 的 url 读的是 `facade.port`（门面端口），本属正确设计，排除嫌疑。

## 3. 如何验证

**两条核心时序的端到端验证**（t3，真实 node 进程：构建产物 `lib/index.js` 的 `apply()` 真门面 + 假 miloco 子进程被 supervisor 真 spawn + 按 SDK 行为建模的 fake 桥），复现脚本：

- `scripts/verify-bridge-timing-1.mjs`（时序 1：子进程先健康、桥后开流）——**PASS 10/10**。桥开 SSE 流后 ~205ms 收到 `list_changed`，re-sync 拿到 3 个真实工具；全程单一 `apply()`，无 DSH 重启。
- `scripts/verify-bridge-timing-2.mjs`（时序 2：桥先开流、子进程后健康，即 team goal 核心故障）——**PASS 14/14**。桥初始 `tools/list` 空表 → `/service/start` 拉起子进程触发 healthy 边沿 → 桥流收到 `list_changed` → re-sync 拿到 3 个工具；无重启。

**回归**（t3 + t4 各自独立复跑，t5 再复跑一次）：

| 命令 | 结果 |
|---|---|
| `npm run build` | ✅ 构建成功（lib/index.js + lib/client.js） |
| `npm run typecheck` | ✅ exit 0 |
| `npm run check:manifest` | ✅ 6 个版本，0 警告 |
| `npm run check:patch` | ✅ 24/24（含 toolCallTimeoutMs 180000 校验） |
| `npm run smoke -- --offline` | ✅ 19/19 |

**审查结论**（t4，verdict=pass，无 blocker/medium/low）：76 工具代理路径与 180s `PROXY_TIMEOUT_MS` 逐行未动；补发/重发无环、无风暴（最坏 12 次/60s 有界）；未健康不发空通知、探针抛错按不健康处理、await 期间流断开靠 `streams.has(res)` 门控；定时器全 `unref`、`stop()` 清理无 dangling；`cordis.patch.yml` 零改动、url 表达式与 `start()` 持久化顺序不变。

## 4. 用户侧影响

- **装服务后无需重启 DSH**：先启动 DSH 再点「安装后台服务」，或 DSH 已运行中把服务拉起来，桥最多等约 1 分钟即自动 re-sync 出 `mcp__feyagate__*` 工具，不再需要重启。
- **改子进程端口后无需重启 DSH**：端口每请求从 `state.json` 读 `effectivePort`，自动漂移即生效。
- 行为不变：76 个工具、`mcp__feyagate__` 命名、180s 调用超时、桥指向门面（升级窗口对模型零感知）全部保持。
- 唯一残留（非阻断，见 t3 未验证项）：方案 C 的 30s 周期最终保险未实现；子进程崩溃→watchdog 重启→再健康的 e2e 未覆盖（建议后续补），但该路径由 healthy 边沿 + pending 逻辑同样覆盖。
