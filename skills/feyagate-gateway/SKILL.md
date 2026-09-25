---
name: feyagate-gateway
description: FeyaGate（飞阳网关）智能家居工具集：通过 DSH 的 MCP 桥控制小米/涂鸦/美的/易微联/华为/Home Assistant 设备，看摄像头、跑场景与定时、配触发规则、查授权状态。当用户提到家里的灯/空调/窗帘/插座/摄像头/小爱音箱，或要求"打开客厅的灯""看看门口摄像头""每天 22 点关灯""有人进门就开灯"时使用。
version: 0.3.0
metadata:
  dsh:
    mcpServerName: feyagate
    toolCount: 76
    requires:
      service: 本机后台服务 miloco-mcp-server（由 dsh-feyagate-gateway 插件托管，落盘 ~/.dsh/dsh-feyagate）
    references:
      # 后台服务自己的完整 API 文档（76 个工具的逐个 schema 都在这里）。
      # 它不在本 npm 包里，在上游仓库：app/feyagate-skill-gh/FeyaGate_MCP_API.md
      - FeyaGate_MCP_API.md
---

> **这个文件解决什么问题**：教模型**正确地**用这 76 个智能家居工具 —— 什么时候用、参数名怎么拼（有一处 camelCase / snake_case 陷阱）、按什么顺序调用、四种常见错误怎么救。**不含**逐个工具的 schema。

# FeyaGate 智能家居工具

## 工具从哪来

这些工具由 DSH 的 MCP 桥（`serverName: feyagate`）提供，公开名形如 `mcp__feyagate__<规范化名>`。**以运行时 `tools/list` 的结果为准**：原始名里有 `/`（如 `device/list`），公开名会做函数名规范化。本文一律用**原始名**。

可选：`gateway/info` 看版本与端口；`auth/platforms` 看各平台登录状态。

## 什么时候用

| 用户想做的事 | 用哪类工具 | 代表工具 |
|---|---|---|
| 开/关/调节设备（灯、空调、窗帘、插座…） | 通用设备 + 平台控制 | `device/list`、`device/specs`、`set_*_device_property`、`execute_xiaomi_device_action` |
| 读设备当前状态 | 平台读工具 | `get_*_device_properties` |
| 看摄像头 / 抓拍 | 小米摄像头 | `xiaomi/camera_list`、`xiaomi/camera_connect`、`xiaomi/camera_snapshot` |
| 就着画面回答问题（视觉） | Vision AI | `xiaomi/camera_vision_chat`（需要授权版 + 配好 Vision） |
| 触发场景 | 小米场景 | `xiaomi/scene_list`、`xiaomi/scene_trigger` |
| 定时任务（"每天 22 点关灯"） | 定时 | `schedule/add`、`schedule/list`、`schedule/update`、`schedule/delete` |
| 让画面自动触发动作 | 触发规则 | `trigger/create`、`trigger/update`、`trigger/toggle`、`trigger/logs` |
| 长期记忆 | 记忆（走技能/记忆工具） | `skill/context`、`skill/list` |
| 技能包管理 | 技能 | `skill/list`、`skill/read`、`skill/create`、`skill/delete`、`skill/reload` |
| 授权与试用状态 | 授权查询 | `license/status`（写授权码用 `license/set`，清除用 `license/clear`） |
| 平台登录 / 退出 | 平台认证 | `xiaomi/auth_url` + `xiaomi/auth_callback`、`auth/tuya_qr`（见下方「涂鸦授权」）、`auth/midea_login`、`auth/ewelink_login` |
| 小爱音箱说话 / 放歌 | 小爱 | `xiaoai/tts`、`xiaoai/play_music`、`xiaoai/control` |
| 小智终端接入 | 小智 | `xiaozhi/list`、`xiaozhi/add`、`xiaozhi/remove` |
| 统计与用量 | 统计 | `stats/dashboard`、`stats/token_usage`、`stats/trigger_summary` |

## ⚠️ 参数命名陷阱（最容易出错的一条）

- **设备控制类**工具一律用 **camelCase `deviceId`**：`device/specs`、`get_*_device_properties`、`set_*_device_property`、`execute_*_action`。
- **只有 `xiaoai/*`**（`tts` / `control` / `play_music`）用 **snake_case `device_id`**。
- 摄像头工具用的是 **`camera_id`**（snake_case），不是 `deviceId`。
- 平台专属参数也用 camelCase：`siid`、`piid`、`piids`、`aiid`、`code`、`property`。

写错参数名的表现是 `-32602`（参数错误）或工具报缺参。

## 推荐调用顺序

```
device/list                    ← 先看有什么设备（可用 platform / filter 过滤）
      ↓
device/specs {deviceId}        ← 拿这台设备的平台、可用属性与动作
      ↓
识别平台（xiaomi / tuya / midea / ewelink / …）
      ↓
按平台调用：get_*_device_properties 读 → set_*_device_property 写
      ↓
（可选）按平台参考做法：涂鸦用 DP code、小米用 siid/piid、美的用 property 名
```

**永远不要在没调 `device/specs` 的情况下猜属性名**：同一台空调在不同平台的属性名与取值域完全不同。

典型流程（开客厅灯）：

```
device/list {filter: ["客厅", "灯"]}        → 拿到 deviceId
device/specs {deviceId}                     → 确认平台是 xiaomi、属性 piid
set_xiaomi_device_property {deviceId, siid: 2, piid: 1, value: true}
```

## 常见错误与应对

| 症状 | 含义 | 怎么办 |
|---|---|---|
## 先告诉用户：设置界面里可以点着登录

五家平台（米家 / 涂鸦 / 美的 / 易微联 / 华为）的登录**都能在设置页完成**：`设置 › 插件 › 飞阳网关 › 平台登录`，每家一张卡片（涂鸦直接显示二维码、米家是"拿授权地址 → 粘回回调地址"、美的/易微联是账号口令、华为是两步验证码）。

所以当用户只是想**把账号登进去**：

- **优先让他去那个标签页**（一句路径就够，别把工具调用步骤念给他听）——表单、二维码、扫码等待都在那里做好了；
- 只有用户**明确要求你代劳**（"你帮我登录"）或他已经在对话里给了凭据时，才按下面的流程调工具；
- 两条路调的是同一批工具，**不要**两边同时做（会出现两份并发登录）。

界面上能用到哪几家由后台服务自己的 `tools/list` 决定：本机 v1.2.19 没有华为工具，界面会如实写"本构建不支持"；升级后台服务到 v1.2.20 后卡片自动出现。用户报"华为卡片是灰的"时，让他去 `服务 › 升级与版本`，**不是**插件的问题。

---

## 涂鸦授权：在聊天里走完全流程

用户要授权涂鸦（或报「涂鸦未授权」）时，**不要**把 token 当文本贴给用户 —— 那是给手机摄像头扫的载荷，聊天里没有可扫的东西。按下面走：

1. 问用户要**用户代码**（只需一次）：涂鸦 App → 我的 → 设置 → 账号与安全 → 用户代码。
2. 调用 `auth/tuya_qr {user_code}`。返回体会多出几个字段，由插件（门面）注入：
   - `chat_display`：**一行 Markdown 图片**。把它**原样**放进你的回复里（DSH 会渲染成二维码），再补一句操作路径：涂鸦 App → 右上角「+ / 扫一扫」→ 扫这张码 → App 里点「确认登录」。
   - `qr_image_url` / `qr_text_url`：图片地址与方块字符版兜底；用户说看不到图时给 `qr_text_url`。
   - `user_code`、`next_action`：下一步要用的参数与动作，照做即可。
3. 调用 `auth/tuya_qr_status {token, user_code}` 轮询。**该工具在服务端等待（单次最多约 35 秒）**，所以：
   - 返回 `status:"pending"` → 立刻再调一次，**不要**自己 sleep，**不要**问用户「扫好了吗」；
   - 返回 `status:"authorized"` → 告诉用户已登录，可用 `device/list` 看设备（写操作需要授权版或有效试用，见 `license/status`）；
   - `success:false` 或 `status:"error"` → 二维码失效，重新 `auth/tuya_qr` 生成新码。
4. 用户给了错的用户代码时，上游回 `USERCODE_INCORRECT`（原样透传，插件不伪造二维码）—— 让用户回到 App 里核对用户代码，不要反复重试。

工具描述里也写了同样的契约（插件在 `tools/list` 时注入），所以即使没有这份文档，按工具描述做也是对的。

| `{"success": false, "error": "license_required"}` | 该平台的**写操作**需要授权或有效试用（涂鸦/美的/易微联的 90 天试用到期后） | **读操作仍然可用** —— 先告诉用户能看但不能控，并给出授权入口（`license/status` 查状态，`license/set` 写授权码）。不要反复重试写操作 |
| 设备在列表里但控制返回失败 | 设备**离线**（云端认为它不可达） | 用 `device/specs` 或平台的读取工具确认在线状态；建议用户在手机 App 里确认设备在线后重试 |
| `{"error": "当前平台不支持摄像头功能"}` | 摄像头功能在 **Windows** 上不可用（依赖米家 P2P 协议库，只支持 macOS / Linux） | 明确告知平台限制，不要改参数重试 |
| 摄像头连不上 | 米家未登录 / 设备离线 / 已连但未就绪 | 先 `xiaomi/auth_status` 看登录，再 `xiaomi/camera_list` 看在线与连接状态，最后 `xiaomi/camera_connect`；抓拍前必须已连接 |
| 华为设备**读得到、控制失败** | 华为云没有 REST 写通道，控制命令必须走消息中心 MQTT 长连接；通道未建立时控制必然失败 | 如实告诉用户"华为设备控制暂时不可用（命令通道未建立）"，建议在插件的**服务 › 日志与诊断**里看原因（常见：缺 `libmosquitto`）。**不要**把失败伪装成成功 |
| 平台工具报未登录 / 未授权（**具体错误串以运行时返回为准** —— `FeyaGate_MCP_API.md` 只给出通用的 `{"error": "..."}`） | 该平台 token 失效 | 先用 `auth/platforms` 与 `xiaomi/auth_status` 看状态，再引导用户重新登录该平台（小米走浏览器、涂鸦走二维码、美的/易微联走账号密码、华为走两步验证码 + **不发短信**提示）。登录动作本身由用户在界面完成，不要让模型索要密码 |
| `-32601` 方法不存在 / 工具名拼错 | 用了不存在的工具名或公开名与原始名混用 | 用 `tools/list` 拿准确名字；公开名带 `mcp__feyagate__` 前缀，调用时不要自己拼 |
| 摄像头/视觉调用超时 | P2P 连接 + 抓拍 + 模型往返**合法地要几分钟** | 桥的超时是 180 秒，不要因为几十秒没返回就放弃或重发 |
| 刚装/启动后台服务后，工具列表仍是空的 | 服务健康与桥的 SSE 流是两条独立时序，`tools/list_changed` 通知可能晚到 | 门面会自动补发（流建立时若服务已健康立即重发，暂无流时有界重试），最多等约 1 分钟即出工具，**无需重启 DSH**；若 1 分钟后仍为空，让用户在 设置 › 飞阳网关 › 服务 看状态条 |

## 不要做的事

- **优先让用户在界面里登录**，不要在聊天里索要或复述账号密码。注意 `auth/midea_login`（`account`/`password`）与 `auth/ewelink_login`（`email`/`password`）**确实是接受密码参数的工具** —— 只有用户明确要求你代为登录时才调用，且调用后不要在回复里回显密码。华为登录/验证码**不下发**为 MCP 工具，只能由用户在界面完成。
- **不要**在写操作失败时反复重试 —— 绝大多数写失败是"许可证不足"或"设备离线"，重试只会刷屏。
- **不要**在这里找 76 个工具的完整 schema：那在后台服务自己的 API 文档 `FeyaGate_MCP_API.md`（上游仓库 `app/feyagate-skill-gh/FeyaGate_MCP_API.md`，**不随本插件分发**）。本文件只讲调用姿势与陷阱。
- **不要**假设工具名不变：公开名由桥规范化，改动前后以 `tools/list` 为准。
