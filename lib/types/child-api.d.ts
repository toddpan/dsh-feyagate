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
import { type LogBuffer } from './log.js';
import type { CameraSummary, GatewayInfo, LicenseView, PlatformAccount } from './types.js';
export interface ChildApiOptions {
    /** Current child port, or null when it is not running. */
    port: () => number | null;
    log: LogBuffer;
}
export declare class ChildApi {
    private readonly getPort;
    private readonly log;
    constructor(options: ChildApiOptions);
    private base;
    /** `{code:0, data}` REST call. Returns null when the child is not reachable. */
    private rest;
    info(): Promise<GatewayInfo | null>;
    license(): Promise<LicenseView | null>;
    /**
     * Write a license key and let the child activate it.
     *
     * No `product` is sent: the child's own default stands (`config.license.product`)
     * and the server overwrites it with the activated SKU. Inventing a product id
     * here would be guessing at a commercial identifier.
     */
    activate(licenseKey: string): Promise<{
        ok: true;
        license: LicenseView | null;
    } | {
        ok: false;
        error: string;
    }>;
    /** Clear the license and return to the free edition. */
    deactivate(): Promise<{
        ok: boolean;
        error: string | null;
    }>;
    /**
     * POST /api/v1/platform/xiaomi/logout — v1.2.21 起上游提供米家退出路由。
     * 返回 null 表示服务不可达或没有该路由（旧版本构建）。
     */
    xiaomiLogout(): Promise<{
        success: boolean;
        message: string;
    } | null>;
    /**
     * Call an MCP tool directly and unwrap the text payload.
     *
     * Tool results are text-first (`content: [{type:'text', text:'<json>'}])`);
     * we parse that text as JSON when it is JSON and hand back the raw string
     * otherwise, so both JSON-returning and prose-returning tools work.
     */
    callTool(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    /**
     * The tool names the child advertises, or null when it is unreachable.
     *
     * Used for capability negotiation before showing a platform's login form: a
     * build without (say) Huawei must be able to say so instead of offering a
     * button that always fails.
     */
    toolNames(timeoutMs?: number): Promise<string[] | null>;
    /**
     * Platform *authentication* list.
     *
     * Returns an empty array — not an error — when the child is down or the tool
     * is unavailable, because the UI renders this alongside license data that may
     * still be readable; a hard failure would blank the whole page.
     */
    platforms(): Promise<PlatformAccount[]>;
    /** Camera list, or an empty array when Xiaomi is not logged in / unsupported. */
    cameras(): Promise<CameraSummary[]>;
}
