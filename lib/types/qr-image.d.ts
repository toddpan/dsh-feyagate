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
export declare class InvalidTuyaTokenError extends Error {
    constructor();
}
/** PNG bytes for the token's `tuyaSmart--qrLogin/?token=…` payload. */
export declare function renderTuyaQrPng(token: string): Promise<Buffer>;
/**
 * Block-character QR for clients that render no images.
 *
 * `utf8` output uses half-block pairs, so it scans from a monospace code block
 * — the fallback that keeps the flow usable when an image cannot be shown.
 */
export declare function renderTuyaQrText(token: string): Promise<string>;
