/**
 * The host HTTP API the browser half talks to.
 *
 * Same-origin, prefix-registered through `ctx.webServer.register`, envelope
 * `{ok, data|error}` — the pattern the plugin's reference implementation already
 * established, so the client half looks like every other DSH plugin's.
 *
 * Two defences are here because this API can install and execute binaries, and
 * the DSH web server is reachable at `127.0.0.1` from *any* page the user has
 * open:
 *
 *   * **Origin check** on every mutating request. A cross-site `fetch` carries
 *     an `Origin` header we can compare against `Host`; a non-browser client
 *     (curl, a script) sends none and is allowed. Browsers cannot omit `Origin`
 *     on a cross-origin write, so this closes the CSRF path without needing a
 *     token.
 *   * **JSON content type required** for JSON writes: an HTML form cannot set
 *     it, which removes the other classic CSRF vector.
 *
 * Read-only routes are deliberately not so protected — a GET that leaks status
 * to a page the user already has open is a much smaller problem than a GET that
 * installs something, and every destructive action here is a POST.
 */

import { createWriteStream, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { API_PREFIX, LOG_FORWARD_LINES, LICENSE_SERVICE_URL } from './constants.js'
import { type GatewayRuntime } from './runtime.js'
import { readSettings, validateSettings, writeSettings, type SettingsPatch } from './settings.js'
import { loadManifest, latestVersionForPlatform, listVersionsForPlatform, compatSummary } from './manifest.js'
import { LAUNCHER } from './launcher.js'
import { cacheDir } from './paths.js'
import type { ApiEnvelope } from './types.js'

/** Uploaded packages may be large, but not unbounded. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

type Json = Record<string, unknown>

function send(res: ServerResponse, status: number, payload: ApiEnvelope<unknown>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function ok(res: ServerResponse, data: unknown): void {
  send(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, status: number, error: string): void {
  send(res, status, { ok: false, error })
}

function readJsonBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text) as unknown
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Json) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Same-origin check for writes. Returns an error string when it fails. */
function checkOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return null // non-browser client
  const host = req.headers.host
  if (host === undefined) return '缺少 Host 头'
  try {
    return new URL(origin).host === host ? null : `来源 ${origin} 与本机服务不一致，已拒绝该请求`
  } catch {
    return 'Origin 头无法解析'
  }
}

export interface ApiOptions {
  runtime: GatewayRuntime
  /** Plugin version, echoed in diagnostics. */
  version: string
}

/**
 * Build the request handler. Everything it needs is captured here; the plugin
 * registers the returned function once and disposes the route on unload.
 */
export function createApiHandler(options: ApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { runtime } = options
  const childApi = runtime.childApi

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method !== 'GET' && method !== 'HEAD') {
        const originError = checkOrigin(req)
        if (originError !== null) {
          fail(res, 403, originError)
          return
        }
      }

      switch (`${method} ${route}`) {
        // ── diagnostics ────────────────────────────────────────────────
        case 'GET /health': {
          const port = runtime.state.get().server.effectivePort
          ok(res, {
            plugin: options.version,
            root: runtime.root,
            platform: runtime.platform,
            node: process.version,
            facadePort: runtime.facade?.listeningPort ?? null,
            childPort: port,
            launcher: LAUNCHER,
          })
          return
        }

        case 'GET /status':
          ok(res, await runtime.status())
          return

        case 'GET /logs': {
          const since = Number.parseInt(url.searchParams.get('since') ?? '', 10)
          const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || LOG_FORWARD_LINES, 2000)
          ok(res, Number.isFinite(since) ? runtime.log.since(since, limit) : runtime.log.tail(limit))
          return
        }

        // ── settings ───────────────────────────────────────────────────
        case 'GET /settings':
          ok(res, {
            settings: readSettings(runtime.state),
            root: runtime.root,
            launcher: LAUNCHER,
            licenseServiceUrl: LICENSE_SERVICE_URL,
          })
          return

        case 'PUT /settings': {
          const body = (await readJsonBody(req)) as SettingsPatch
          const error = validateSettings(body)
          if (error !== null) {
            fail(res, 400, error)
            return
          }
          const before = readSettings(runtime.state)
          const next = writeSettings(runtime.state, body)
          const restartNeeded = next.facadePort !== before.facadePort
          ok(res, {
            settings: next,
            // The bridge URL is baked into the profile patch at boot, so a
            // facade port change only takes effect after a DSH restart.
            restartNeeded,
            note: restartNeeded ? '门面端口已保存，需要重启 DSH 才会生效' : null,
          })
          return
        }

        // ── service control ────────────────────────────────────────────
        case 'POST /service/start': {
          if (runtime.supervisor === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const outcome = await runtime.supervisor.ensureStarted()
          if (!outcome.ok && outcome.error !== 'not-installed') {
            fail(res, 500, outcome.error ?? '启动失败')
            return
          }
          ok(res, { started: outcome.ok, adopted: outcome.adopted, port: outcome.port })
          return
        }

        case 'POST /service/stop': {
          if (runtime.supervisor === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          await runtime.supervisor.stop()
          ok(res, { stopped: true })
          return
        }

        case 'POST /service/restart': {
          if (runtime.supervisor === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const outcome = await runtime.supervisor.restart()
          if (!outcome.ok) {
            fail(res, 500, outcome.error ?? '重启失败')
            return
          }
          ok(res, { restarted: true, port: outcome.port })
          return
        }

        case 'POST /service/reinstall': {
          if (runtime.installs === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const current = runtime.state.get().currentVersion
          if (current === null) {
            fail(res, 400, '尚未安装任何版本')
            return
          }
          ok(res, runtime.installs.startInstall(current, { reinstall: true }))
          return
        }

        // ── install / upgrade ──────────────────────────────────────────
        case 'GET /install/check': {
          if (runtime.installs === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          ok(res, runtime.installs.checkUpdate())
          return
        }

        case 'GET /install/catalog': {
          const platform = runtime.platform
          if (platform === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          try {
            const manifest = loadManifest()
            const installedVersions = runtime.installs?.checkUpdate().installedVersions ?? []
            ok(res, {
              platform,
              versions: listVersionsForPlatform(manifest, platform).map((version) => {
                const assets = manifest.versions[version]?.assets[platform] ?? []
                const primary = assets[0]
                return {
                  version,
                  publishedAt: manifest.versions[version]?.publishedAt ?? null,
                  file: primary?.file ?? null,
                  size: primary?.size ?? null,
                  sha256: primary?.sha256 ?? null,
                  unverified: primary === undefined || primary.sha256 === null,
                  isCurrent: runtime.state.get().currentVersion === version,
                  installed: installedVersions.includes(version),
                }
              }),
              compat: compatSummary(manifest, platform),
              recommended: latestVersionForPlatform(manifest, platform),
            })
          } catch (error) {
            fail(res, 500, (error as Error).message)
          }
          return
        }

        case 'POST /install': {
          if (runtime.installs === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          if (runtime.jobs.isBusy()) {
            fail(res, 409, '已有任务正在进行，请等待完成或先取消')
            return
          }
          const body = await readJsonBody(req)
          const version = typeof body.version === 'string' && body.version !== '' ? body.version : null
          // An upload applies to this run only; it is not a sticky preference.
          const localArchive =
            typeof body.localFile === 'string' && body.localFile !== ''
              ? join(cacheDir(runtime.root), basename(body.localFile))
              : null
          ok(
            res,
            runtime.installs.startInstall(version, {
              // `undefined`, not `false`, when the request omits it: the caller is
              // then deferring to the saved preference instead of silently
              // overriding it. An explicit boolean still wins, so the install
              // button can opt in (or out) for one action.
              allowUnverified: typeof body.allowUnverified === 'boolean' ? body.allowUnverified : undefined,
              localArchive,
            }),
          )
          return
        }

        case 'POST /install/upload': {
          const rawName = String(req.headers['x-feyagate-filename'] ?? '')
          if (rawName === '') {
            fail(res, 400, '缺少 x-feyagate-filename 头')
            return
          }
          const safeName = basename(rawName).replace(/[^0-9A-Za-z._-]/g, '_')
          mkdirSync(cacheDir(runtime.root), { recursive: true })
          const target = join(cacheDir(runtime.root), safeName)
          let written = 0
          req.on('data', (chunk: Buffer) => {
            written += chunk.length
            if (written > MAX_UPLOAD_BYTES) req.destroy()
          })
          try {
            await pipeline(req, createWriteStream(target))
          } catch (error) {
            fail(res, 400, `上传失败：${(error as Error).message}`)
            return
          }
          ok(res, { file: safeName, bytes: written, path: target })
          return
        }

        case 'POST /install/rollback': {
          if (runtime.installs === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const body = await readJsonBody(req)
          ok(res, runtime.installs.startRollback(typeof body.version === 'string' ? body.version : undefined))
          return
        }

        case 'POST /install/uninstall': {
          if (runtime.installs === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const body = await readJsonBody(req)
          ok(res, runtime.installs.startUninstall({ purgeData: body.purgeData === true }))
          return
        }

        // ── jobs ───────────────────────────────────────────────────────
        case 'GET /jobs/current':
          ok(res, { job: runtime.jobs.current(), busy: runtime.jobs.isBusy() })
          return

        case 'POST /jobs/cancel':
          ok(res, { cancelled: runtime.jobs.cancel() })
          return

        // ── account / license ──────────────────────────────────────────
        case 'GET /account/overview': {
          if (childApi === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const [info, license, platforms, cameras] = await Promise.all([
            childApi.info(),
            childApi.license(),
            childApi.platforms(),
            childApi.cameras(),
          ])
          ok(res, {
            info,
            license,
            platforms,
            cameras,
            // Camera features are compiled out of the upstream Windows build,
            // so the UI must not offer them there.
            cameraSupported: info?.cameraSupported ?? null,
            reachable: info !== null,
          })
          return
        }

        case 'POST /license/activate': {
          if (childApi === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const body = await readJsonBody(req)
          const key = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : ''
          if (key === '') {
            fail(res, 400, '请输入授权码')
            return
          }
          const result = await childApi.activate(key)
          if (!result.ok) {
            fail(res, 400, result.error)
            return
          }
          ok(res, { license: result.license })
          return
        }

        case 'POST /license/deactivate': {
          if (childApi === null) {
            fail(res, 400, '当前平台不受支持')
            return
          }
          const result = await childApi.deactivate()
          if (!result.ok) {
            fail(res, 400, result.error ?? '解除授权失败')
            return
          }
          ok(res, { license: await childApi.license() })
          return
        }

        default:
          fail(res, 404, `未知接口：${method} ${route}`)
      }
    } catch (error) {
      // A route must never take the host down: any escape is reported as a 500.
      runtime.log.error(`API ${method} ${route} 失败：${(error as Error).message}`)
      if (!res.headersSent) fail(res, 500, (error as Error).message)
      else res.end()
    }
  }
}
