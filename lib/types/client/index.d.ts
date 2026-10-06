/**
 * Feyagate 网关 — 设置界面的浏览器半侧。
 *
 * 一个 `settings.section` 页面，六个 tab：服务 / 授权 / 账号总览 / 平台登录 / 设置 / 日志。
 *
 * 三条约束决定了这里怎么写：
 *
 *  1. **只能用平台种子里的模块。** `react`、`react/jsx-runtime` 由前端静态模块表
 *     提供；其余一切必须打进 bundle。这里刻意不引 `@deepseek-ai/dsh-client-ui-primitives`，
 *     因为设置面板内容列可能很窄，自绘控件更容易随宽度换行，也少一个宿主版本耦合。
 *  2. **颜色只走真实存在的 DSH 设计令牌**（`--dsw-alias-*`，已从 shipped 前端 CSS
 *     逐个核对）。早期同类插件写错过令牌名（如 `--dsw-alias-bg-primary`），深色主题下
 *     全部退回浅色兜底，出现白底白字。这里没有兜底色，全部是真实令牌。
 *  3. **错误一律四层结构**（结论 / 原因 + 错误码 / 动作 / 技术细节折叠），与
 *     UX 设计稿 §5.4 一致：结论 ≤ 24 字、原因带可核验依据、至少一个用户自己能做的动作。
 *
 * 数据来源是宿主半侧的同源 HTTP API（见 `src/api.ts`），不是 `host.call`：
 * 设置界面在浏览器里，宿主在 Node 里，两者的唯一共同通道就是 HTTP。
 */
import React from 'react';
interface SlotRegisterOptions {
    name: string;
    id: string;
    order: number;
    label: () => string;
}
interface ClientContext {
    slots: {
        inject(slot: string, factory: () => (() => void) | void): () => void;
        register(options: SlotRegisterOptions, component: React.ComponentType): () => void;
    };
    effect(fn: () => (() => void) | void, label?: string): () => void;
    logger?: {
        info(message: string): void;
        warn(message: string): void;
    };
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
