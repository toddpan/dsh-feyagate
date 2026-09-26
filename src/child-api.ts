/**
 * The child process's own HTTP API, as seen from the plugin.
 *
 * The child exposes two surfaces and both are used here, deliberately:
 *
 *  * **REST** (`/api/v1/gateway/*`) for factual state. It is cheap, untyped by
 *    MCP, and — importantly — it is what the official desktop app reads, so its
 *    shape is a supported interface rather than an implementation detail.
 *  * **MCP** (`POST /mcp/http`, `tools/call`) for anything that only exists as
 *    a tool, such as the platform authentication list. Calling tools directly
 *    (instead of asking the model to) is the whole point of the 账号总览 page.
 *
 * Every response is wrapped in `{code, data}` by the REST handlers, and MCP
 * results come back as `{content:[{type:'text',text:'<json>'}]}`. Both are
 * unwrapped in one place so no caller has to know that.
 */

import { type LogBuffer } from './log.js'
import type { CameraSummary, GatewayInfo, LicenseView, PlatformAccount, PlatformCapability } from './types.js'

/** Long enough for a camera-bound tool call, short enough to fail visibly. */
const TOOL_TIMEOUT_MS = 60_000
const REST_TIMEOUT_MS = 8000

interface RestEnvelope<T> {
  code?: number
  data?: T
  message?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export interface ChildApiOptions {
  /** Current child port, or null when it is not running. */
  port: () => number | null
  log: LogBuffer
}

export class ChildApi {
  private readonly getPort: () => number | null
  private readonly log: LogBuffer

  constructor(options: ChildApiOptions) {
    this.getPort = options.port
    this.log = options.log
  }

  private base(): string | null {
    const port = this.getPort()
    return port === null ? null : `http://127.0.0.1:${port}`
  }

  /** `{code:0, data}` REST call. Returns null when the child is not reachable. */
  private async rest<T>(path: string, init?: RequestInit): Promise<T | null> {
    const base = this.base()
    if (base === null) return null
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      const envelope = JSON.parse(text) as RestEnvelope<T>
      // `code` is the child's own status channel; a non-zero code is a failure
      // even when the HTTP status is 200.
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        this.log.warn(`后台服务返回 code=${envelope.code}：${envelope.message ?? '无消息'}（${path}）`)
        return null
      }
      if (envelope.data === undefined) {
        this.log.warn(`后台服务响应缺少 data 字段（${path}）`)
        return null
      }
      return envelope.data
    } catch (error) {
      this.log.warn(`请求后台服务失败（${path}）：${(error as Error).message}`)
      return null
    }
  }

  async info(): Promise<GatewayInfo | null> {
    const data = await this.rest<Record<string, unknown>>('/api/v1/gateway/info')
    if (data === null) return null
    const license = asRecord(data.license)
    return {
      name: str(data.name),
      version: str(data.version),
      platform: str(data.platform),
      deviceId: str(data.device_id),
      cameraSupported: bool(data.camera_supported),
      license: {
        edition: str(license.edition),
        status: str(license.status),
        product: str(license.product),
        keyMasked: str(license.key_masked),
      },
      raw: data,
    }
  }

  async license(): Promise<LicenseView | null> {
    const data = await this.rest<Record<string, unknown>>('/api/v1/gateway/license')
    if (data === null) return null
    const capabilities = asRecord(data.capabilities)
    const platformsRaw = asRecord(capabilities.platforms)
    const platforms: PlatformCapability[] = Object.entries(platformsRaw).map(([platform, value]) => {
      const entry = asRecord(value)
      return {
        platform,
        enabled: entry.enabled === true,
        status: str(entry.status),
        message: str(entry.message),
        trialHours: num(entry.trial_hours),
        trialRemainingHours: num(entry.trial_remaining_hours),
        trialRemainingDays: num(entry.trial_remaining_days),
      }
    })
    return {
      edition: str(data.edition),
      status: str(data.status),
      product: str(data.product),
      keyMasked: str(data.key_masked),
      deviceId: str(data.device_id),
      // Absent/false both mean "not synced with the server yet"; defaulting to
      // false keeps the UI on the honest side of that ambiguity.
      capabilitiesLoaded: capabilities.loaded === true,
      capabilitiesMessage: str(capabilities.message),
      subscriptionActive: bool(capabilities.is_subscription_active),
      subscriptionExpiresAt: str(capabilities.subscription_expires_at),
      gracePeriodStartAt: str(capabilities.grace_period_start_at),
      gracePeriodExpiresAt: str(capabilities.grace_period_expires_at),
      graceRemainingDays: num(capabilities.grace_period_remaining),
      features: asRecord(capabilities.features),
      platforms,
      raw: data,
    }
  }

  /**
   * Write a license key and let the child activate it.
   *
   * No `product` is sent: the child's own default stands (`config.license.product`)
   * and the server overwrites it with the activated SKU. Inventing a product id
   * here would be guessing at a commercial identifier.
   */
  async activate(licenseKey: string): Promise<{ ok: true; license: LicenseView | null } | { ok: false; error: string }> {
    const base = this.base()
    if (base === null) return { ok: false, error: '后台服务未运行' }
    try {
      const response = await fetch(`${base}/api/v1/gateway/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey }),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      })
      const text = await response.text()
      const envelope = JSON.parse(text) as RestEnvelope<Record<string, unknown>>
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        return { ok: false, error: envelope.message ?? `激活失败（code=${envelope.code}）` }
      }
      return { ok: true, license: await this.license() }
    } catch (error) {
      return { ok: false, error: `激活请求失败：${(error as Error).message}` }
    }
  }

  /** Clear the license and return to the free edition. */
  async deactivate(): Promise<{ ok: boolean; error: string | null }> {
    const base = this.base()
    if (base === null) return { ok: false, error: '后台服务未运行' }
    try {
      const response = await fetch(`${base}/api/v1/gateway/license`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      })
      const envelope = JSON.parse(await response.text()) as RestEnvelope<unknown>
      if (typeof envelope.code === 'number' && envelope.code !== 0) {
        return { ok: false, error: envelope.message ?? `解除授权失败（code=${envelope.code}）` }
      }
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: `解除授权请求失败：${(error as Error).message}` }
    }
  }

  /**
   * POST /api/v1/platform/xiaomi/logout — v1.2.21 起上游提供米家退出路由。
   * 返回 null 表示服务不可达或没有该路由（旧版本构建）。
   */
  async xiaomiLogout(): Promise<{ success: boolean; message: string } | null> {
    return this.rest<{ success: boolean; message: string }>('/api/v1/platform/xiaomi/logout', {
      method: 'POST',
      body: '{}',
    })
  }

  /**
   * Call an MCP tool directly and unwrap the text payload.
   *
   * Tool results are text-first (`content: [{type:'text', text:'<json>'}])`);
   * we parse that text as JSON when it is JSON and hand back the raw string
   * otherwise, so both JSON-returning and prose-returning tools work.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = TOOL_TIMEOUT_MS): Promise<unknown> {
    const base = this.base()
    if (base === null) throw new Error('后台服务未运行')
    const response = await fetch(`${base}/mcp/http`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = (await response.json()) as {
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      error?: { message?: string }
    }
    if (payload.error !== undefined) throw new Error(payload.error.message ?? `工具 ${name} 调用失败`)
    const content = payload.result?.content ?? []
    const text = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text!)
      .join('\n')
    if (payload.result?.isError === true) throw new Error(text === '' ? `工具 ${name} 返回错误` : text)
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * The tool names the child advertises, or null when it is unreachable.
   *
   * Used for capability negotiation before showing a platform's login form: a
   * build without (say) Huawei must be able to say so instead of offering a
   * button that always fails.
   */
  async toolNames(timeoutMs = REST_TIMEOUT_MS): Promise<string[] | null> {
    const base = this.base()
    if (base === null) return null
    try {
      const response = await fetch(`${base}/mcp/http`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } }
      const tools = payload.result?.tools
      if (!Array.isArray(tools)) return null
      return tools.map((tool) => tool?.name).filter((name): name is string => typeof name === 'string')
    } catch (error) {
      this.log.warn(`读取后台服务工具列表失败：${(error as Error).message}`)
      return null
    }
  }

  /**
   * Platform *authentication* list.
   *
   * Returns an empty array — not an error — when the child is down or the tool
   * is unavailable, because the UI renders this alongside license data that may
   * still be readable; a hard failure would blank the whole page.
   */
  async platforms(): Promise<PlatformAccount[]> {
    try {
      const raw = await this.callTool('auth/platforms')
      const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw).platforms) ? (asRecord(raw).platforms as unknown[]) : []
      return list.map((entry) => {
        const record = asRecord(entry)
        return {
          platformId: str(record.platform_id) ?? str(record.id) ?? 'unknown',
          platformName: str(record.platform_name) ?? str(record.name) ?? str(record.platform_id) ?? '未知平台',
          authenticated: record.authenticated === true,
          authStatus: asRecord(record.auth_status),
        }
      })
    } catch (error) {
      this.log.warn(`读取平台认证状态失败：${(error as Error).message}`)
      return []
    }
  }

  /** Camera list, or an empty array when Xiaomi is not logged in / unsupported. */
  async cameras(): Promise<CameraSummary[]> {
    try {
      const raw = await this.callTool('xiaomi/camera_list')
      const list = Array.isArray(raw) ? raw : []
      return list.map((entry) => {
        const record = asRecord(entry)
        return {
          deviceId: str(record.device_id) ?? str(record.did) ?? str(record.deviceId) ?? 'unknown',
          name: str(record.name) ?? str(record.device_name) ?? '未命名摄像头',
          online: record.online !== false && record.is_online !== false,
        }
      })
    } catch (error) {
      this.log.warn(`读取摄像头列表失败：${(error as Error).message}`)
      return []
    }
  }
}
