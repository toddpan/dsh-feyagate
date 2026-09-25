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

import { TUYA_STATUS_LONG_POLL_MS, TUYA_STATUS_POLL_INTERVAL_MS } from './constants.js'
import { type ChildApi } from './child-api.js'
import { type LogBuffer } from './log.js'
import { isTuyaToken, tuyaQrImagePath, tuyaQrPayload, tuyaQrTextPath } from './tuya-qr.js'
import type { AuthCapabilities, TuyaQrStatus, TuyaQrTicket } from './types.js'

/** The regions the child's `xiaomi/auth_url` accepts (its own enum). */
export const XIAOMI_REGIONS = ['cn', 'de', 'i2', 'ru', 'sg', 'us'] as const

/** Midea clouds: 美的美居 or MSmartHome. */
export const MIDEA_CLOUDS = ['meiju', 'msmart'] as const

/** Auth tools this UI knows how to drive, per platform. */
const KNOWN_AUTH_TOOLS = [
  'auth/platforms',
  'auth/tuya_qr',
  'auth/tuya_qr_status',
  'auth/tuya_logout',
  'auth/midea_login',
  'auth/midea_logout',
  'auth/ewelink_login',
  'auth/ewelink_logout',
  'xiaomi/auth_url',
  'xiaomi/auth_callback',
  'auth/huawei_login',
  'auth/huawei_challenge',
  'auth/huawei_logout',
] as const

/** An authorization failure carrying a user-facing message. */
export class PlatformAuthError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'PlatformAuthError'
    this.status = status
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/**
 * The child's own failure message for a tool call, or null when it succeeded.
 *
 * Auth tools signal failure as `{success:false, error|code}`, and the shapes
 * vary a little per platform, so every plausible field is read before falling
 * back to a generic sentence.
 */
function toolFailure(payload: unknown, fallback: string): string | null {
  const record = asRecord(payload)
  if (record.success === true && record.error === undefined) return null
  if (record.success === undefined && record.error === undefined && record.code === undefined) return null
  const parts = [str(record.error), str(record.message), str(record.code)].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : fallback
}

/** A trimmed, required string field, or a user-facing complaint. */
function requireField(value: unknown, label: string): string {
  const text = str(value)
  if (text === null) throw new PlatformAuthError(`请填写${label}`)
  return text
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
export function extractXiaomiCode(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  const fromQuery = /[?&]code=([^&\s#]+)/.exec(text)
  if (fromQuery !== null) {
    try {
      return decodeURIComponent(fromQuery[1])
    } catch {
      return fromQuery[1]
    }
  }
  // A bare code has no scheme, no path separator and no query string.
  if (!text.includes('=') && !text.includes('/') && !text.includes(' ')) return text
  return null
}

export interface PlatformAuthOptions {
  child: ChildApi
  log: LogBuffer
}

/** Outcome of a two-step (account → verification code) login. */
export interface ChallengeOutcome {
  authenticated: boolean
  /** True when the platform now wants a verification code. */
  needCode: boolean
  /** Platform-authored hint (e.g. where the code was sent), when it says. */
  challengeName: string | null
  /**
   * The session survived even though a token exchange failed — the user must
   * **not** be asked for another code (see the Huawei notes in CLAUDE.md).
   */
  retryWithoutCode: boolean
  message: string | null
}

export class PlatformAuth {
  private readonly child: ChildApi
  private readonly log: LogBuffer

  constructor(options: PlatformAuthOptions) {
    this.child = options.child
    this.log = options.log
  }

  /**
   * `ChildApi.callTool` with the child's failures translated into HTTP semantics.
   *
   * A child that is down is a 503 (the user must start it); anything else the
   * child says is shown verbatim as a 400, because in practice those messages
   * are the user's to fix (未登录 / 账号不存在 / 令牌过期).
   */
  private async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return await this.child.callTool(name, args)
    } catch (error) {
      throw this.translate(error, `调用 ${name}`)
    }
  }

  private translate(error: unknown, what: string): PlatformAuthError {
    const message = (error as Error).message ?? String(error)
    // The child being gone shows up two ways: the port is unset, or it is set
    // and the connection is refused. Both mean "start the service", not "your
    // input was wrong".
    const cause = (error as { cause?: { code?: string } }).cause
    if (
      message === '后台服务未运行' ||
      /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed/i.test(message) ||
      cause?.code === 'ECONNREFUSED'
    ) {
      return new PlatformAuthError('后台服务未运行（连接被拒绝）：请先在「服务」标签里启动', 503)
    }
    // Login tools are gated by the license: on a lapsed trial the child answers
    // `{error:'capability_denied'}` wrapped in `isError`, which `callTool` turns
    // into a thrown JSON string. "平台被授权锁住" and "密码错了" need different
    // words, or the user retypes a correct password forever.
    let denied: string | null = null
    if (message.includes('capability_denied')) {
      try {
        const parsed = asRecord(JSON.parse(message) as unknown)
        denied = str(parsed.message) ?? str(parsed.error)
      } catch {
        denied = 'upstream returned capability_denied'
      }
    }
    if (denied !== null) {
      return new PlatformAuthError(`当前授权不允许这个平台的登录操作：${denied}。请在「授权」标签里查看试用/授权状态（免费版各平台有 90 天试用）。`, 403)
    }
    return new PlatformAuthError(`${what}失败：${message}`)
  }

  /**
   * What the running child can actually do.
   *
   * Tool names are filtered to the ones this UI drives, so the browser half can
   * gate each platform's actions on a positive answer instead of trying and
   * failing. Huawei is reported separately because its login is REST-only.
   */
  async capabilities(): Promise<AuthCapabilities> {
    const tools = await this.child.toolNames()
    const platforms = await this.child.platforms()
    return {
      childReachable: tools !== null,
      tools: tools === null ? [] : tools.filter((name) => (KNOWN_AUTH_TOOLS as readonly string[]).includes(name)),
      platforms,
    }
  }

  // ─────────────────────────────────────────────────────────────── 涂鸦 (QR)

  /**
   * Ask the child for a login QR and turn it into something the page can show.
   *
   * The child answers with the scanner payload and a token; the image URL is
   * this plugin's own route (see `api.ts`), because the child has no way to know
   * the URL the page is served from.
   */
  async tuyaQr(userCodeInput: unknown): Promise<TuyaQrTicket> {
    const userCode = requireField(userCodeInput, '涂鸦 App 里的用户代码')
    const payload = await this.call('auth/tuya_qr', { user_code: userCode })
    const record = asRecord(payload)
    if (record.success !== true) {
      const detail = toolFailure(payload, '上游没有返回二维码')
      // `USERCODE_INCORRECT` is by far the most common answer; say what to do.
      const hint = record.code === 'USERCODE_INCORRECT' ? '用户代码不正确：请在涂鸦 App「我的 → 设置 → 账号与安全 → 用户代码」核对后重试。' : null
      throw new PlatformAuthError(hint === null ? `生成二维码失败：${detail}` : `${hint}（上游：${detail}）`)
    }
    const token = str(record.token) ?? str(record.token_id)
    if (token === null || !isTuyaToken(token)) {
      throw new PlatformAuthError(`上游返回的 token 不可用（${token === null ? '缺失' : '形状不合法'}），无法生成二维码`, 502)
    }
    const expire = int(record.expire_time) ?? int(record.expire)
    this.log.info(`已为涂鸦授权生成二维码（token ${token.slice(0, 8)}…）`)
    return {
      token,
      payloadUrl: tuyaQrPayload(token),
      imageUrl: tuyaQrImagePath(token),
      textUrl: tuyaQrTextPath(token),
      expireSeconds: expire !== null && expire > 0 ? expire : 300,
    }
  }

  /**
   * Wait for the user to scan, on the plugin's side.
   *
   * Same bargain as the chat flow: one request covers the user's scan instead of
   * the page polling forever, and the ceiling stays below the browser's own
   * patience. `timedOut` lets the page keep waiting without treating a slow user
   * as an error.
   */
  async waitForTuyaStatus(tokenInput: unknown, userCodeInput: unknown): Promise<TuyaQrStatus> {
    const token = requireField(tokenInput, '二维码 token')
    const userCode = requireField(userCodeInput, '涂鸦 App 里的用户代码')
    if (!isTuyaToken(token)) throw new PlatformAuthError('二维码 token 形状不合法')
    const deadline = Date.now() + TUYA_STATUS_LONG_POLL_MS
    for (;;) {
      const payload = await this.call('auth/tuya_qr_status', { token, user_code: userCode })
      const record = asRecord(payload)
      const status = str(record.status) ?? (record.success === true ? 'pending' : 'error')
      if (status === 'authorized') {
        this.log.info('涂鸦授权成功（用户已扫码确认）')
        return { status: 'authorized', uid: str(record.uid), timedOut: false }
      }
      if (status === 'error' || status === 'expired' || status === 'invalid') {
        const detail = toolFailure(payload, '二维码已失效')
        return { status: 'error', uid: null, timedOut: false, message: detail }
      }
      if (Date.now() >= deadline) return { status: 'pending', uid: str(record.uid), timedOut: true }
      await new Promise((resolve) => setTimeout(resolve, TUYA_STATUS_POLL_INTERVAL_MS))
    }
  }

  // ───────────────────────────────────────────────────── 美的 / 易微联 (口令)

  /** 美的 account + password. Credentials never leave this call. */
  async loginMidea(accountInput: unknown, passwordInput: unknown, cloudInput: unknown): Promise<Record<string, unknown>> {
    const account = requireField(accountInput, '美的账号')
    const password = requireField(passwordInput, '美的密码')
    const cloud = str(cloudInput) ?? 'meiju'
    if (!(MIDEA_CLOUDS as readonly string[]).includes(cloud)) {
      throw new PlatformAuthError(`未知的美的云端类型 ${cloud}（可选：meiju 美的美居 / msmart MSmartHome）`)
    }
    const payload = await this.call('auth/midea_login', { account, password, cloud })
    const record = asRecord(payload)
    if (record.success !== true) {
      this.log.warn('美的登录失败（上游拒绝了本次认证）')
      throw new PlatformAuthError(`美的登录失败：${toolFailure(payload, '账号或密码不正确，或云端拒绝了请求')}`)
    }
    this.log.info(`美的登录成功（${String(record.device_count ?? 0)} 个设备，云端 ${cloud}）`)
    return { deviceCount: int(record.device_count) ?? 0, authStatus: asRecord(record.auth_status), cloud }
  }

  async loginEwelink(emailInput: unknown, passwordInput: unknown, countryInput: unknown): Promise<Record<string, unknown>> {
    const email = requireField(emailInput, '易微联邮箱或手机号')
    const password = requireField(passwordInput, '易微联密码')
    const countryCode = str(countryInput) ?? '+86'
    if (!/^\+?\d{1,4}$/.test(countryCode)) {
      throw new PlatformAuthError(`国家代码格式不正确：${countryCode}（形如 +86、+1）`)
    }
    const payload = await this.call('auth/ewelink_login', { email, password, country_code: countryCode })
    const record = asRecord(payload)
    if (record.success !== true) {
      this.log.warn('易微联登录失败（上游拒绝了本次认证）')
      throw new PlatformAuthError(`易微联登录失败：${toolFailure(payload, '账号或密码不正确，或区域设置与服务端不匹配')}`)
    }
    this.log.info(`易微联登录成功（${String(record.device_count ?? 0)} 个设备）`)
    return { deviceCount: int(record.device_count) ?? 0, authStatus: asRecord(record.auth_status), countryCode }
  }

  // ─────────────────────────────────────────────────────────── 米家 (OAuth)

  /** Step 1: the URL the user must open in a browser. */
  async xiaomiAuthUrl(regionInput: unknown): Promise<Record<string, unknown>> {
    const region = str(regionInput)
    if (region !== null && !(XIAOMI_REGIONS as readonly string[]).includes(region)) {
      throw new PlatformAuthError(`未知的小米区域 ${region}（可选：${XIAOMI_REGIONS.join(' / ')}）`)
    }
    const payload = await this.call('xiaomi/auth_url', region === null ? {} : { region })
    const record = asRecord(payload)
    const url = str(record.url)
    if (url === null) throw new PlatformAuthError(`上游没有返回授权地址：${toolFailure(payload, '未知原因')}`, 502)
    this.log.info(`已生成米家授权地址（区域 ${str(record.region) ?? region ?? '沿用当前'}）`)
    // The child's redirect_uri is `https://127.0.0.1`: the browser cannot load
    // it, so tell the user up front that the address bar is the payload.
    return { url, region: str(record.region) ?? region, redirectUri: 'https://127.0.0.1' }
  }

  /** Step 2: exchange whatever the user pasted for a token. */
  async xiaomiAuthCallback(input: unknown, regionInput: unknown): Promise<Record<string, unknown>> {
    const raw = requireField(input, '回调地址或授权码')
    const code = extractXiaomiCode(raw)
    if (code === null) {
      throw new PlatformAuthError('没有在粘贴的内容里找到 code：请把浏览器地址栏里的完整地址整段粘进来（形如 https://127.0.0.1/?code=…），或只粘贴 code 本身')
    }
    const region = str(regionInput)
    if (region !== null && !(XIAOMI_REGIONS as readonly string[]).includes(region)) {
      throw new PlatformAuthError(`未知的小米区域 ${region}（可选：${XIAOMI_REGIONS.join(' / ')}）`)
    }
    const args: Record<string, unknown> = { code }
    if (region !== null) args.region = region
    const payload = await this.call('xiaomi/auth_callback', args)
    const record = asRecord(payload)
    if (record.success !== true) {
      this.log.warn('米家授权回调失败（code 可能已失效或已被使用）')
      throw new PlatformAuthError(`米家授权失败：${toolFailure(payload, 'code 无效、已过期或已被使用，请重新打开授权地址再来一次')}`)
    }
    this.log.info(`米家授权成功（区域 ${str(record.region) ?? region ?? '沿用当前'}）`)
    return { region: str(record.region) ?? region, message: str(record.message) }
  }

  // ─────────────────────────────────────────────── 华为 (MCP 两步 + 验证码)

  /**
   * 华为 step 1. On a fresh account the upstream may answer with
   * `auth_status.pending_challenge`, which means a verification code is needed
   * (shown on an already-logged-in Huawei device — 华为 does not send SMS).
   */
  async loginHuawei(accountInput: unknown, passwordInput: unknown): Promise<ChallengeOutcome> {
    const account = requireField(accountInput, '华为账号（手机号或邮箱）')
    const password = requireField(passwordInput, '华为账号密码')
    return this.huaweiOutcome(await this.call('auth/huawei_login', { account, password }), '登录失败：请核对账号与密码')
  }

  /** 华为 step 2: the verification code. */
  async huaweiChallenge(codeInput: unknown): Promise<ChallengeOutcome> {
    const code = requireField(codeInput, '华为双重验证码')
    return this.huaweiOutcome(await this.call('auth/huawei_challenge', { code }), '验证码不正确')
  }

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
  private huaweiOutcome(payload: unknown, fallback: string): ChallengeOutcome {
    const record = asRecord(payload)
    const status = asRecord(record.auth_status)
    const needCode = status.pending_challenge === true || record.pending_challenge === true
    const retryWithoutCode = record.retry_without_code === true || status.retry_without_code === true
    const authenticated = status.authenticated === true || record.authenticated === true || (record.success === true && !needCode)
    const challengeName = str(status.challenge_name) ?? str(record.challenge_name)
    const message = str(record.message) ?? str(record.hint) ?? str(record.error)
    if (record.success !== true && !needCode && !retryWithoutCode) {
      this.log.warn(`华为登录/验证失败：${message ?? fallback}`)
      throw new PlatformAuthError(`${fallback}${message === null ? '' : `（上游：${message}）`}`)
    }
    if (authenticated) this.log.info('华为登录成功')
    else if (retryWithoutCode) this.log.info('华为会话已保留（令牌交换失败，无需重新验证码）')
    else if (needCode) this.log.info('华为需要双重验证码')
    return { authenticated, needCode, challengeName, retryWithoutCode, message }
  }

  // ────────────────────────────────────────────────────────── 退出登录

  /**
   * Log out of one platform.
   *
   * 米家 is the odd one out: the child implements `XiaomiProvider::logout()`
   * but never exposes it (no tool, no route), so there is nothing honest to
   * call. Saying so beats a button that appears to work.
   */
  async logout(platformId: string): Promise<{ message: string | null }> {
    const tools = await this.child.toolNames()
    if (tools === null) throw new PlatformAuthError('后台服务未运行，无法退出登录', 503)
    const has = (name: string): boolean => tools.includes(name)
    switch (platformId) {
      case 'tuya':
        if (!has('auth/tuya_logout')) throw new PlatformAuthError('当前上游构建没有涂鸦退出工具', 501)
        return { message: str(asRecord(await this.call('auth/tuya_logout')).message) ?? '涂鸦已退出' }
      case 'midea':
        if (!has('auth/midea_logout')) throw new PlatformAuthError('当前上游构建没有美的退出工具', 501)
        return { message: str(asRecord(await this.call('auth/midea_logout')).message) ?? '美的已退出' }
      case 'ewelink':
        if (!has('auth/ewelink_logout')) throw new PlatformAuthError('当前上游构建没有易微联退出工具', 501)
        return { message: str(asRecord(await this.call('auth/ewelink_logout')).message) ?? '易微联已退出' }
      case 'huawei':
        if (!has('auth/huawei_logout')) throw new PlatformAuthError('当前上游构建没有华为退出工具（auth/huawei_logout，需 v1.2.20 及以上）', 501)
        return { message: str(asRecord(await this.call('auth/huawei_logout')).message) ?? '华为已退出' }
      case 'xiaomi':
        throw new PlatformAuthError('上游没有暴露米家退出登录的接口（provider 里有 logout()，但既没有 MCP 工具也没有 REST 路由）。需要退出米家请等上游补上，或更换 data/ 目录下的米家 token 后重启服务。', 501)
      default:
        throw new PlatformAuthError(`未知平台 ${platformId}`, 404)
    }
  }
}


