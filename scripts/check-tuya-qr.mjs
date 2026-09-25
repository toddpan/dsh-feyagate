/**
 * Tuya authorization, verified end to end at the plugin's boundary.
 *
 * The flow only works if a phone camera can actually read what we show, so this
 * does not merely assert that a PNG was produced: the image is decoded back with
 * an independent decoder (`jsqr`) and the payload has to match the Tuya app's
 * `tuyaSmart--qrLogin/?token=…` exactly — for the PNG *and* for the
 * block-character fallback. A unit test that stops at "bytes exist" would pass
 * while the user stares at an unscannable square.
 *
 * Usage: node scripts/check-tuya-qr.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import jsQR from 'jsqr'
import { PNG } from 'pngjs'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..')

const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  const ok = condition === true
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
  return ok
}

/** Decode an RGBA bitmap the way a phone camera would. */
function decodeRgba(data, width, height) {
  const result = jsQR(new Uint8ClampedArray(data), width, height)
  return result === null ? null : result.data
}

/** Scale a boolean module matrix into RGBA at `scale` pixels per module. */
function matrixToRgba(matrix, scale) {
  const size = matrix.length
  const width = size * scale
  const data = new Uint8ClampedArray(width * width * 4)
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dark = matrix[Math.floor(y / scale)][Math.floor(x / scale)]
      const offset = (y * width + x) * 4
      const value = dark ? 0 : 255
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return { data, width, height: width }
}

/**
 * Rebuild the module matrix from the `utf8` renderer's half-block output:
 * one character per module horizontally, two modules per line vertically.
 */
function textArtToMatrix(art) {
  const lines = art.replace(/\n$/, '').split('\n')
  const width = Math.max(...lines.map((line) => line.length))
  const matrix = []
  for (const line of lines) {
    const top = []
    const bottom = []
    for (let x = 0; x < width; x += 1) {
      const char = line[x] ?? ' '
      top.push(char === '█' || char === '▀')
      bottom.push(char === '█' || char === '▄')
    }
    matrix.push(top, bottom)
  }
  return matrix
}

async function main() {
  const { tuyaQrPayload, tuyaQrImagePath, tuyaQrTextPath, tuyaQrChatDisplay, tuyaQrNextAction, isTuyaToken } = await import(
    join(projectRoot, 'lib', 'tuya-qr.js')
  )
  const { renderTuyaQrPng, renderTuyaQrText, InvalidTuyaTokenError } = await import(join(projectRoot, 'lib', 'qr-image.js'))
  const { createApiHandler } = await import(join(projectRoot, 'lib', 'api.js'))
  const { GatewayRuntime } = await import(join(projectRoot, 'lib', 'runtime.js'))

  console.log('\n== 涂鸦授权：二维码 / 聊天文案 / HTTP 路由 ==')

  const TOKEN = 'AY1790336520041pvrdwArwkBAhKuUicmqseTEcFo1790336820041'
  const EXPECTED = `tuyaSmart--qrLogin/?token=${TOKEN}`

  // ── payload 与校验 ────────────────────────────────────────────
  check('payload 就是涂鸦 App 要求的格式', tuyaQrPayload(TOKEN) === EXPECTED, tuyaQrPayload(TOKEN).slice(0, 40))
  check('正常 token 通过校验', isTuyaToken(TOKEN) === true)
  for (const bad of ['', 'short', 'has space here', '中文token中文token', 'a'.repeat(300), '../../etc/passwd']) {
    if (!check(`拒绝非法 token（${bad === '' ? '空' : bad.slice(0, 14)}）`, isTuyaToken(bad) === false)) continue
  }

  // ── PNG：编码 → 独立解码器读回 ───────────────────────────────
  const png = await renderTuyaQrPng(TOKEN)
  check('PNG 是合法图片（魔数 + 可解析）', png.subarray(0, 4).toString('hex') === '89504e47', png.subarray(0, 8).toString('hex'))
  const image = PNG.sync.read(png)
  check('PNG 尺寸足够手机扫（≥ 400px）', image.width >= 400 && image.height >= 400, `${image.width}×${image.height}`)
  const decodedPng = decodeRgba(image.data, image.width, image.height)
  check('★ 用独立解码器读回，内容与 token 完全一致', decodedPng === EXPECTED, String(decodedPng).slice(0, 60))

  const other = await renderTuyaQrPng('AYdifferentTokenValue1234567890')
  check('不同 token 生成不同二维码', Buffer.compare(png, other) !== 0)

  let rejected = false
  try {
    await renderTuyaQrPng('bad token!')
  } catch (error) {
    rejected = error instanceof InvalidTuyaTokenError
  }
  check('渲染器本身也拒绝非法 token', rejected)

  // ── 文本兜底：同样要能扫 ──────────────────────────────────────
  const art = await renderTuyaQrText(TOKEN)
  const artLines = art.trimEnd().split('\n')
  check('文本二维码是多行方块字符', artLines.length > 10 && artLines[0].includes('█') === false, `${artLines.length} 行, ${artLines[0].length} 列`)
  const matrix = textArtToMatrix(art)
  const rgba = matrixToRgba(matrix, 4)
  const decodedText = decodeRgba(rgba.data, rgba.width, rgba.height)
  check('★ 文本兜底二维码同样能被独立解码器读回', decodedText === EXPECTED, String(decodedText).slice(0, 60))

  // ── 聊天文案 ──────────────────────────────────────────────────
  const display = tuyaQrChatDisplay(TOKEN, 300)
  check('chat_display 含 Markdown 图片且指向插件路由', display.includes(`![涂鸦授权二维码](${tuyaQrImagePath(TOKEN)})`), display.split('\n')[0])
  check(
    'chat_display 路径是根相对的（换主机/隧道也能渲染）',
    tuyaQrImagePath(TOKEN).startsWith('/dsh-feyagate/') && !tuyaQrImagePath(TOKEN).includes('http'),
    tuyaQrImagePath(TOKEN).slice(0, 48),
  )
  check('chat_display 写清了涂鸦 App 的操作路径', display.includes('涂鸦 App') && display.includes('扫一扫'))
  check('chat_display 给出文本兜底地址', display.includes(tuyaQrTextPath(TOKEN)))
  check('next_action 让模型自己轮询（且不要反问用户）', tuyaQrNextAction(TOKEN, 'uc-123').includes('auth/tuya_qr_status') && tuyaQrNextAction(TOKEN, 'uc-123').includes('不要问用户'))
  check(
    'next_action 带上了轮询所需的 token 与 user_code',
    tuyaQrNextAction(TOKEN, 'uc-123').includes(TOKEN) && tuyaQrNextAction(TOKEN, 'uc-123').includes('uc-123'),
  )

  // ── HTTP 路由（真实 handler + 假 req/res）──────────────────────
  const root = mkdtempSync(join(tmpdir(), 'fg-qr-'))
  try {
    const runtime = new GatewayRuntime({ version: '9.9.9', root })
    const handler = createApiHandler({ runtime, version: '9.9.9' })

    const request = async (path) => {
      const captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
      const res = {
        writeHead(status, headers) {
          captured.status = status
          captured.headers = headers ?? {}
          return this
        },
        end(body) {
          if (body !== undefined && body !== null) captured.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
        },
      }
      await handler({ method: 'GET', url: path, headers: { host: '127.0.0.1:3080' } }, res)
      return captured
    }

    const qr = await request(`/dsh-feyagate/auth/tuya/qr.png?token=${TOKEN}`)
    check('GET qr.png 返回 200 + image/png', qr.status === 200 && String(qr.headers['Content-Type']).startsWith('image/png'), `${qr.status} ${qr.headers['Content-Type']}`)
    check('GET qr.png 不缓存（二维码里带着凭据）', qr.headers['Cache-Control'] === 'no-store')
    const routed = PNG.sync.read(qr.body)
    check(
      '★ 路由返回的图片解码后仍是同一个 token（端到端闭环）',
      decodeRgba(routed.data, routed.width, routed.height) === EXPECTED,
    )

    const bad = await request('/dsh-feyagate/auth/tuya/qr.png?token=not%20a%20token')
    check('非法 token 返回 400 且是 JSON 错误信封', bad.status === 400 && JSON.parse(bad.body.toString('utf8')).ok === false, bad.body.toString('utf8').slice(0, 80))

    const text = await request(`/dsh-feyagate/auth/tuya/qr.txt?token=${TOKEN}`)
    check('GET qr.txt 返回文本二维码', text.status === 200 && text.body.toString('utf8').includes('█'), text.body.toString('utf8').split('\n')[0].slice(0, 20))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n== 结果：${checks - failures.length}/${checks} 通过 ==`)
  if (failures.length > 0) {
    console.error('\n失败项：')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('全部通过。')
  }
}

await main()
