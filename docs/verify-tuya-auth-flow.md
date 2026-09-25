# 验证记录：涂鸦平台授权在 DSH 聊天里走完全流程

**结论**：已实现并验证（2026-09-26）。上游只回一个 `token` 字符串，聊天里没有任何可扫的东西 —— 这条链在插件侧补齐：门面把 token 换成可渲染的二维码 + 明确的下一步，用户在聊天里扫码即可完成授权。

## 现象

用户在 DSH 里让模型授权涂鸦，得到的是这样的回复（原文摘录）：

> QR 码已生成！请在涂鸦 App 中扫码完成授权：
> 打开涂鸦 App / 进入 我的 → 设置 → 账号与安全 / 用 App 的扫码功能扫描下方 QR 码
> **QR 码地址：** `tuyaSmart--qrLogin/?token=AY1790336520041pvrdwArwkBAhKuUicmqseTEcFo179033682004103`
> 扫码完成后告诉我，我来确认授权状态。

"下方 QR 码"下面并没有二维码 —— 用户无法操作。这段话是**模型自己拼的**：上游工具返回的对象里只有 `qr_url` / `token`（见下），模型没有别的可展示物。

## 根因

1. `miloco-mcp-server` 的 `auth/tuya_qr`（`src/platform/tuya_provider.cpp::get_qr_code`）返回 `{success, qr_url, token, expire_time}`，其中 `qr_url` 是**给手机摄像头扫的载荷**，不是可点击的网址，也不是图片。
2. MCP 工具结果一路原样透传到模型（`result.content[0].text` 里是 JSON 字符串），插件此前**只做 `tools/list` 的 schema 归一化**，不动工具结果。
3. 于是模型手上只有一串文本，只能写"请扫描下方二维码"。

> 顺带澄清一个容易误判的点：`mcp_tools.cpp` 里那份 `excluded` 列表（含 `auth/tuya_qr`）只作用于 **桥给小智（语音端）** 的 `bridge_tools_to_xiaozhi`；DSH 侧这两个工具一直是暴露的（本次会话的 `tools/list` 里就有 `mcp__feyagate__auth_tuya_qr`）。所以问题不是"工具不可用"，而是"结果不可用"。

## 设计：三层，全在插件里

放在插件而不是上游，是因为①插件是**对聊天客户端说话的那一侧**，聊天专有的表达（Markdown 图片、别反问用户）不该塞进桌面端共享的工具描述里；②改上游要重新编译/发布闭源子进程，而门面一处适配**覆盖所有已发布版本**（与 `inputSchema` 那次修复同一逻辑）。

| 层 | 位置 | 做什么 |
| --- | --- | --- |
| ① 出图 | `src/qr-image.ts` + `src/api.ts` | `GET /dsh-feyagate/auth/tuya/qr.png?token=…` 返回 640×640（EC-M）二维码 PNG；`…/qr.txt?token=…` 返回**方块字符版**兜底。两者都先校验 token 形状（`^[A-Za-z0-9_-]{8,256}$`），非法即 400；响应 `no-store`（图里带凭据） |
| ② 适配工具结果 | `src/mcp/facade.ts` | `tools/call` 命中 `auth/tuya_qr` 且 `success:true` 时，往同一个 JSON 里**追加** `chat_display`（一行可以直接贴给用户的 Markdown 图片）、`qr_image_url`、`qr_text_url`、`user_code`（回显调用参数）、`next_action`。原有字段一个不动 |
| ③ 写入工具描述 | `src/mcp/facade.ts` | `tools/list` 时为这两个工具追加「DSH 聊天内授权流程」说明：把 `chat_display` 原样贴进回复、之后用 token+user_code 轮询状态、**不要反问用户"扫好了吗"**。写进描述而不是只写在结果里，是为了让**任何**模型（不只是本次会话）都知道该怎么做 |

### 为什么服务端长轮询

状态查询 `auth/tuya_qr_status` 由模型发起，但"扫完了吗"是**用户**决定的。若让模型自己 `sleep` + 反复调用，一次扫码会变成十几轮对话。所以门面替它等：单次客户端调用最多阻塞 **35 秒**，其间每 2 秒向上游重问一次，用户一扫到就立刻返回。

- 35 秒的选择：MCP 桥的单次工具调用超时是 **60 秒**（`dsh-mcp-client` 的 `DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4`），门面自身转发超时 180 秒 —— 留足余量，慢用户也不会被截断。
- 超时按 `pending` 返回（而不是报错），并附一句"立即再调一次，不要反问用户"，所以慢用户的体验是"再等一轮"，而不是失败。

## 证据

### 一、`scripts/check-tuya-qr.mjs`：26/26

关键项不是"产生了 PNG"，而是**能被独立解码器读回**（`jsqr`，与本插件用的编码器无关）：

| 断言 | 结果 |
| --- | --- |
| 用独立解码器读回 PNG，内容 === `tuyaSmart--qrLogin/?token=…` | ✅ |
| 文本兜底二维码同样能被独立解码器读回（把方块字符还原成位图再解） | ✅ |
| 路由 `GET …/qr.png` 返回的图片解码后仍是同一个 token（**端到端闭环**） | ✅ |
| 不同 token 生成不同图片；非法 token（空/过短/含空格/中文/超长/`../`）一律拒绝 | ✅ |
| `chat_display` 是根相对路径的 Markdown 图片（换主机/隧道也能渲染），含 App 操作路径与文本兜底地址 | ✅ |
| 非法 token 走路由 → 400 + JSON 错误信封 | ✅ |

顺带抓到一个真实缺陷：`qrcode` 的 `utf8` 渲染器用 `margin / 2` 喂 `Array()`，**奇数 margin 会 `RangeError: Invalid array length`** —— 文本兜底最初就是这么崩的，现用 `margin: 2`。

### 二、安装生命周期冒烟：99/99（新增 9 项）

假子进程里加了 `auth/tuya_qr` / `auth/tuya_qr_status` 与一个调用计数器：

| 断言 | 结果 |
| --- | --- |
| 门面给两个工具都补上了「DSH 聊天内授权流程」说明 | ✅ |
| `auth/tuya_qr` 经门面返回 `chat_display`，且指向 `/dsh-feyagate/auth/tuya/qr.png?token=FAKEQRTOKEN1234567` | ✅ |
| 返回体自带 `user_code` 与 `next_action`（模型不必自己拼） | ✅ |
| 上游原有字段（`token`、`expire_time`）仍在 —— **只加不改** | ✅ |
| **（对照）直连子进程**：同一个调用没有 `chat_display`，只有 bare token | ✅ |
| 门面替模型轮询：一次调用就等到 `authorized`；子进程侧计数 **≥ 3**（前两次 `pending` 被等过去了） | ✅ |
| 授权成功后附「token 已保存 / 可用 device_list」的说明 | ✅ |

### 三、真机（真实子进程）

真实 `miloco-mcp-server 1.2.19`（端口 38080）的 `auth/tuya_qr` 返回结构确认：

```console
$ curl -s -X POST http://127.0.0.1:38080/mcp/http -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"auth/tuya_qr","arguments":{"user_code":"000000"}}}'
{"id":1,"jsonrpc":"2.0","result":{"content":[{"text":"{\"code\":\"USERCODE_INCORRECT\",\"error\":\"User Code Incorrect\",\"success\":false}","type":"text"}]}}
```

两件事同时被证实：①结果结构就是适配层假设的 `result.content[0].text`（JSON 字符串）；②`success:false` 时门面**原样透传、不伪造二维码**（`tuyaQrExtras` 只在 `success === true` 时动手）。

## 复现（不需要 DSH）

```bash
cd app/dsh-feyagate && npm install && npm run build
node scripts/check-tuya-qr.mjs            # 26 项，含真实解码回环
node scripts/smoke-install.mjs            # 99 项，含门面适配与长轮询
```

单独看一张真机二维码（把 `<token>` 换成 `auth/tuya_qr` 返回的 token，需插件在跑）：

```bash
curl -s 'http://127.0.0.1:3080/dsh-feyagate/auth/tuya/qr.png?token=<token>' -o /tmp/qr.png
open /tmp/qr.png        # 手机对着屏幕扫
```

## 剩余缺口（诚实声明）

1. **真机 happy path 未跑通一次完整扫码**：需要用户涂鸦 App 里的**真实 user_code**（`我的 → 设置 → 账号与安全 → 用户代码`）。解析层的正确性由真机探针 + 假子进程覆盖；真机上只验证到"错误分支不伪造"，成功分支需要一次真人扫码。
2. **依赖模型把 `chat_display` 贴进回复**：插件能保证"工具结果里有可渲染的图片行 + 工具描述里写清了必须贴"，但不能强制模型照做。兜底：`qr.txt` 文本二维码路由（任何客户端都能显示），以及"用浏览器打开 qr.png 地址"。
3. **二维码图里带着 300 秒有效的凭据**：路由只接受合法 token 形状、只编码涂鸦登录载荷、不缓存，但同一台机器上任何页面仍可在有效期内拉取该图片。这是"本机服务"的既有假设（与 `/status`、`/logs` 同为 GET 无 Origin 校验），不是本次新增的暴露面。
4. 上游工具文案（那句英文 `User Code Incorrect`）未翻译未包装 —— 属打磨项，模型能读懂。

## 相关

- [ADR-0005](adr/0005-plugin-self-upgrade.md)（插件自升级）、[ADR-0002](adr/0002-install-directory.md)（安装目录）
- [verify-mcp-inputschema-fix.md](verify-mcp-inputschema-fix.md)：同一层（门面）的另一次适配，起因同为上游与聊天客户端之间的形状差异
- 依赖变化：新增运行时依赖 `qrcode`（MIT，纯 JS，含 `pngjs`）；测试用 `jsqr`（Apache-2.0）、`pngjs`（MIT），见 [NOTICE](../NOTICE)
