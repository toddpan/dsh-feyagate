/**
 * Tuya QR authorization, adapted for a chat client.
 *
 * The upstream tool answers with a bare token (`tuyaSmart--qrLogin/?token=…`).
 * That is what a phone camera must *see* — as text in a chat bubble it is
 * useless, which is exactly how the authorization flow used to dead-end: the
 * user was told to scan something that was not on screen.
 *
 * So the plugin turns the token into two things a chat session can actually
 * use, without waiting for a new upstream release:
 *
 *   1. an image URL served by the plugin's own HTTP route (`qr.png`, plus a
 *      block-character `qr.txt` fallback for clients that render no images);
 *   2. a `chat_display` line the model can paste verbatim, and a `next_action`
 *      telling it to poll the status tool instead of asking "are you done?".
 *
 * Everything here is pure (paths and prose); the encoder lives in
 * `qr-image.ts` so the MCP facade never pulls a QR library into its path.
 */

/** The payload prefix the Tuya Smart app accepts for QR login. */
export const TUYA_QR_PREFIX = 'tuyaSmart--qrLogin/?token='

/**
 * 涂鸦 apigw 的「还没扫」答复不是 pending，而是一条 error：
 * `msg="Login failed, please scan and try again!"`。谁把它直接当终态，谁的
 * 二维码就会在生成几秒后显示「已失效」。按 msg 内容识别这条等待答复。
 */
export const TUYA_WAITING_MSG_RE = /scan\s*and\s*try\s*again/i

/** Plugin API prefix; the routes below hang off it. */
import { API_PREFIX } from './constants.js'

/**
 * Tokens are opaque alphanumeric strings from the Tuya cloud. The bound is a
 * safety net for a value that gets interpolated into a URL and rendered as a
 * QR code: reject anything that is not a plain token instead of encoding
 * arbitrary text into an image we then show as "the Tuya QR code".
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/

export function isTuyaToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

/** What the phone has to scan, exactly as the Tuya app expects it. */
export function tuyaQrPayload(token: string): string {
  return `${TUYA_QR_PREFIX}${token}`
}

/**
 * Relative image URL. Relative on purpose: the plugin is served by the same
 * web server as the chat page, so a root-relative path renders whether the user
 * is on `127.0.0.1:3080`, a LAN address, or a tunnel — an absolute
 * `http://127.0.0.1:3080/...` would break the moment the host is not localhost.
 */
export function tuyaQrImagePath(token: string): string {
  return `${API_PREFIX}/auth/tuya/qr.png?token=${encodeURIComponent(token)}`
}

/** Block-character fallback for clients that do not render images. */
export function tuyaQrTextPath(token: string): string {
  return `${API_PREFIX}/auth/tuya/qr.txt?token=${encodeURIComponent(token)}`
}

/**
 * The block the model should relay to the user.
 *
 * Written as instructions *to the model* because that is who reads it: the
 * tool result is the only channel the plugin owns, and the assistant message is
 * the only place a QR image can be rendered for the user to scan.
 */
export function tuyaQrChatDisplay(token: string, expireSeconds: number): string {
  const image = tuyaQrImagePath(token)
  const text = tuyaQrTextPath(token)
  return [
    `![涂鸦授权二维码](${image})`,
    '',
    '手机打开**涂鸦 App**（或智能生活 App）→ 右上角「+ / 扫一扫」→ 扫描上方二维码 → 在 App 里点「确认登录」。',
    `二维码 ${expireSeconds} 秒内有效；如果上方图片没有显示，用下面的地址打开，或取文本二维码：${text}`,
  ].join('\n')
}

/**
 * How to finish the flow without bothering the user.
 *
 * The status tool blocks (the facade long-polls upstream), so a model that
 * follows this needs a handful of calls at most — and never needs to ask the
 * user whether they scanned yet.
 */
export function tuyaQrNextAction(token: string, userCode: string): string {
  return [
    `立刻调用 auth/tuya_qr_status {token: "${token}", user_code: "${userCode}"}。`,
    '该工具会在服务端等待（每次最多约 35 秒）直到用户扫码或超时：',
    '返回 status="pending" 表示还没扫 —— 直接再调一次，不要问用户"扫好了吗"；',
    '返回 status="authorized" 表示成功 —— 告诉用户已登录，并可用 device_list 看新设备；',
    '连续多次 pending 且超过二维码有效期时，重新调用 auth/tuya_qr 生成新二维码。',
  ].join('\n')
}

/** Appended to the upstream tool descriptions so any model knows the contract. */
export const TUYA_QR_TOOL_NOTE =
  '\n\n【DSH 聊天内授权流程】本工具会返回 `chat_display`（一行 Markdown 图片）与 `qr_image_url`：' +
  '必须把 `chat_display` 原样放进给用户的回复里（DSH 会把它渲染成可扫的二维码），不要只把 token 贴给用户。' +
  '然后把用户的 user_code 与返回的 token 交给 auth/tuya_qr_status 轮询，直到 authorized；' +
  '整个过程不要反问用户"扫好了吗"。user_code 在涂鸦 App「我的 → 设置 → 账号与安全 → 用户代码」。'

export const TUYA_QR_STATUS_TOOL_NOTE =
  '\n\n【DSH 聊天内授权流程】本工具在服务端等待（每次最多约 35 秒），所以**不要**自己 sleep：' +
  '返回 status="pending" 就立刻再调一次，直到 status="authorized"（成功）或 success=false（token 失效，需重新 auth/tuya_qr）。' +
  '不要问用户"扫好了吗"。'
