# 验证记录：AI 看不到 `mcp__feyagate__*` 工具的根因与修复

> **这个文件解决什么问题**：用户在真实机器上装好插件、后台服务也健康，但 DSH 会话里**一个 `mcp__feyagate__*` 工具都没有**（新建会话也一样）。这里记录根因、证据、修法与复现命令。

- **结论**：**不是**插件没装、也不是 MCP 桥没连上。是上游工具清单里有 **7 个零参数工具的 `inputSchema` 是 `{}`**（缺 `type: "object"`），DSH 的 MCP 客户端会**按 MCP 规范整体校验** `tools/list`，一抛错就**一个工具都不注册** —— 而服务在会话里仍然显示"已连接"，所以现象极像"没加载"。
- **修复位置**：`src/mcp/facade.ts`（门面），**不是**上游、也不是桥。
- **状态**：已修 + 已回归 + 已在真实子进程上端到端复验。

---

## 1. 症状

- 会话里搜不到 `mcp__feyagate__*`：当前会话、全新上下文的子代理、以及 `~/.dsh` 里所有会话的投影缓存，**都没有出现过任何 `mcp__feyagate__<工具名>`**。
- 服务侧一切正常：`/dsh-feyagate/status` → `state=running`、`healthy=true`、`currentVersion=1.2.19`、子进程有 pid。
- 门面侧也正常：直接 `POST /mcp` 问 `tools/list`，**返回 76 个工具**。
- 桥也确实连上了：宿主进程里能看到 `127.0.0.1:58225 → 127.0.0.1:38083 ESTABLISHED`。

**最容易误判的一点**：`list_mcp_resources(server="feyagate")` 成功返回（对照：另一个服务 `openviking` 报 `server is disconnected`）。于是看起来"服务是连着的"。但 **MCP 资源通道不校验工具 schema** —— 连接成功 ≠ 工具注册成功。

## 2. 根因链

1. 上游 `miloco-mcp-server` v1.2.19（及 v1.2.20）对**零参数工具**返回 `"inputSchema": {}`。真实清单里 76 个工具中有 **7 个**：

   `ewelink/refresh`、`midea/refresh`、`auth/tuya_logout`、`tuya/refresh`、`auth/midea_logout`、`auth/platforms`、`auth/ewelink_logout`

2. 门面（`src/mcp/facade.ts`）把子进程的 `tools/list` 响应**原样透传**给桥 —— 包括这份不合规的 schema。
3. DSH 的 `@deepseek-ai/dsh-mcp-client` 在 `syncTools()` 里先 `await client.listTools()`，客户端会拿 MCP 规范的 `ListToolsResult` 校验整份响应；**任一条不合规就整体抛错**，fetch 阶段直接中止。
4. 下游表现：`ctx.logger.error('mcp-client(feyagate): tool registration failed, no tools registered: …')`；`refreshTools()` 走同一条路也失败，保留旧的（0 个）工具代。
5. 于是**无论重启 DSH、还是新开会话都没用**：工具从来没进过 harness 的工具表。

用**同一个 SDK**（DSH 自带的 `@modelcontextprotocol/client`，与桥完全相同的选项）复现，抛错原文：

```
"path": ["tools", 56, "inputSchema", "type"]
"message": "Invalid input: expected \"object\""
```

用 SDK 导出的 `specTypeSchemas.ListToolsResult` 离线校验同一份响应：

| 被测对象 | 结果 |
|---|---|
| 上游原样 76 个工具 | ❌ 7 条违规，路径全是 `tools.N.inputSchema.type` |
| 给这 7 个补 `type:"object"` + 空 `properties` | ✅ **76/76 通过** |

## 3. 修法

门面是**对桥说话的那一方**，所以由它把契约补齐 —— 一处修复覆盖**所有已发布的上游版本**：

- `normalizedInputSchema(schema)`：`inputSchema` 不是对象 schema 时补 `type: "object"`；`properties` 不是对象时补 `{}`；**已经合规的 schema 一个字节都不改**（代理保持原样，不制造无谓 diff）。
- `repairToolsListResult(payload)`：只处理 `tools/list` 的 result（支持单条与批处理）；返回真正改动的数量。
- 接入点在 `McpFacade.proxy()`：请求体是 `tools/list` 时才对响应做归一化。**任何意外**（非 JSON 内容类型、响应无法解析）都**原样透传并记日志**，绝不猜测。
- 补齐时打一行明确日志：`已修正 N 个工具的 inputSchema（上游缺 type:"object"，不修会让桥丢掉全部工具）`。

设计取舍：`supportedOutputSchema`（对 outputSchema 的同类兜底）早已存在，缺的正是 inputSchema 的这一半 —— 这次补的是**同一类问题的另一半**，而不是给上游打补丁。

## 4. 验证证据

| 层级 | 证据 |
|---|---|
| 回归断言 | `scripts/smoke-install.mjs` 第 1 节：合成子进程里**故意**放一个 `inputSchema: {}` 的零参数工具（`auth/platforms`）。断言 ① 门面输出 `{"type":"object","properties":{}}` ② 已合规的 schema（`device/list`）**逐字节未被改写** ③ **同一时刻直连子进程拿到的仍是 `{}`**（对照，证明是门面修的，不是夹具修的） ④ 整份门面响应通过**真实 SDK** 的 `specTypeSchemas.ListToolsResult` 校验 |
| 测试总量 | `npm test` 全绿：**138 项**计数断言（24 补丁 + 5 下载 + 19 离线冒烟 + 90 安装生命周期） |
| 真机端到端 | 用**修复后的门面**接管**正在运行的真实子进程**（`pid` 文件接管，不 spawn / 不 kill），再用真实 SDK 客户端 `listTools()`：**76 个工具，无校验错误**；其中上游那 7 个零参数工具的 schema 已全部是对象 schema；同一时刻直连真实子进程仍是 **7 个不合规**（对照）。插件日志原文：`已修正 7 个工具的 inputSchema（上游缺 type:"object"，不修会让桥丢掉全部工具）` |

修复前对照：同一条 `listTools()` 路径抛 `Invalid input: expected "object"`（见 §2），因此"76 个工具"这个结果本身就是修复生效的证据。

## 5. 复现与自检命令

```bash
# ① 看上游真实清单里哪些工具的 inputSchema 不是对象 schema（直连子进程）
curl -s -X POST http://127.0.0.1:38080/mcp/http -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
| python3 -c "import json,sys;t=json.load(sys.stdin)['result']['tools'];bad=[x['name'] for x in t if x.get('inputSchema',{}).get('type')!='object'];print(len(t),'个工具，其中不合规:',bad)"

# ② 出门面再看一次：同一时刻应当是 0 个不合规
curl -s -X POST http://127.0.0.1:38081/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
| python3 -c "import json,sys;t=json.load(sys.stdin)['result']['tools'];bad=[x['name'] for x in t if x.get('inputSchema',{}).get('type')!='object'];print(len(t),'个工具，其中不合规:',bad)"

# ③ 插件日志里会出现一行“已修正 N 个工具的 inputSchema”
#    设置 › 飞阳网关 › 日志（或 GET /dsh-feyagate/logs）
```

## 6. 未覆盖 / 遗留

- **未在真实 DSH 宿主里复验过"修复后新会话能调用工具"**：门面的行为已用真实 SDK 客户端在真实子进程上验证（§4），但"桥注册 + 模型调用成功"这一步需要重启 DSH 后在会话里确认（宿主半侧代码在启动时加载）。
- 本修复**不改上游**：上游若继续返回 `{}`，门面每次都补 —— 代价可忽略（仅在 `tools/list` 上，且只改需要改的工具）。
- 排查过程中发现的两个**独立**问题（都已记录、按风险分级处理）：
  1. 多个 DSH 实例共享一个安装根 → 互杀循环。已给接管加 30 秒宽限，见 [ADR-0008](../docs/adr/0008-shared-install-root.md)。
  2. 上游 v1.2.20 的 mac-arm64 包**自身缺 4 个 dylib**（与本次无关，是打包缺陷）；v1.2.19 正常。
