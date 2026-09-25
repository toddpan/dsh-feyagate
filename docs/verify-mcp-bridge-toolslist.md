# 验证报告：MCP 桥工具列表可靠送达（无需重启 DSH）

> 任务：t3（verification round 1） · 验证对象：t2 按方案 A+B 实现的 MCP 门面修复
> 验证者：verifier · 日期：2025-09
> 范围：`app/dsh-feyagate/scripts/**`（两个端到端时序脚本）+ 现有回归（typecheck / check:manifest / check:patch / smoke --offline）

## 0. 结论速览

| 验证项 | 结果 | 关键证据 |
|---|---|---|
| 时序 1：子进程先健康、桥后开流（场景 B） | **PASS 10/10** | 桥 GET 流在开流后 ~205ms 收到 `list_changed`，re-sync 拿到 3 个真实工具；全程单一 `apply()`（无 DSH 重启） |
| 时序 2：桥先开流、子进程后健康（场景 C） | **PASS 14/14** | 桥初始 `tools/list` 空表 → `/service/start` 拉起子进程（健康边沿）→ 桥 GET 流收到 `list_changed` → re-sync 拿到 3 个真实工具；全程无重启 |
| 回归 `npm run typecheck` | **PASS** | exit 0 |
| 回归 `npm run check:manifest` | **PASS** | 清单 ok：6 个版本，0 警告 |
| 回归 `npm run check:patch` | **PASS** | 24/24 |
| 回归 `npm run smoke -- --offline` | **PASS** | 19/19 |

**两种核心时序都通过**：桥无需重启 DSH 即可拿到非空工具列表。修复（方案 A：`openStream` 健康补发 + 方案 B：`listChangedPending` 有界重发）在两条时序下都让 `list_changed` 可靠送达。

---

## 1. 验证方法（全部真实 node 进程，不用 mock 的 facade/子进程逻辑）

每个脚本由三个真实部件组成：

1. **真插件 + 真 facade**：加载构建产物 `lib/index.js` 的 `apply()`，与 DSH 宿主加载插件的路径完全一致（fake Cordis ctx → `startFacade` 绑定门面并写 `state.json` → `startService` 不 await）。门面端口、`/mcp` 路由、SSE 流、`list_changed` 投递都是修复后的真实实现。
2. **真子进程**：安装目录 `versions/9.9.9-verify/miloco-mcp-server` 放一个可执行 node 脚本（假 miloco），实现真实契约 `/health`（200 `{status:ok}`）+ `/mcp/http`（JSON-RPC `initialize`/`tools/list`/`ping`）。由 supervisor 真正 spawn、`waitForHealthy` 判定健康、写 `effectivePort`。
3. **真桥客户端**：按 `@deepseek-ai/dsh-mcp-client` 的 `StreamableHTTPClientTransport` 关键行为建模——`connect()` 发 `initialize` + 一次初始 `tools/list` + 开**一次** GET SSE 流；之后**只在**收到 `notifications/tools/list_changed` 时才 re-sync `tools/list`，**从不**自己重开流、**从不**主动重发 `tools/list`。这正是「错过一次 `list_changed` = 本会话永久空表」的桥侧约束。

两个脚本的差异只在「谁先就绪」：
- 时序 1：`autoStart=true`，`apply()` 里 `startService` 自动把子进程拉健康（healthy 边沿早于桥 connect）；桥后连。
- 时序 2：`autoStart=false`，桥先 connect（此时子进程未运行 → 初始 `tools/list` 空表、开 SSE 流）；随后 `POST /service/start` 让 supervisor 拉起子进程（healthy 边沿晚于桥流建立）。

---

## 2. 时序 1 —— 子进程先健康、桥后开流（场景 B）

脚本：`app/dsh-feyagate/scripts/verify-bridge-timing-1.mjs`
复现步骤：
1. 安装假 miloco 可执行文件；`state.json` 预写 `currentVersion`、`autoStart=true`、空闲 `server.port`。
2. `apply()` → 门面绑定（`facade.port=38084`）；`startService` 自动 spawn 假子进程 → `/health` 通过 → `effectivePort` 写入 → **healthy 上升沿**触发 `notifyToolsChanged`（此刻桥流数 0 → 落空 → pending）。
3. 桥此时才 `connect()`：`initialize` + 初始 `tools/list`（门面已代理到子进程）+ 开 GET SSE 流。
4. `openStream` 探测 `isChildHealthy()=true` → **立即补发** `list_changed`；或 pending 有界重发兜底。

实际输出：
```
== 时序验证 1：子进程先健康、桥后开流（场景 B）==
  ✓ 安装目录放入假 miloco 可执行文件
  ✓ apply() 后 state.json 记录门面端口
  ✓ 门面端口已落盘（桥 url 表达式读它）  facade.port=38084
  ✓ T1：子进程被 supervisor spawn 并通过 /health（effectivePort 写入）  effectivePort=60953
  ✓ T1′：healthy 边沿发生在桥 connect 之前（流数为 0，通知落空 → pending）
  ✓ T1 复核：子进程健康时门面 tools/list 已代理到真实非空  3 个
  · 桥 connect 完成（4 ms），初始工具 3 个
  ✓ T2：桥的 GET 流收到 list_changed（openStream 补发 / pending 重放）  收到 1 次，开流后耗时 205 ms
  ✓ 桥 re-sync 后工具列表非空  3 个工具
  ✓ 桥拿到的工具与子进程真实工具一致  gateway/info, devices/list, device/control
  ✓ 全程未重启 DSH（单一 apply()）

  桥事件序列：[["initialize","200"],["tools/list","3 tools"],["open-sse","GET /mcp"],["list-changed","#1"],["tools/list","3 tools"]]
== 结果：10/10 通过 ==
```

判定：**PASS**。关键断言——桥的 GET 流收到 `list_changed`（`list-changed #1`）且 re-sync 后 `tools/list` 非空（3 个）——全部满足；桥事件序列证明「初始同步 → 开流 → 收到 list_changed → re-sync」的完整闭环，无需重启。

---

## 3. 时序 2 —— 桥先开流、子进程后健康（场景 C）

脚本：`app/dsh-feyagate/scripts/verify-bridge-timing-2.mjs`
复现步骤：
1. 安装假 miloco；`state.json` 预写 `currentVersion`、`autoStart=false`、`effectivePort=null`。
2. `apply()` → 门面绑定；`startService` 因 `autoStart=false` 不拉起子进程。
3. 桥先 `connect()`：`initialize` + 初始 `tools/list`（子进程未运行 → 门面本地应答 `{tools:[]}` 空表）+ 开 GET SSE 流（流已在 facade 集合里）。
4. `autoStart=true` → `POST /service/start` → `startService` → `ensureStarted` → supervisor spawn 假子进程 → `/health` 通过 → **healthy 上升沿** → `notifyToolsChanged`（此刻桥流已在集合里 → 送达）。

实际输出：
```
== 时序验证 2：桥先开流、子进程后健康（场景 C）==
  ✓ 安装目录放入假 miloco 可执行文件
  ✓ state.json 预写 autoStart=false（startService 不自动拉起子进程）
  ✓ apply() 后 state.json 记录门面端口
  ✓ 门面端口已落盘（桥 url 表达式读它）  facade.port=38084
  · 桥 connect 完成（9 ms），初始工具 0 个
  ✓ T1：桥初始 tools/list 拿到空表（子进程未运行，门面本地应答）  0 个
  ✓ T1′：桥已打开 GET SSE 流（流已在 facade 集合里）
  ✓ T2′：autoStart=true（让 /service/start 触发 supervisor spawn）
  ✓ T2″：拿到插件 API 路由（用于触发 /service/start）
  ✓ POST /service/start 接受任务  HTTP 200
  ✓ T2：/service/start 后子进程被 supervisor 拉起并通过 /health  端口 63573
  ✓ T2：桥的 GET 流收到 list_changed（健康边沿送达 / openStream 补发 / pending 重放）  收到 1 次
  ✓ 桥 re-sync 后工具列表非空  3 个工具
  ✓ 桥拿到的工具与子进程真实工具一致  gateway/info, devices/list, device/control
  ✓ 全程未重启 DSH（单一 apply()）

  桥事件序列：[["initialize","200"],["tools/list","0 tools"],["open-sse","GET /mcp"],["list-changed","#1"],["tools/list","3 tools"]]
== 结果：14/14 通过 ==
```

判定：**PASS**。这条是 team goal 所述「桥连上空表 + healthy 边沿晚于桥流」的核心故障时序：初始空表（`tools/list 0 tools`）→ 子进程后健康 → 桥流收到 `list_changed` → re-sync 到 3 个工具。桥事件序列证明「空表起步、靠一次 `list_changed` 补全」的完整闭环，全程无 DSH 重启。

---

## 4. 回归验证

| 命令 | 结果 | 证据 |
|---|---|---|
| `cd app/dsh-feyagate && npm run typecheck` | **PASS** | exit 0（tsc -p tsconfig.json --noEmit） |
| `cd app/dsh-feyagate && npm run check:manifest` | **PASS** | 清单 ok：6 个版本（1.2.15 … 1.2.20），0 警告 |
| `cd app/dsh-feyagate && npm run check:patch` | **PASS** | 24/24 通过（patch 结构、桥指向门面、重连预算等） |
| `cd app/dsh-feyagate && npm run smoke -- --offline` | **PASS** | 19/19 通过（apply → 门面 initialize/空表/202 → HTTP API status/settings/catalog → 卸载后门面停止） |

回归全部通过，说明 t2 的改动（`facade.ts` + `runtime.ts`）没有破坏既有的「未装服务时门面行为」「API 路由」「patch 结构」等约束。

---

## 5. 说明与边界

- **验证的是「送达」语义**：两个脚本都断言「桥收到 `list_changed` 且 re-sync 后 `tools/list` 非空」。这正是 team goal 的验收标准「桥无需重启 DSH 即可拿到非空工具列表」。
- **桥侧行为建模**：fake 桥严格复刻 SDK 的关键约束（只开一次 GET 流、只被动等 `list_changed`、不主动重列）。若真实 `dsh-mcp-client` 行为有细微差异，送达逻辑（facade 侧）不受影响——facade 的补发/重放是自治的，不依赖桥主动行为。
- **子进程是假二进制**：用 node 脚本模拟 miloco 的 `/health` + `/mcp/http` 契约，避免依赖真实 ~10MB 下载。这不影响对「facade 如何送达 `list_changed`」的验证，因为送达路径（SSE 流 + `list_changed` + 桥 re-sync）与子进程返回什么工具无关。
- **`childPort` 读到 `effectivePort` 时子进程健康**：两个脚本都确认 `effectivePort` 仅在 supervisor `/health` 通过后写入（时序 1 的 `T1`、时序 2 的 `T2` 断言），符合 t1 的分析（§2.4 澄清：现状已满足，无需改 `cordis.patch.yml`）。
- **未验证项（非本次范围）**：方案 C（30s 周期兜底）未实现也未测；子进程崩溃→watchdog 重启→再健康的回归路径未在 e2e 中覆盖（属 §5.4 回归清单，建议后续补）。

## 6. 交付物

- `app/dsh-feyagate/scripts/verify-bridge-timing-1.mjs` — 时序 1 e2e（场景 B）
- `app/dsh-feyagate/scripts/verify-bridge-timing-2.mjs` — 时序 2 e2e（场景 C）
- 本报告

两个脚本均可独立运行：`node scripts/verify-bridge-timing-1.mjs [--keep]` / `node scripts/verify-bridge-timing-2.mjs [--keep]`（`--keep` 保留临时目录供检查）。
