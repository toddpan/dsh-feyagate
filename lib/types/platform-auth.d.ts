/**
 * Platform authorization driven from the settings UI.
 *
 * Two upstream surfaces, negotiated rather than assumed:
 *
 *  * **MCP tools** — 涂鸦 `auth/tuya_qr`、美的 `auth/midea_login`、易微联
 *    `auth/ewelink_login`、米家 `xiaomi/auth_url` + `xiaomi/auth_callback`.
 *  * **MCP tools** for 华为's two-step login too (`auth/huawei_login` +
 *    `auth/huawei_challenge`) — verified against the desktop app's source, which
 *    drives exactly these tools. The child also serves `/api/v1/platform/huawei/*`
 *    over REST, but that is not what the desktop app calls, and it only exists in
 *    newer builds, so the REST surface is deliberately unused here.
 *
 * **Capabilities come from the child, never from this file.** The installed
 * macOS build (v1.2.19) has no 华为 tools at all — upstream added them in v1.2.20 —
 * so a hardcoded platform list would put buttons on screen that can only ever
 * fail. Upgrading the backend is all it takes for the 华为 card to light up.
 * `capabilities()` is what the UI renders from, and it reports the tools the
 * child actually advertises.
 *
 * **Credentials are pass-through.** They go to the child in a single request,
 * are never stored by the plugin, and are never written to the log buffer: the
 * log lines here name the platform and the outcome, never the input.
 */
import { type ChildApi } from './child-api.js';
import { type LogBuffer } from './log.js';
import type { AuthCapabilities, TuyaQrStatus, TuyaQrTicket } from './types.js';
/** The regions the child's `xiaomi/auth_url` accepts (its own enum). */
export declare const XIAOMI_REGIONS: readonly ["cn", "de", "i2", "ru", "sg", "us"];
/** Midea clouds: 美的美居 or MSmartHome. */
export declare const MIDEA_CLOUDS: readonly ["meiju", "msmart"];
/** An authorization failure carrying a user-facing message. */
export declare class PlatformAuthError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
/**
 * Pull the OAuth code out of whatever the user pasted.
 *
 * The child's `redirect_uri` is `https://127.0.0.1`, so after logging in the
 * browser lands on a page that cannot load and the code is only in the address
 * bar. Asking the user to extract it by hand is busywork (and a chance to
 * truncate it), so a full URL, a `?code=…` fragment and a bare code are all
 * accepted.
 */
export declare function extractXiaomiCode(input: string): string | null;
export interface PlatformAuthOptions {
    child: ChildApi;
    log: LogBuffer;
}
/** Outcome of a two-step (account → verification code) login. */
export interface ChallengeOutcome {
    authenticated: boolean;
    /** True when the platform now wants a verification code. */
    needCode: boolean;
    /** Platform-authored hint (e.g. where the code was sent), when it says. */
    challengeName: string | null;
    /**
     * The session survived even though a token exchange failed — the user must
     * **not** be asked for another code (see the Huawei notes in CLAUDE.md).
     */
    retryWithoutCode: boolean;
    message: string | null;
}
export declare class PlatformAuth {
    private readonly child;
    private readonly log;
    constructor(options: PlatformAuthOptions);
    /**
     * `ChildApi.callTool` with the child's failures translated into HTTP semantics.
     *
     * A child that is down is a 503 (the user must start it); anything else the
     * child says is shown verbatim as a 400, because in practice those messages
     * are the user's to fix (未登录 / 账号不存在 / 令牌过期).
     */
    private call;
    private translate;
    /**
     * What the running child can actually do.
     *
     * Tool names are filtered to the ones this UI drives, so the browser half can
     * gate each platform's actions on a positive answer instead of trying and
     * failing. Huawei is reported separately because its login is REST-only.
     */
    capabilities(): Promise<AuthCapabilities>;
    /**
     * Ask the child for a login QR and turn it into something the page can show.
     *
     * The child answers with the scanner payload and a token; the image URL is
     * this plugin's own route (see `api.ts`), because the child has no way to know
     * the URL the page is served from.
     */
    tuyaQr(userCodeInput: unknown): Promise<TuyaQrTicket>;
    /**
     * Wait for the user to scan, on the plugin's side.
     *
     * Same bargain as the chat flow: one request covers the user's scan instead of
     * the page polling forever, and the ceiling stays below the browser's own
     * patience. `timedOut` lets the page keep waiting without treating a slow user
     * as an error.
     */
    waitForTuyaStatus(tokenInput: unknown, userCodeInput: unknown): Promise<TuyaQrStatus>;
    /** 美的 account + password. Credentials never leave this call. */
    loginMidea(accountInput: unknown, passwordInput: unknown, cloudInput: unknown): Promise<Record<string, unknown>>;
    loginEwelink(emailInput: unknown, passwordInput: unknown, countryInput: unknown): Promise<Record<string, unknown>>;
    /** Step 1: the URL the user must open in a browser. */
    xiaomiAuthUrl(regionInput: unknown): Promise<Record<string, unknown>>;
    /** Step 2: exchange whatever the user pasted for a token. */
    xiaomiAuthCallback(input: unknown, regionInput: unknown): Promise<Record<string, unknown>>;
    /**
     * 华为 step 1. On a fresh account the upstream may answer with
     * `auth_status.pending_challenge`, which means a verification code is needed
     * (shown on an already-logged-in Huawei device — 华为 does not send SMS).
     */
    loginHuawei(accountInput: unknown, passwordInput: unknown): Promise<ChallengeOutcome>;
    /** 华为 step 2: the verification code. */
    huaweiChallenge(codeInput: unknown): Promise<ChallengeOutcome>;
    /**
     * Interpret the two upstream shapes.
     *
     * `auth/huawei_login` wraps everything in `auth_status`; `auth/huawei_challenge`
     * returns the provider's object at the top level. Both are read here so the two
     * signals that actually matter are never missed:
     *
     *  * `pending_challenge` → ask for the code (the desktop app reopens its dialog
     *    whenever a poll reports this, so a page refresh cannot lose the flow).
     *  * `retry_without_code` → the code was **accepted** and only the token
     *    exchange failed; the session is preserved, so asking for another code
     *    would burn one for nothing. (The desktop app misses this branch — see the
     *    migration notes — and shows a misleading "code is wrong".)
     */
    private huaweiOutcome;
    /**
     * Log out of one platform.
     *
     * 米家 is the odd one out: the child implements `XiaomiProvider::logout()`
     * but never exposes it (no tool, no route), so there is nothing honest to
     * call. Saying so beats a button that appears to work.
     */
    logout(platformId: string): Promise<{
        message: string | null;
    }>;
}
