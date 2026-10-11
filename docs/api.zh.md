# FeyaGate 开放接口文档（MCP / HTTP）

> **这个文件解决什么问题**：把飞阳网关在本机暴露的两个接口面 —— **MCP 接口**与
> **HTTP 接口** —— 的地址、协议行为、全部端点、发现方式和安全边界写成一页，
> 让你不用读插件源码就能把设备能力接进**其它 AI 客户端**或**自己的程序**。
>
> 设置页「开放接口」标签页里的地址按本机实时端口拼出，是**交互版**的本文档；
> 两处内容保持同步，发现不一致以代码为准并在
> [Issues](https://github.com/toddpan/dsh-feyagate/issues) 反馈。

---

## 0. 两个接口面，一屏看完

| 接口面 | 地址 | 传输 | 适合谁 |
|---|---|---|---|
| **MCP 门面**（推荐） | `http://127.0.0.1:<门面端口>/mcp` | MCP Streamable HTTP | 所有支持 MCP 的 AI 客户端（Claude Desktop、Cherry Studio、Cline、Cursor、自研 Agent …） |
| **HTTP 接口** | `http://127.0.0.1:<服务端口>/…` | 普通 HTTP（REST + JSON-RPC） | 程序、脚本、Home Assistant、自研集成 |

两个端口都是**本机回环**地址，不设鉴权；都可能因为端口被占而**向上漂移**，
实际值按 §4 的方式读取，不要照抄本文档示例里的端口号。

```
其它 AI 客户端 ──MCP──► MCP 门面 :<facadePort>/mcp ──代理──► 后台服务 :<childPort>
你的程序/脚本 ──HTTP──► 后台服务 :<childPort>/api/v1/… · /mcp/http
（MCP 门面由插件托管，随 DSH 常驻；后台服务由插件安装、守护与升级）
```

---

## 1. 快速开始：三步接入 AI 客户端

1. DSH 侧栏「设置 → 飞阳网关 → 服务」，确认后台服务已安装且状态条显示 ● 运行中。
2. 打开「飞阳网关 → 开放接口」，复制 **MCP 地址**（默认 `http://127.0.0.1:38081/mcp`）。
3. 在你的 AI 客户端里「添加 MCP 服务器」，传输类型选 **Streamable HTTP**，粘贴地址保存即可；
   客户端刷新工具列表后就能看到全部网关工具。

通用 `mcpServers` 配置片段（多数客户端通用）：

```json
{
  "mcpServers": {
    "feyagate": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:38081/mcp"
    }
  }
}
```

> 不同客户端对 `type` 的拼写略有差异（`streamableHttp` / `streamable-http` / `http`，
> 个别客户端允许省略）；**URL 不变**。以你的客户端文档为准。

---

## 2. MCP 接口

### 2.1 基本信息

- **URL**：`http://127.0.0.1:<门面端口>/mcp`（`/mcp/http` 与之等价，任选其一）
- **协议版本**：`2025-03-26`（`initialize` / `server/discover` 均可握手）
- **绑定**：仅 `127.0.0.1`，无鉴权（回环即信任）
- **默认端口**：`38081`，被占用时自动顺延（扫描 20 个）
- **工具名**：直连时即上游原始名（`device/list`、`xiaomi/set_property`、`auth/tuya_qr` …）。
  在 DSH 聊天里经官方桥接会加 `mcp__feyagate__` 前缀，直连没有。
- **工具数量**：以上游构建为准（v1.2.x 为 76 个），以 `tools/list` 返回为准。

### 2.2 协议行为（接入前值得知道）

| 行为 | 说明 |
|---|---|
| 秒答握手 | `initialize` / `server/discover` 由门面即时应答，并广告 `tools.listChanged: true` |
| 未运行不拒连 | 后台服务未安装 / 未启动时连接**依然成功**：`tools/list` 返回空表，`tools/call` 返回明确错误（JSON-RPC `-32000`） |
| 工具热上线 | 服务转健康后门面通过 SSE 推送 `notifications/tools/list_changed`，客户端**无需重连**即可拿到完整工具列表（带边界重发直到客户端重新列举） |
| Schema 兼容 | 门面会把上游缺失 `type:"object"` 的零参数工具 `inputSchema` 修正为合法对象 schema，严格客户端不会整表拒收 |
| 涂鸦长轮询 | `auth/tuya_qr_status` 在门面内做服务端等待（单次最多 35 秒），扫码流程不会被一次网关 5xx 打断 |
| 慢工具预算 | 摄像头 / Vision AI 类调用转发超时 180 秒 |

### 2.3 用 curl 直接调（验证连通性）

```bash
# ① 握手
curl -X POST "http://127.0.0.1:38081/mcp" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"demo\",\"version\":\"0.0.1\"}}}"

# ② 列工具
curl -X POST "http://127.0.0.1:38081/mcp" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"

# ③ 调一个工具（列出设备，filter 为关键词数组）
curl -X POST "http://127.0.0.1:38081/mcp" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"device/list\",\"arguments\":{\"filter\":[\"客厅\"]}}}"
```

`GET /mcp`（需 `Accept: text/event-stream`）是服务器→客户端的 SSE 通道，承载
`tools/list_changed` 通知；`DELETE /mcp` 结束会话（门面无会话状态，回 204）。
一般客户端 SDK 会自己管理这两条，手写集成只需要 `POST`。

---

## 3. HTTP 接口

### 3.1 基本信息

- **Base URL**：`http://127.0.0.1:<服务端口>`（默认 `38080`，可漂移；实际值按 §4 读取）
- **响应包络**：REST 统一为 `{"code": 0, "data": …, "message": "…"}`；**`code = 0` 表示成功**，
  非 0 为业务失败（此时看 `message`）。`/health` 除外（MCP 风格的裸响应）。
- 这套 REST 路由与官方桌面 App 同源同形，属于**受支持接口**而非实现细节。

### 3.2 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查：进程活着、MCP 就绪 |
| GET | `/api/v1/gateway/info` | 网关信息：名称、版本、平台、设备标识、摄像头能力 |
| GET | `/api/v1/gateway/license` | 授权状态与各平台可用能力（试用期、宽限期） |
| POST | `/api/v1/gateway/license` | 写入并激活授权码 |
| DELETE | `/api/v1/gateway/license` | 清除授权码，恢复免费版 |
| POST | `/api/v1/platform/xiaomi/logout` | 米家账号退出登录（v1.2.21 起提供） |
| POST | `/mcp/http` | MCP over HTTP（JSON-RPC：`tools/list`、`tools/call`、`initialize`） |

### 3.3 请求示例

```bash
# 网关信息
curl "http://127.0.0.1:38080/api/v1/gateway/info"

# 授权与平台能力
curl "http://127.0.0.1:38080/api/v1/gateway/license"

# 激活授权码
curl -X POST "http://127.0.0.1:38080/api/v1/gateway/license" \
  -H "Content-Type: application/json" \
  -d "{\"license_key\":\"FG-XXXX-XXXX-XXXX\"}"

# 恢复免费版
curl -X DELETE "http://127.0.0.1:38080/api/v1/gateway/license"

# 米家退出登录
curl -X POST "http://127.0.0.1:38080/api/v1/platform/xiaomi/logout"

# MCP（与 §2.3 等价，直连后台服务）
curl -X POST "http://127.0.0.1:38080/mcp/http" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

### 3.4 响应示例

`GET /api/v1/gateway/info`（省略部分字段）：

```json
{
  "code": 0,
  "data": {
    "name": "FeyaGate Gateway",
    "version": "1.2.21",
    "platform": "win-x64",
    "device_id": "FG-DEV-…",
    "camera_supported": true,
    "license": { "edition": "free", "status": "active", "product": "feyagate-linux" }
  }
}
```

`POST /mcp/http` 的 `tools/call` 返回 MCP 标准结构，工具结果在
`result.content[0].text` 里，通常是一段字符串化 JSON：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "[{\"deviceId\":123,\"name\":\"客厅灯\",\"online\":true}]" }]
  }
}
```

---

## 4. 端口发现（两个端口都可能漂移）

按可靠程度排序：

1. **插件管理 API**（DSH Web 服务的端口，即你浏览器里 DSH 页面地址栏上的那个端口）：

   ```bash
   curl "http://127.0.0.1:<DSH Web 端口>/dsh-feyagate/health"
   # → { "ok": true, "data": { "facadePort": 38081, "childPort": 38080, … } }
   ```

   一次拿到两个端口；后台服务未运行时 `childPort` 为 `null`。

2. **state.json**（插件安装根目录下）：

   ```bash
   cat ~/.dsh/dsh-feyagate/state.json
   # → { "facade": { "port": 38081 }, "server": { "effectivePort": 38080, … }, … }
   ```

   `$DSH_HOME`（默认 `~/.dsh`）下的 `dsh-feyagate/state.json`；
   `facade.port` 是 MCP 门面端口，`server.effectivePort` 是后台服务实际端口
   （`null` = 未运行）。配置里的 `serverPort` 只是**期望值**，端口被占时会顺延。

---

## 5. 插件管理 API（`/dsh-feyagate/*`）

DSH Web 服务同源前缀下的管理接口，设置页自己就在用它；第三方集成一般用不到，
列出供参考：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-feyagate/health` | 插件自检：`facadePort` / `childPort` / 平台 / 版本 |
| GET | `/dsh-feyagate/status` | 完整运行状态（安装、健康、端口、版本、兼容区间） |
| GET | `/dsh-feyagate/logs?since=&limit=` | 插件与后台服务合并日志 |
| GET | `/dsh-feyagate/install/catalog` | 可安装版本清单（含 sha256） |
| POST | `/dsh-feyagate/install` · `/install/rollback` · `/install/uninstall` | 安装 / 回滚 / 卸载（长任务，见 `/jobs/current`） |
| POST | `/dsh-feyagate/service/start|stop|restart` | 启停后台服务 |
| GET | `/dsh-feyagate/account/overview` | 平台登录状态、授权、摄像头总览 |
| PUT | `/dsh-feyagate/settings` | 保存插件设置 |

> **写保护**：所有非 GET 请求做同源校验——浏览器跨站 `fetch` 会带 `Origin` 头，
> 与 `Host` 不一致即 403（防 CSRF）；curl / 脚本不带 `Origin`，直接放行。
> JSON 写请求还要求 `Content-Type: application/json`。

---

## 6. 安全须知

- **只监听回环**。MCP 门面固定绑 `127.0.0.1`；后台服务默认也只监听本机
  （设置页可改为 `0.0.0.0`，会把**无鉴权**的接口和平台 token 暴露给整个局域网，不建议）。
- **没有鉴权层**。"回环即信任"是这两个接口面的安全模型。要远程接入，请用
  SSH 隧道（`ssh -L 38081:127.0.0.1:38081 …`）或带鉴权的反向代理，不要直接开放端口。
- **没有 CORS 头**。浏览器里的网页**无法**直接 `fetch` 这两个地址（跨域被拦）——这是
  刻意的，顺带挡住了恶意页面对本机网关的调用。请从服务端、桌面程序或脚本调用。
- **数据边界**。网关的 `data/` 目录存着各平台登录 token 与授权绑定；任何"分享日志/
  配置求助"的场景都不要带上这个目录。

---

## 7. 常见问题

| 现象 | 原因与处理 |
|---|---|
| MCP 连接成功但 `tools/list` 是空的 | 后台服务未安装 / 未启动。门面刻意"秒答握手 + 空表"以保护客户端重连预算；到设置页「服务」装好并启动后，工具会经 `list_changed` 自动补上（客户端无需重连） |
| 昨天还好好的地址今天连不上 | 端口漂移：首选端口被其它进程占用，门面/服务自动顺延。按 §4 重新读取实际端口 |
| `tools/call` 返回 `-32000 FeyaGate 后台服务未运行` | 同上：连接还活着，但网关本体不在。启动后台服务即可 |
| 调用长时间无响应 | 摄像头取流 / Vision AI 类工具本身慢（门面转发预算 180 秒）；请把客户端超时放宽到 3 分钟以上 |
| 网页里 `fetch` 报 CORS 错误 | 有意为之，见 §6；改从你自己的服务端调用 |
| 想在别的机器上用 | 不要改监听地址；用 SSH 隧道或带鉴权的反代（见 §6） |

---

## 8. 变更记录

- **0.3.x（本文档初版）**：整理 MCP 门面与后台服务 HTTP 接口面向第三方开放；
  设置页新增「开放接口」标签页（MCP 地址与接入片段、HTTP 端点速查与 curl、
  文档入口），接口行为与本文档同步。
