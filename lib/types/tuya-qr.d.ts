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
export declare const TUYA_QR_PREFIX = "tuyaSmart--qrLogin/?token=";
/**
 * 涂鸦 apigw 的「还没扫」答复不是 pending，而是一条 error：
 * `msg="Login failed, please scan and try again!"`。谁把它直接当终态，谁的
 * 二维码就会在生成几秒后显示「已失效」。按 msg 内容识别这条等待答复。
 */
export declare const TUYA_WAITING_MSG_RE: RegExp;
export declare function isTuyaToken(token: string): boolean;
/** What the phone has to scan, exactly as the Tuya app expects it. */
export declare function tuyaQrPayload(token: string): string;
/**
 * Relative image URL. Relative on purpose: the plugin is served by the same
 * web server as the chat page, so a root-relative path renders whether the user
 * is on `127.0.0.1:3080`, a LAN address, or a tunnel — an absolute
 * `http://127.0.0.1:3080/...` would break the moment the host is not localhost.
 */
export declare function tuyaQrImagePath(token: string): string;
/** Block-character fallback for clients that do not render images. */
export declare function tuyaQrTextPath(token: string): string;
/**
 * The block the model should relay to the user.
 *
 * Written as instructions *to the model* because that is who reads it: the
 * tool result is the only channel the plugin owns, and the assistant message is
 * the only place a QR image can be rendered for the user to scan.
 */
export declare function tuyaQrChatDisplay(token: string, expireSeconds: number): string;
/**
 * How to finish the flow without bothering the user.
 *
 * The status tool blocks (the facade long-polls upstream), so a model that
 * follows this needs a handful of calls at most — and never needs to ask the
 * user whether they scanned yet.
 */
export declare function tuyaQrNextAction(token: string, userCode: string): string;
/** Appended to the upstream tool descriptions so any model knows the contract. */
export declare const TUYA_QR_TOOL_NOTE: string;
export declare const TUYA_QR_STATUS_TOOL_NOTE: string;
