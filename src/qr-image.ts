/**
 * QR rendering for the Tuya authorization flow.
 *
 * Kept apart from `tuya-qr.ts` so that only the HTTP route pulls in the encoder
 * — the MCP facade (the hot path) imports the pure helpers and nothing else.
 *
 * The library is a real QR encoder rather than a hand-rolled one because the
 * whole point is that a phone camera scans it on the first try; correctness of
 * level/mask/format bits is not something worth re-deriving here. The test
 * suite decodes the output back with an independent decoder (`jsqr`), so what we
 * ship is verified to round-trip, not merely to produce a plausible PNG.
 */

import QRCode from 'qrcode'

import { tuyaQrPayload, isTuyaToken } from './tuya-qr.js'

/**
 * Rendered size. Comfortably above the ~200px a phone camera needs, and small
 * enough that the chat bubble does not have to scale it down much.
 */
const IMAGE_WIDTH = 640

/** One module of quiet zone: enough for a camera, minimal wasted space. */
const MARGIN = 1

export class InvalidTuyaTokenError extends Error {
  constructor() {
    super('token 不是合法的涂鸦二维码 token')
    this.name = 'InvalidTuyaTokenError'
  }
}

/** PNG bytes for the token's `tuyaSmart--qrLogin/?token=…` payload. */
export async function renderTuyaQrPng(token: string): Promise<Buffer> {
  if (!isTuyaToken(token)) throw new InvalidTuyaTokenError()
  return await QRCode.toBuffer(tuyaQrPayload(token), {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: IMAGE_WIDTH,
    margin: MARGIN,
  })
}

/**
 * Block-character QR for clients that render no images.
 *
 * `utf8` output uses half-block pairs, so it scans from a monospace code block
 * — the fallback that keeps the flow usable when an image cannot be shown.
 */
export async function renderTuyaQrText(token: string): Promise<string> {
  if (!isTuyaToken(token)) throw new InvalidTuyaTokenError()
  return await QRCode.toString(tuyaQrPayload(token), {
    type: 'utf8',
    errorCorrectionLevel: 'M',
    // The utf8 renderer derives its top margin from `margin / 2` and feeds that
    // straight into `Array()`, so an odd margin throws `RangeError: Invalid
    // array length`. Two modules of quiet zone is also the friendlier default
    // for a camera reading a screen.
    margin: 2,
  })
}
