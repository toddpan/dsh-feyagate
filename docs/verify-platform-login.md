# 验证：设置界面里的五个平台登录

> **这个文件解决什么问题**：设置页新增的「平台登录」标签要动**明文凭据**，所以"能登录"不足以交付。这里列出实际验证了哪些边界、用什么证据、以及哪些路径**没有**被验证。设计理由见 [ADR-0009](adr/0009-platform-login-in-settings-page.md)。

## 一句话

**`node scripts/check-platform-auth.mjs` 54/54 通过**（真实 API handler + 假子进程，MCP 与"连接被拒"两条路径都覆盖），并用只读探针在**真实子进程 v1.2.19** 上复核了能力协商与错误透传，过程中未改动用户的任何登录态。

```bash
npm run build && node scripts/check-platform-auth.mjs
```

## 这个功能真正难在哪

1. **能力是子进程给的，不是插件写死的。** 本机装的 `miloco-mcp-server` 是 **v1.2.19**（`lsof` 与 `state.json` 双证），`tools/list` 里**一个华为工具都没有**，`/api/v1/platform/*` 全部 404。华为三个工具（`auth/huawei_login` / `auth/huawei_challenge` / `auth/huawei_logout`）与 REST 那套都是 **v1.2.20** 才有的。写死平台清单 = 给用户一个必然失败的按钮。
2. **凭据会顺手漏出去。** 最自然的实现（把请求体写进调试日志、把失败上下文塞进日志缓冲、把响应原样回给前端）都会让密码出现在用户可见的地方。日志缓冲本身是设置页里的一个标签页。
3. **两种失败长得一样。** 华为"验证码已通过、只是换 HMS-Lite 令牌失败"（`retry_without_code: true`）与"验证码错了"都是 `{success:false, error:…}`；不按 `retry_without_code` 分流，用户会白费一个验证码（这个坑上游 Android 已修、桌面端 `grep retry_without_code` 零命中、仍未修）。
4. **授权过期与密码错误长得很像。** 登录类工具受授权门禁（`license_access.cpp` 按平台子串匹配），过期时子进程用 `isError` + `{error:'capability_denied'}` 回答。不翻译就等于告诉用户"密码错了"。

## 实现（三个层次，都不硬编码上游）

| 层 | 文件 | 做什么 |
|---|---|---|
| 宿主适配 | `src/platform-auth.ts` | 类 `PlatformAuth`：`capabilities()` 用子进程 `tools/list` 求交集；`tuyaQr` / `waitForTuyaStatus`（服务端长轮询）/ `loginMidea` / `loginEwelink` / `xiaomiAuthUrl` / `xiaomiAuthCallback`（自己从粘贴内容里抠 `code`）/ `loginHuawei` / `huaweiChallenge`（读 `pending_challenge` 与 `retry_without_code`）/ `logout`；错误统一成 `PlatformAuthError{status}` |
| 同源 API | `src/api.ts` | 10 条路由（`/auth/capabilities`、`/auth/tuya/{qr,status}`、`/auth/{midea,ewelink}/login`、`/auth/xiaomi/{url,callback}`、`/auth/huawei/{login,challenge}`、`/auth/logout`），全部走现存 `checkOrigin`；`PlatformAuthError.status` 直接映射 HTTP 码（400 输入/上游拒绝、403 授权门禁、501 上游没有这个接口、502 协议异常、503 服务没起） |
| 界面 | `src/client/index.tsx` 的 `LoginPanel` | 六张卡片（概览 + 五家），能力缺失时显示"本构建不支持"并写明缺什么；涂鸦显示二维码并等扫码、美的/易微联是账号口令表单、米家是"拿地址 → 粘回调"、华为是两步验证码并在 `retry_without_code` 时明说"无需重新输入" |

## 断言清单（`scripts/check-platform-auth.mjs`，54 项）

| 区 | 关键断言 |
|---|---|
| 能力协商 | `childReachable`、工具清单**只保留 13 个**本 UI 驱动的授权工具（`device/list` 被过滤）、华为走 MCP 的判断、平台状态复用 `auth/platforms` |
| 涂鸦 | 生成二维码返回 `payloadUrl` / 根相对 `imageUrl` / `textUrl` / 有效期；**用户代码不对 → 400 且没有 `data`**（绝不伪造二维码）；错误文案含"去哪找用户代码"且保留上游原文；**一次 `POST /auth/tuya/status` 就等到 `authorized`**，且上游确实被问了 ≥2 次 |
| 美的 / 易微联 | 登录成功回报设备数；密码错 → 400；缺字段 → 400；云端/国家码非法**在本插件门口就挡下**（不给子进程乱传） |
| 米家 | 授权地址；未知区域 400；**粘整段回调 URL → 子进程收到的是抠出来的 `code`**；只粘 code 也接受；没有 code → 可操作的 400；code 被上游拒绝 → 400 |
| 华为 | 直接成功 / 需要验证码两条；`challenge_name` 带到界面；**`retry_without_code` 返回 200 + `retryWithoutCode:true` 且带上游 `hint`**；真·验证码错 → 400；确实走 MCP 工具 |
| 退出登录 | 涂鸦/美的/易微联/华为 200；**米家 501 并说明"上游没有暴露该接口"**；未知平台 404、缺参数 400 |
| 凭据边界 | **密码不出现在**：插件日志缓冲、`state.json`、`/logs` 响应、`/account/overview` 响应；**其他 Origin 的登录请求 403**（退出登录同样） |
| 服务未运行 | `capabilities` 如实报不可达；登录返回 **503 且提示"请先在「服务」标签里启动"** |
| 授权门禁 | `capability_denied` → **403 + "当前授权不允许…去授权标签看试用"**（不是"密码错了"） |

## 真机探针输出（v1.2.19，2026-09-26）

只读探针：用真实 `GatewayRuntime` + 真实 API handler，`state.json` 指向**正在运行的**子进程（pid 3933），不 spawn、不 kill。

```
[1] 能力协商: 可达 true | 授权工具 10 个: auth/ewelink_login auth/midea_login auth/tuya_logout
    auth/tuya_qr_status auth/midea_logout auth/platforms xiaomi/auth_url auth/ewelink_logout
    xiaomi/auth_callback auth/tuya_qr
[2] 华为在 v1.2.19 自动缺席: ✅ 卡片显示"本构建不支持"
[3] 平台状态: 米家✓ 涂鸦✗ 美的✗ 易微联✗
[4] 米家真实授权地址: ✅ 已生成（未打开浏览器）
[5] 涂鸦假用户代码: ✅ 400 原样透传、不伪造二维码
    文案: 用户代码不正确：请在涂鸦 App「我的 → 设置 → 账号与安全 → 用户代码」核对后重试。
          （上游：User Code Incorrect · USERCODE_INCORRECT）
[6] 非法区域挡在门口: ✅
[7] 米家退出如实说明: ✅ 501（上游确无该接口）
[8] 缺字段/错误处理不崩: ✅
[9] 真实后台服务 + 用户米家登录未被扰动: ✅ pid 3933 健康，米家仍已登录
```

## 没有覆盖的（如实声明）

- **真实的三条登录链没有真跑过**：涂鸦需要真实用户代码并真的用手机扫码；美的/易微联需要真实账号口令；华为在 v1.2.19 上根本不存在。这三条只在假子进程上验证了协议与文案。**未验证的是"上游协议形状是否仍如源码所写"**，不是插件逻辑。
- **界面本身没有在真实 GUI 里点过**：`Client` bundle 已构建（`lib/client.js`，83 KB，只 require 两个平台种子模块），逻辑与 API 契约在测试里覆盖，但"标签页长什么样、二维码图片在浏览器里显示是否正确"需要在重启 DSH 后人工看一眼。
- **授权门禁只在假子进程上触发过**：真机当前是免费版 + 试用期内，`auth/tuya_qr` 返回的是 `USERCODE_INCORRECT`（不是 `capability_denied`），所以 403 那条分支没有真实环境证据。
- **`bindAddress=0.0.0.0` 下的登录**未验证，且**不建议**：登录功能的前提就是只绑回环（见 ADR-0009）。
