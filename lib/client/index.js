import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// ────────────────────────────────────────────────────────────────── 常量
const FALLBACK_PREFIX = '/dsh-feyagate';
function boot() {
    return globalThis.__DSH_FEYAGATE__ ?? {};
}
const API_PREFIX = boot().apiPrefix ?? FALLBACK_PREFIX;
/**
 * 服务端字段里存的是带前缀的根相对路径（如 `/dsh-feyagate/auth/tuya/qr.png`）；
 * 直接再拼一遍前缀会变成 `/dsh-feyagate/dsh-feyagate/…`（接口 404）。统一走这里
 * 补齐：已带前缀的原样返回，没带的补上。
 */
function withApiPrefix(path) {
    return path.startsWith(API_PREFIX) ? path : `${API_PREFIX}${path}`;
}
const TABS = [
    { id: 'service', label: '服务' },
    { id: 'license', label: '授权' },
    { id: 'accounts', label: '账号总览' },
    { id: 'login', label: '平台登录' },
    { id: 'settings', label: '设置' },
    { id: 'logs', label: '日志' },
];
// ────────────────────────────────────────────────────────────────── 样式
const CSS = `
.fg-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; }
.fg-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 6px; }
.fg-tab { appearance: none; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.fg-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fg-tab[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.fg-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); }
.fg-card + .fg-card { margin-top: 10px; }
.fg-card-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fg-hint { color: var(--dsw-alias-label-caption); font-size: 12px; }
.fg-hero { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.fg-hero-main { flex: 1 1 260px; min-width: 0; }
.fg-hero-state { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 14px; }
.fg-hero-detail { color: var(--dsw-alias-label-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.fg-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.fg-btn { appearance: none; font: inherit; border-radius: 7px; padding: 5px 12px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.fg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.fg-btn:disabled { opacity: .45; cursor: not-allowed; }
.fg-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.fg-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.fg-btn-danger { color: var(--dsw-alias-label-error); }
.fg-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.fg-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-link); padding-left: 2px; padding-right: 2px; }
.fg-grid { display: grid; grid-template-columns: minmax(96px, max-content) 1fr; gap: 4px 12px; align-items: baseline; }
.fg-grid > dt { color: var(--dsw-alias-label-secondary); }
.fg-grid > dd { margin: 0; overflow-wrap: anywhere; }
.fg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.fg-code { display: block; background: var(--dsw-alias-markdown-code-block); border-radius: 6px; padding: 8px 10px;
  overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.fg-qr { display: block; width: 200px; height: 200px; margin: 8px 0; padding: 6px; border-radius: 9px;
  background: #fff; border: 1px solid var(--dsw-alias-border-l3); }
.fg-link { color: var(--dsw-alias-brand-primary); text-decoration: underline; cursor: pointer; }
.fg-form-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.fg-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.fg-tag-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.fg-tag-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.fg-tag-bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.fg-tag-busy { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.fg-state-idle { color: var(--dsw-alias-label-secondary); }
.fg-state-busy { color: var(--dsw-alias-state-business-primary); }
.fg-state-ok { color: var(--dsw-alias-state-success-primary); }
.fg-state-warn { color: var(--dsw-alias-state-warn-primary); }
.fg-state-bad { color: var(--dsw-alias-state-error-primary); }
.fg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.fg-row:first-child { border-top: 0; }
.fg-row-main { flex: 1 1 190px; min-width: 0; }
.fg-row-sub { color: var(--dsw-alias-label-caption); font-size: 12px; overflow-wrap: anywhere; }
.fg-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-interactive-bg-active); overflow: hidden; margin-top: 8px; }
.fg-progress > i { display: block; height: 100%; background: var(--dsw-alias-state-business-primary); transition: width .25s ease; }
.fg-progress-indeterminate > i { width: 32% !important; animation: fg-slide 1.4s ease-in-out infinite; }
@keyframes fg-slide { 0% { transform: translateX(-105%); } 100% { transform: translateX(320%); } }
.fg-logs { max-height: 340px; overflow: auto; background: var(--dsw-alias-markdown-code-block); border-radius: 8px; padding: 8px 10px; }
.fg-log-line { display: flex; gap: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.fg-log-ts { color: var(--dsw-alias-label-dimmed); flex: none; }
.fg-log-warn { color: var(--dsw-alias-state-warn-label); }
.fg-log-error { color: var(--dsw-alias-label-error); }
.fg-field { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.fg-field > label { color: var(--dsw-alias-label-secondary); }
.fg-input { font: inherit; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); width: 100%; box-sizing: border-box; }
.fg-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.fg-check { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0; }
.fg-check > input { margin-top: 4px; }
.fg-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); }
.fg-error-title { font-weight: 600; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.fg-error-code { color: var(--dsw-alias-label-caption); font-weight: 400; font-size: 12px; }
.fg-error-cause { color: var(--dsw-alias-label-secondary); margin-top: 4px; overflow-wrap: anywhere; }
.fg-details > summary { cursor: pointer; color: var(--dsw-alias-label-caption); margin-top: 8px; }
.fg-empty { color: var(--dsw-alias-label-caption); padding: 8px 0; }
.fg-copy { border: 0; background: transparent; color: var(--dsw-alias-link); cursor: pointer; font: inherit; padding: 0 2px; }
.fg-copy:hover { text-decoration: underline; }
`;
let stylesInserted = false;
function insertStyles() {
    if (stylesInserted)
        return;
    stylesInserted = true;
    const existing = document.querySelector('style[data-plugin-css="dsh-feyagate"]');
    if (existing !== null)
        return;
    const style = document.createElement('style');
    style.setAttribute('data-plugin-css', 'dsh-feyagate');
    style.textContent = CSS;
    document.head.appendChild(style);
}
// ────────────────────────────────────────────────────────────── HTTP 封装
async function api(path, init) {
    const response = await fetch(`${API_PREFIX}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    let payload;
    try {
        payload = (await response.json());
    }
    catch {
        throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (payload.ok !== true)
        throw new Error(payload.error);
    return payload.data;
}
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const RULES = [
    {
        test: /github|ENOTFOUND|EAI_AGAIN|fetch failed|网络|不可达/i,
        code: 'FG-NET-001',
        conclusion: '下载服务器不可达',
        cause: () => '无法连接 GitHub Releases。若本机需要代理，请配置镜像地址后重试。',
        actions: ['配置镜像地址'],
    },
    { test: /超时|timeout|ETIMEDOUT/i, code: 'FG-NET-002', conclusion: '下载超时', cause: (raw) => raw, actions: ['重试', '改用镜像'] },
    { test: /中断|aborted|ECONNRESET/i, code: 'FG-NET-003', conclusion: '下载中断', cause: (raw) => raw, actions: ['重试'] },
    {
        // Must precede the `zip|tar` rule below: the failing archive's name ends in
        // `.zip`, so a generic packaging rule would claim this and hide the real cause.
        test: /Library not loaded|dyld|image not found|error while loading shared libraries|cannot open shared object file/i,
        code: 'FG-PKG-004',
        conclusion: '安装包缺少运行库',
        cause: (raw) => raw,
        actions: ['换一个版本', '查看技术细节'],
    },
    {
        test: /sha256|校验|md5|指纹/i,
        code: 'FG-PKG-001',
        conclusion: '安装包校验未通过',
        cause: (raw) => raw,
        actions: ['换一个来源重试'],
    },
    { test: /解压|extract|zip|tar/i, code: 'FG-PKG-002', conclusion: '解压失败', cause: (raw) => raw, actions: ['删除缓存后重试'] },
    { test: /空间|ENOSPC/i, code: 'FG-PKG-003', conclusion: '磁盘空间不足', cause: (raw) => raw, actions: ['清理磁盘空间'] },
    { test: /未签名|Gatekeeper|quarantine|codesign/i, code: 'FG-PERM-001', conclusion: '被系统安全策略拦截', cause: (raw) => raw, actions: ['查看技术细节'] },
    { test: /EACCES|EPERM|不可写|权限/i, code: 'FG-PERM-002', conclusion: '安装目录不可写', cause: (raw) => raw, actions: ['检查目录权限'] },
    {
        test: /EADDRINUSE|端口.*占用|被占用/,
        code: 'FG-PORT-001',
        conclusion: '端口已被占用',
        cause: (raw) => raw,
        actions: ['改端口', '停止占用端口的进程'],
    },
    { test: /健康检查/, code: 'FG-BOOT-001', conclusion: '服务启动后无响应', cause: (raw) => raw, actions: ['查看日志', '回滚上一版本'] },
    { test: /异常退出|崩溃/, code: 'FG-BOOT-002', conclusion: '服务运行中退出', cause: (raw) => raw, actions: ['查看日志', '回滚上一版本'] },
    { test: /授权码/, code: 'FG-LIC-001', conclusion: '授权码未被接受', cause: (raw) => raw, actions: ['核对授权码'] },
    { test: /来源.*不一致|拒绝|403/, code: 'FG-API-403', conclusion: '管理接口拒绝了请求', cause: (raw) => raw, actions: ['从本机页面重试'] },
    { test: /已有任务/, code: 'FG-API-409', conclusion: '已有任务在进行', cause: () => '同一个时刻只能有一个安装/升级任务。', actions: ['等待完成', '取消'] },
];
/** Cut a raw message down to the 60-character budget the design allows. */
function clampCause(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
function diagnose(raw, conclusion) {
    for (const rule of RULES) {
        if (rule.test.test(raw)) {
            return { conclusion: conclusion ?? rule.conclusion, cause: clampCause(rule.cause(raw)), code: rule.code, actions: rule.actions };
        }
    }
    return {
        conclusion: conclusion ?? '操作未完成',
        cause: clampCause(raw),
        code: 'FG-API-000',
        actions: ['查看日志'],
    };
}
// ────────────────────────────────────────────────────────────── 基础控件
function Btn(props) {
    const variant = props.variant ?? 'default';
    const cls = variant === 'default' ? 'fg-btn' : `fg-btn fg-btn-${variant}`;
    return (_jsx("button", { type: "button", className: cls, onClick: props.onClick, disabled: props.disabled === true, title: props.title, children: props.children }));
}
function Card(props) {
    return (_jsxs("section", { className: "fg-card", children: [props.title === undefined ? null : _jsx("div", { className: "fg-card-title", children: props.title }), props.children] }));
}
function Row(props) {
    return (_jsxs("div", { className: "fg-row", children: [_jsxs("div", { className: "fg-row-main", children: [_jsx("div", { children: props.main }), props.sub === undefined ? null : _jsx("div", { className: "fg-row-sub", children: props.sub })] }), props.right] }));
}
function Copy(props) {
    const [copied, setCopied] = useState(false);
    return (_jsx("button", { type: "button", className: "fg-copy", onClick: () => {
            void navigator.clipboard?.writeText(props.value).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
            });
        }, children: copied ? '已复制' : (props.label ?? '复制') }));
}
function ErrorCard(props) {
    const diagnosis = diagnose(props.raw, props.conclusion);
    return (_jsxs("div", { className: "fg-error", role: "alert", children: [_jsxs("div", { className: "fg-error-title", children: [_jsxs("span", { children: ["\u26A0 ", diagnosis.conclusion] }), _jsx("span", { className: "fg-error-code", children: diagnosis.code })] }), _jsxs("div", { className: "fg-error-cause", children: ["\u539F\u56E0\uFF1A", diagnosis.cause] }), _jsxs("div", { className: "fg-actions", children: [diagnosis.actions.map((action) => (_jsxs("span", { className: "fg-hint", children: ["\u00B7 ", action] }, action))), props.onDismiss === undefined ? null : _jsx(Btn, { variant: "ghost", onClick: props.onDismiss, children: "\u5173\u95ED" })] }), _jsxs("details", { className: "fg-details", children: [_jsx("summary", { children: "\u6280\u672F\u7EC6\u8282\uFF08\u4F9B\u6392\u969C\u4F7F\u7528\uFF09" }), _jsx("code", { className: "fg-code", children: props.raw })] })] }));
}
/** Poll one endpoint. Stops while the tab is hidden, so a background GUI idles. */
function usePoll(path, intervalMs) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [nonce, setNonce] = useState(0);
    const pathRef = useRef(path);
    pathRef.current = path;
    useEffect(() => {
        if (path === null) {
            setData(null);
            return;
        }
        let cancelled = false;
        const tick = async () => {
            if (document.hidden)
                return;
            try {
                const result = await api(path);
                if (!cancelled) {
                    setData(result);
                    setError(null);
                }
            }
            catch (cause) {
                if (!cancelled)
                    setError(cause.message);
            }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), intervalMs);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [path, intervalMs, nonce]);
    const reload = useCallback(() => setNonce((value) => value + 1), []);
    return { data, error, reload };
}
/** Wrap an action: busy flag, error capture, and a reload callback. */
function useAction(onDone) {
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const done = useRef(onDone);
    done.current = onDone;
    const run = useCallback((label, body) => {
        setBusy(label);
        setError(null);
        void body()
            .then(() => done.current())
            .catch((cause) => setError(cause.message))
            .finally(() => setBusy(null));
    }, []);
    return { busy, error, clearError: () => setError(null), run };
}
/** The status vocabulary is a contract with the design doc: one word each. */
function stateView(status) {
    switch (status.state) {
        case 'not-installed':
            return { word: '未安装', icon: '○', tone: 'idle' };
        case 'stopped':
            return { word: '已停止', icon: '■', tone: 'idle' };
        case 'starting':
            return { word: '启动中', icon: '◌', tone: 'busy' };
        case 'running':
            return { word: '运行中', icon: '●', tone: 'ok' };
        case 'degraded':
            return { word: '降级运行', icon: '▲', tone: 'warn' };
        case 'error':
            return { word: '异常', icon: '✕', tone: 'bad' };
        case 'updating':
            return { word: '升级中', icon: '⟳', tone: 'busy' };
        default:
            return { word: String(status.state), icon: '·', tone: 'idle' };
    }
}
const TONE_CLASS = {
    idle: 'fg-state-idle',
    busy: 'fg-state-busy',
    ok: 'fg-state-ok',
    warn: 'fg-state-warn',
    bad: 'fg-state-bad',
};
function formatBytes(bytes) {
    if (bytes === null)
        return '';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDuration(ms) {
    if (ms === null)
        return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds} 秒`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
const JOB_PHASE_WORD = {
    queued: '排队中',
    resolving: '解析中',
    downloading: '下载中',
    verifying: '校验中',
    extracting: '解压中',
    activating: '切换版本',
    starting: '启动中',
    confirming: '确认中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
};
// ──────────────────────────────────────────────────────────────── 各 tab 面板
function JobProgress(props) {
    const job = props.job;
    if (job === null)
        return null;
    // A finished job stays visible until the next one starts — after a failure the
    // user needs to see why, and the reason must outlive the task.
    const terminal = job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled';
    if (terminal && job.phase === 'done' && job.noop) {
        return _jsx("div", { className: "fg-hint", children: job.message ?? '无需操作' });
    }
    return (_jsxs("div", { children: [_jsxs("div", { className: "fg-row", children: [_jsxs("div", { className: "fg-row-main", children: [_jsxs("div", { children: [job.label, " \u00B7 ", JOB_PHASE_WORD[job.phase], job.percent === null ? '' : ` · ${job.percent}%`] }), job.message === null ? null : _jsx("div", { className: "fg-row-sub", children: job.message }), job.error === null ? null : _jsxs("div", { className: "fg-row-sub fg-state-bad", children: ["\u539F\u56E0\uFF1A", job.error] })] }), props.busy && !terminal ? _jsx(Btn, { onClick: props.onCancel, children: "\u53D6\u6D88" }) : null] }), terminal ? null : (_jsx("div", { className: `fg-progress${job.percent === null ? ' fg-progress-indeterminate' : ''}`, children: _jsx("i", { style: { width: job.percent === null ? '32%' : `${job.percent}%` } }) })), job.bytesTotal === null || job.bytesDone === null ? null : (_jsxs("div", { className: "fg-hint", children: [formatBytes(job.bytesDone), " / ", formatBytes(job.bytesTotal)] })), job.attemptedSources.length > 1 ? _jsxs("div", { className: "fg-hint", children: ["\u5DF2\u5C1D\u8BD5\u6765\u6E90\uFF1A", job.attemptedSources.join(' → ')] }) : null] }));
}
function ServicePanel(props) {
    const { status, reload } = props;
    const job = usePoll('/jobs/current', 900);
    const catalog = usePoll('/install/catalog', 30_000);
    const action = useAction(reload);
    const [version, setVersion] = useState('');
    const [allowUnverified, setAllowUnverified] = useState(false);
    const [confirmUninstall, setConfirmUninstall] = useState(false);
    const busy = action.busy !== null;
    const versions = catalog.data?.versions ?? [];
    const recommended = catalog.data?.recommended ?? null;
    const installed = status.installedVersions;
    const updateAvailable = recommended !== null && status.currentVersion !== recommended;
    const startInstall = (target) => {
        action.run('install', () => post('/install', { version: target, allowUnverified, reinstall: target !== null && target === status.currentVersion }));
    };
    return (_jsxs("div", { className: "fg-root", children: [action.error === null ? null : _jsx(ErrorCard, { raw: action.error, conclusion: "\u670D\u52A1\u64CD\u4F5C\u672A\u5B8C\u6210", onDismiss: action.clearError }), job.error === null ? null : _jsx(ErrorCard, { raw: job.error, conclusion: "\u65E0\u6CD5\u8BFB\u53D6\u4EFB\u52A1\u72B6\u6001" }), _jsxs(Card, { title: "\u7248\u672C", children: [_jsxs("dl", { className: "fg-grid", children: [_jsx("dt", { children: "\u5F53\u524D\u7248\u672C" }), _jsx("dd", { children: status.currentVersion ?? '—' }), _jsx("dt", { children: "\u53EF\u5347\u7EA7\u5230" }), _jsxs("dd", { children: [recommended ?? '—', updateAvailable ? _jsx("span", { className: "fg-tag fg-tag-busy", style: { marginLeft: 8 }, children: "\u6709\u66F4\u65B0" }) : null] }), _jsx("dt", { children: "\u4E0A\u4E00\u53EF\u7528\u7248\u672C" }), _jsx("dd", { children: status.lastKnownGood ?? '—' }), _jsx("dt", { children: "\u5DF2\u5B89\u88C5" }), _jsx("dd", { className: "fg-mono", children: installed.length === 0 ? '—' : installed.join('、') }), _jsx("dt", { children: "\u517C\u5BB9\u533A\u95F4" }), _jsxs("dd", { className: "fg-mono", children: ["\u2265 ", status.manifest.minSupportedServer, status.manifest.maxTestedServer === null ? '' : ` · 已测至 ${status.manifest.maxTestedServer}`] })] }), _jsxs("div", { className: "fg-actions", children: [updateAvailable ? (_jsx(Btn, { variant: "primary", disabled: busy, onClick: () => startInstall(null), children: status.currentVersion === null ? '安装后台服务' : `升级到 v${recommended}` })) : null, status.currentVersion === null ? null : (_jsx(Btn, { disabled: busy, onClick: () => startInstall(status.currentVersion), children: "\u91CD\u65B0\u5B89\u88C5\u5F53\u524D\u7248\u672C" })), status.lastKnownGood === null || status.lastKnownGood === status.currentVersion ? null : (_jsxs(Btn, { disabled: busy, onClick: () => action.run('rollback', () => post('/install/rollback', { version: status.lastKnownGood })), children: ["\u56DE\u6EDA\u5230 v", status.lastKnownGood] }))] })] }), _jsxs(Card, { title: "\u6307\u5B9A\u7248\u672C", children: [_jsx("div", { className: "fg-hint", children: "\u4E0A\u6E38\u5404\u5E73\u53F0\u7684\u53D1\u5E03\u8282\u594F\u4E0D\u4E00\u81F4\uFF1AWindows \u505C\u5728 1.2.19\uFF0CmacOS Intel \u4E0E Linux arm64 \u4E5F\u843D\u540E\u4E8E\u6700\u65B0\u7248\u3002\u8FD9\u91CC\u5217\u51FA\u7684\u662F\u672C\u673A\u5E73\u53F0\u771F\u5B9E\u5B58\u5728\u7684\u7248\u672C\u3002" }), _jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-version", children: "\u7248\u672C" }), _jsxs("select", { id: "fg-version", className: "fg-input", value: version, onChange: (event) => setVersion(event.target.value), children: [_jsxs("option", { value: "", children: ["\uFF08\u4F7F\u7528\u63A8\u8350\u7248\u672C ", recommended ?? '—', "\uFF09"] }), versions.map((entry) => (_jsxs("option", { value: entry.version, children: [entry.version, entry.installed ? '（已安装）' : '', entry.unverified ? '（无校验值）' : ''] }, entry.version)))] })] }), _jsxs("label", { className: "fg-check", children: [_jsx("input", { type: "checkbox", checked: allowUnverified, onChange: (event) => setAllowUnverified(event.target.checked) }), _jsxs("span", { children: ["\u5141\u8BB8\u5B89\u88C5\u6CA1\u6709\u6821\u9A8C\u503C\u7684\u7248\u672C", _jsx("div", { className: "fg-hint", children: "\u4E0A\u6E38\u672A\u4E3A\u8BE5\u8D44\u4EA7\u63D0\u4F9B sha256 \u65F6\u65E0\u6CD5\u6821\u9A8C\u5B8C\u6574\u6027\u3002\u9ED8\u8BA4\u62D2\u7EDD\uFF1B\u53EA\u6709\u4F60\u786E\u8BA4\u6765\u6E90\u53EF\u4FE1\u65F6\u624D\u5E94\u5F00\u542F\u3002" })] })] }), _jsxs("div", { className: "fg-actions", children: [_jsx(Btn, { disabled: busy || versions.length === 0, onClick: () => startInstall(version === '' ? null : version), children: "\u5B89\u88C5\u6240\u9009\u7248\u672C" }), _jsx(Btn, { variant: "ghost", onClick: catalog.reload, children: "\u91CD\u65B0\u8BFB\u53D6\u6E05\u5355" })] })] }), _jsxs(Card, { title: "\u63A7\u5236", children: [_jsxs("div", { className: "fg-actions", style: { marginTop: 0 }, children: [_jsx(Btn, { disabled: busy, onClick: () => action.run('start', () => post('/service/start')), children: "\u542F\u52A8" }), _jsx(Btn, { variant: "danger", disabled: busy, onClick: () => action.run('stop', () => post('/service/stop')), children: "\u505C\u6B62" }), _jsx(Btn, { disabled: busy, onClick: () => action.run('restart', () => post('/service/restart')), children: "\u91CD\u542F" })] }), _jsxs("dl", { className: "fg-grid", style: { marginTop: 10 }, children: [_jsx("dt", { children: "\u8FDB\u7A0B\u53F7" }), _jsx("dd", { className: "fg-mono", children: status.pid ?? '—' }), _jsx("dt", { children: "\u76D1\u542C\u7AEF\u53E3" }), _jsxs("dd", { className: "fg-mono", children: [status.port, status.effectivePort === null || status.effectivePort === status.port ? '' : `（实际 ${status.effectivePort}）`] }), _jsx("dt", { children: "\u8FD0\u884C\u65F6\u957F" }), _jsx("dd", { children: formatDuration(status.uptimeMs) || '—' }), _jsx("dt", { children: "\u672C\u6B21\u4F1A\u8BDD\u91CD\u542F" }), _jsx("dd", { children: status.restarts === 0 ? '无' : `${status.restarts} 次` })] }), job.data?.job === null || job.data === null ? null : (_jsx("div", { style: { marginTop: 10 }, children: _jsx(JobProgress, { job: job.data.job, busy: job.data.busy, onCancel: () => action.run('cancel', () => post('/jobs/cancel')) }) }))] }), _jsxs(Card, { title: "\u5378\u8F7D", children: [_jsxs("div", { className: "fg-hint", children: ["\u5378\u8F7D\u4F1A\u505C\u6B62\u540E\u53F0\u670D\u52A1\u5E76\u5220\u9664\u5DF2\u5B89\u88C5\u7684\u7248\u672C\u76EE\u5F55\u3002", _jsx("strong", { children: "data/ \u76EE\u5F55\u9ED8\u8BA4\u4FDD\u7559" }), "\u2014\u2014\u8BBE\u5907\u6807\u8BC6\u3001\u6388\u6743\u7801\u4E0E\u5404\u5E73\u53F0\u767B\u5F55 token \u90FD\u5728\u90A3\u91CC\uFF0C\u5220\u9664\u540E\u9700\u8981\u91CD\u65B0\u767B\u5F55\u3001\u5E76\u53EF\u80FD\u91CD\u65B0\u6D88\u8017\u8BD5\u7528\u671F\u3002"] }), _jsx("div", { className: "fg-actions", children: confirmUninstall ? (_jsxs(_Fragment, { children: [_jsx(Btn, { variant: "danger", disabled: busy, onClick: () => {
                                        setConfirmUninstall(false);
                                        action.run('uninstall', () => post('/install/uninstall', { purgeData: false }));
                                    }, children: "\u786E\u8BA4\u5378\u8F7D\uFF08\u4FDD\u7559\u6570\u636E\uFF09" }), _jsx(Btn, { variant: "danger", disabled: busy, onClick: () => {
                                        setConfirmUninstall(false);
                                        action.run('uninstall', () => post('/install/uninstall', { purgeData: true }));
                                    }, children: "\u786E\u8BA4\u5378\u8F7D\u5E76\u5220\u9664\u6570\u636E" }), _jsx(Btn, { variant: "ghost", onClick: () => setConfirmUninstall(false), children: "\u53D6\u6D88" })] })) : (_jsx(Btn, { variant: "danger", disabled: busy, onClick: () => setConfirmUninstall(true), children: "\u5378\u8F7D\u540E\u53F0\u670D\u52A1" })) })] })] }));
}
function LicensePanel(props) {
    const overview = usePoll('/account/overview', 10_000);
    const action = useAction(props.reload);
    const [key, setKey] = useState('');
    const [confirmClear, setConfirmClear] = useState(false);
    const license = overview.data?.license ?? null;
    const info = overview.data?.info ?? null;
    const busy = action.busy !== null;
    const edition = license?.edition ?? info?.license.edition ?? null;
    const editionTag = (() => {
        if (edition === 'licensed')
            return { text: '授权版', cls: 'fg-tag-ok' };
        if (edition === 'expired')
            return { text: '订阅已过期', cls: 'fg-tag-bad' };
        if (license?.subscriptionActive === false)
            return { text: '免费', cls: '' };
        return { text: '免费', cls: '' };
    })();
    return (_jsxs("div", { className: "fg-root", children: [action.error === null ? null : _jsx(ErrorCard, { raw: action.error, conclusion: "\u6388\u6743\u64CD\u4F5C\u672A\u5B8C\u6210", onDismiss: action.clearError }), overview.data !== null && overview.data.reachable === false ? (_jsx(Card, { children: _jsx("div", { className: "fg-empty", children: "\u540E\u53F0\u670D\u52A1\u672A\u8FD0\u884C\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u6388\u6743\u72B6\u6001\u3002\u6388\u6743\u4FE1\u606F\u4FDD\u5B58\u5728\u672C\u673A data/license.json\uFF0C\u542F\u52A8\u670D\u52A1\u540E\u4F1A\u7ACB\u5373\u6062\u590D\u663E\u793A\u3002" }) })) : null, _jsxs(Card, { title: _jsxs("span", { children: ["\u6388\u6743\u72B6\u6001 ", _jsx("span", { className: `fg-tag ${editionTag.cls}`, children: editionTag.text })] }), children: [_jsxs("dl", { className: "fg-grid", children: [_jsx("dt", { children: "\u6388\u6743\u7801" }), _jsx("dd", { className: "fg-mono", children: license?.keyMasked === null || license?.keyMasked === '' ? '未填写' : license?.keyMasked }), _jsx("dt", { children: "\u4EA7\u54C1" }), _jsx("dd", { children: license?.product ?? info?.license.product ?? '—' }), _jsx("dt", { children: "\u8BBE\u5907\u6807\u8BC6" }), _jsxs("dd", { children: [_jsx("span", { className: "fg-mono", children: license?.deviceId ?? info?.deviceId ?? '—' }), ' ', license?.deviceId === null || license?.deviceId === undefined ? null : _jsx(Copy, { value: license.deviceId })] }), _jsx("dt", { children: "\u8BA2\u9605\u5230\u671F" }), _jsx("dd", { children: license?.subscriptionExpiresAt ?? '—（永久或未订阅）' }), _jsx("dt", { children: "\u5BBD\u9650\u671F" }), _jsxs("dd", { children: [license?.gracePeriodExpiresAt ?? '—', license?.graceRemainingDays === null || license?.graceRemainingDays === undefined
                                        ? ''
                                        : ` · 还剩 ${license.graceRemainingDays} 天`] }), _jsx("dt", { children: "\u4E91\u7AEF\u89C4\u5219" }), _jsxs("dd", { children: [license?.capabilitiesLoaded === true ? '已同步' : '未同步（显示为本地默认规则）', license?.capabilitiesMessage === null || license?.capabilitiesMessage === undefined ? '' : ` · ${license.capabilitiesMessage}`] })] }), _jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-license", children: "\u8F93\u5165\u6388\u6743\u7801" }), _jsx("input", { id: "fg-license", className: "fg-input", placeholder: "FG-XXXX-XXXX-XXXX", value: key, onChange: (event) => setKey(event.target.value) })] }), _jsxs("div", { className: "fg-actions", children: [_jsx(Btn, { variant: "primary", disabled: busy || key.trim() === '', onClick: () => action.run('activate', async () => {
                                    await post('/license/activate', { licenseKey: key.trim() });
                                    setKey('');
                                }), children: "\u5199\u5165\u5E76\u6FC0\u6D3B" }), confirmClear ? (_jsxs(_Fragment, { children: [_jsx(Btn, { variant: "danger", disabled: busy, onClick: () => { setConfirmClear(false); action.run('deactivate', () => post('/license/deactivate')); }, children: "\u786E\u8BA4\u89E3\u9664" }), _jsx(Btn, { variant: "ghost", onClick: () => setConfirmClear(false), children: "\u53D6\u6D88" })] })) : (_jsx(Btn, { variant: "danger", disabled: busy, onClick: () => setConfirmClear(true), children: "\u89E3\u9664\u6388\u6743" }))] })] }), _jsxs(Card, { title: "\u5E73\u53F0\u80FD\u529B", children: [_jsxs("div", { className: "fg-hint", children: ["\u8FD9\u4E00\u680F\u662F", _jsx("strong", { children: "\u6388\u6743" }), "\u80FD\u8986\u76D6\u54EA\u4E9B\u5E73\u53F0\u3001\u5404\u81EA\u8BD5\u7528\u8FD8\u5269\u591A\u4E45\uFF0C\u7531\u670D\u52A1\u7AEF\u4E0B\u53D1\u7684\u89C4\u5219\u51B3\u5B9A\uFF1B\u5B83\u4E0D\u662F\u767B\u5F55\u72B6\u6001\uFF08\u767B\u5F55\u72B6\u6001\u89C1\u300C\u8D26\u53F7\u603B\u89C8\u300D\uFF09\u3002"] }), (license?.platforms ?? []).length === 0 ? (_jsx("div", { className: "fg-empty", children: "\u5C1A\u672A\u62FF\u5230\u5E73\u53F0\u80FD\u529B\u5217\u8868\u3002" })) : ((license?.platforms ?? []).map((entry) => (_jsx(Row, { main: entry.platform, sub: entry.message ?? undefined, right: _jsxs("span", { className: `fg-tag ${entry.enabled ? 'fg-tag-ok' : 'fg-tag-warn'}`, children: [entry.enabled ? '可用' : '不可用', entry.trialRemainingDays === null || entry.trialRemainingDays === undefined
                                    ? ''
                                    : ` · 试用剩 ${entry.trialRemainingDays} 天`] }) }, entry.platform))))] })] }));
}
function AccountsPanel(props) {
    const overview = usePoll('/account/overview', 10_000);
    const data = overview.data;
    return (_jsxs("div", { className: "fg-root", children: [_jsxs(Card, { title: "\u5E73\u53F0\u8D26\u53F7", children: [_jsxs("div", { className: "fg-hint", children: ["\u8FD9\u4E00\u680F\u662F", _jsx("strong", { children: "\u767B\u5F55" }), "\u72B6\u6001\u3002\u767B\u5F55\u52A8\u4F5C\u5728\u300C", _jsx("strong", { children: "\u5E73\u53F0\u767B\u5F55" }), "\u300D\u6807\u7B7E\u91CC\u5B8C\u6210\uFF08\u4E5F\u53EF\u4EE5\u7EE7\u7EED\u5728\u804A\u5929\u91CC\u8BA9\u6A21\u578B\u8C03\u7528\u5DE5\u5177\uFF09\u3002"] }), data === null || data.reachable === false ? (_jsx("div", { className: "fg-empty", children: "\u540E\u53F0\u670D\u52A1\u672A\u8FD0\u884C\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u5E73\u53F0\u767B\u5F55\u72B6\u6001\u3002" })) : data.platforms.length === 0 ? (_jsx("div", { className: "fg-empty", children: "\u670D\u52A1\u7AEF\u672A\u8FD4\u56DE\u5E73\u53F0\u5217\u8868\u3002" })) : (data.platforms.map((entry) => {
                        const sub = accountSummary(entry);
                        return (_jsx(Row, { main: entry.platformName, sub: sub, right: _jsx("span", { className: `fg-tag ${entry.authenticated ? 'fg-tag-ok' : ''}`, children: entry.authenticated ? '账号已登录' : '账号未登录' }) }, entry.platformId));
                    }))] }), _jsx(Card, { title: "\u6444\u50CF\u5934", children: data?.cameraSupported === false ? (_jsx("div", { className: "fg-hint", children: "\u5F53\u524D\u5E73\u53F0\u7684\u4E0A\u6E38\u6784\u5EFA\u4E0D\u5305\u542B\u6444\u50CF\u5934\u80FD\u529B\uFF08Windows \u7248\u672C\u7F16\u8BD1\u65F6\u5173\u95ED\u4E86\u53D6\u6D41\uFF09\uFF0C\u56E0\u6B64\u8FD9\u91CC\u4E0D\u4F1A\u6709\u6444\u50CF\u5934\u3002\u5176\u5B83\u5E73\u53F0\u529F\u80FD\u4E0D\u53D7\u5F71\u54CD\u3002" })) : data === null || data.reachable === false ? (_jsx("div", { className: "fg-empty", children: "\u540E\u53F0\u670D\u52A1\u672A\u8FD0\u884C\u3002" })) : data.cameras.length === 0 ? (_jsx("div", { className: "fg-empty", children: "\u6CA1\u6709\u6444\u50CF\u5934\u3002\u82E5\u5DF2\u767B\u5F55\u7C73\u5BB6\uFF0C\u53EF\u5728\u804A\u5929\u91CC\u8BA9\u6A21\u578B\u8C03\u7528 xiaomi/camera_list \u5237\u65B0\u3002" })) : (data.cameras.map((camera) => (_jsx(Row, { main: camera.name, sub: camera.deviceId, right: _jsx("span", { className: `fg-tag ${camera.online ? 'fg-tag-ok' : 'fg-tag-warn'}`, children: camera.online ? '在线' : '离线' }) }, camera.deviceId)))) })] }));
}
// ─────────────────────────────────────────────────────────── 平台登录面板
//
// 登录动作从聊天搬到这里，但**能力仍在后台服务这一侧**：`GET /auth/capabilities`
// 返回子进程真正注册了哪些授权工具，本机上游构建缺少的平台就如实显示"本构建不支持"，
// 而不是给一个必然失败的按钮（实测 macOS 版 v1.2.19 完全没有华为工具与路由）。
//
// 凭据只经过本机回环交给子进程：插件不落盘、不写日志，也不回显；账号/密码一律
// `type="password"`，且只在本组件状态里存活，切走即丢。
/** `区域 cn · 登录有效期剩 2 天` —— 与「账号总览」用同一套词。 */
function accountSummary(account) {
    const remaining = account.authStatus['token_remaining_seconds'];
    const region = account.authStatus['cloud_server'] ?? account.authStatus['region'];
    const parts = [
        typeof region === 'string' && region !== '' ? `区域 ${region}` : null,
        typeof remaining === 'number' ? `登录有效期剩 ${formatDuration(remaining * 1000)}` : null,
    ].filter((part) => part !== null);
    return parts.length === 0 ? undefined : parts.join(' · ');
}
function Field(props) {
    return (_jsxs("div", { className: "fg-field", children: [_jsx("label", { children: props.label }), _jsx("input", { className: "fg-input", type: props.type ?? 'text', value: props.value, placeholder: props.placeholder ?? '', onChange: (event) => props.onChange(event.target.value) }), props.hint === undefined ? null : _jsx("div", { className: "fg-hint", children: props.hint })] }));
}
function Select(props) {
    return (_jsxs("div", { className: "fg-field", children: [_jsx("label", { children: props.label }), _jsx("select", { className: "fg-input", value: props.value, onChange: (event) => props.onChange(event.target.value), children: props.options.map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }));
}
/** One platform's card: name, live status, and either the flow or the reason. */
function PlatformCard(props) {
    const account = props.account;
    const summary = account === undefined ? undefined : accountSummary(account);
    return (_jsxs(Card, { title: 
        // 标题本身就是 flex 行（.fg-card-title），不要再套 .fg-row —— 那个类带 border-top，
        // 会在平台名上方画一条多余的横线。
        _jsxs(_Fragment, { children: [props.name, _jsx("span", { className: `fg-tag ${account?.authenticated === true ? 'fg-tag-ok' : ''}`, children: account === undefined ? '状态未知' : account.authenticated ? '已登录' : '未登录' })] }), children: [summary === undefined ? null : _jsx("div", { className: "fg-hint", children: summary }), props.unavailable == null || props.unavailable === '' ? (props.children) : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-warn", children: "\u672C\u6784\u5EFA\u4E0D\u652F\u6301" }), " ", props.unavailable] }))] }));
}
/** 退出登录：调一次宿主接口，然后让状态重新拉取。 */
function LogoutButton(props) {
    const action = useAction(props.onDone);
    if (!props.available) {
        return _jsxs("div", { className: "fg-hint", children: ["\u9000\u51FA\u767B\u5F55\uFF1A", props.reason ?? '当前上游构建没有该平台的退出接口'] });
    }
    return (_jsxs("div", { children: [_jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "danger", disabled: action.busy !== null, onClick: () => action.run('logout', () => post('/auth/logout', { platform: props.platformId })), children: action.busy === null ? '退出登录' : '正在退出…' }) }), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError })] }));
}
function XiaomiLogin(props) {
    const hasUrl = props.tools.has('xiaomi/auth_url') && props.tools.has('xiaomi/auth_callback');
    const [region, setRegion] = useState('cn');
    const [url, setUrl] = useState(null);
    // 发起授权时的区域要沿用给回调：上游 callback 的 region 会覆盖当前区域，
    // 两步之间用户改了下拉框就会导致"看不到设备"（桌面端也用 regionRef 这么做）。
    const [urlRegion, setUrlRegion] = useState('cn');
    const [auto, setAuto] = useState(false);
    const [showFallback, setShowFallback] = useState(false);
    const [pasted, setPasted] = useState('');
    const [done, setDone] = useState(null);
    const action = useAction(props.reload);
    const authenticated = props.account?.authenticated === true;
    // 保持 reload 最新引用，轮询定时器里用 ref 取，避免闭包过期
    const reloadRef = useRef(props.reload);
    reloadRef.current = props.reload;
    // 自动回调模式（v1.2.21+）：授权 URL 的 redirect_uri 指向后台服务自身，
    // 用户在浏览器登录完成后本机服务自动完成 code 交换 —— 这里只负责发现
    // 登录状态翻转，等价于 Android 端"拦截回调自动授权"的体验。
    useEffect(() => {
        if (url === null)
            return;
        if (authenticated) {
            setDone(`授权成功（区域 ${urlRegion}）`);
            setUrl(null);
            setShowFallback(false);
            setPasted('');
            return;
        }
        const timer = setInterval(() => reloadRef.current(), 2500);
        return () => clearInterval(timer);
    }, [url, authenticated, urlRegion]);
    return (_jsxs(PlatformCard, { name: "\u7C73\u5BB6\uFF08\u5C0F\u7C73\uFF09", account: props.account, unavailable: hasUrl ? null : '当前上游构建没有米家授权工具（xiaomi/auth_url、xiaomi/auth_callback）。', children: [_jsx("div", { className: "fg-hint", children: auto === true
                    ? '三步：选区域 → 获取授权地址 → 在浏览器里登录。登录成功后浏览器会自动跳回本机服务完成授权（页面显示"授权成功"），无需粘贴任何地址 —— 本页会自动检测并更新登录状态。'
                    : '三步：选区域 → 获取授权地址 → 在浏览器里登录并确认授权。登录完成后浏览器会跳到一个打不开的页面（https://127.0.0.1/?code=…），这是正常的 —— 授权码只在该页面的地址栏里；把地址栏整段复制下来，粘贴到下方"粘贴回调地址"输入框，点"完成授权"即可。' }), _jsx("div", { className: "fg-form-2", children: _jsx(Select, { label: "\u8D26\u53F7\u533A\u57DF", value: region, onChange: setRegion, options: [
                        { value: 'cn', label: 'cn 中国大陆' },
                        { value: 'de', label: 'de 欧洲（德国）' },
                        { value: 'i2', label: 'i2 印度' },
                        { value: 'ru', label: 'ru 俄罗斯' },
                        { value: 'sg', label: 'sg 新加坡' },
                        { value: 'us', label: 'us 美国' },
                    ] }) }), _jsx("div", { className: "fg-hint", children: "\u9009\u9519\u533A\u57DF\u4F1A\u770B\u4E0D\u5230\u8BBE\u5907\uFF1B\u5E94\u9009\u8D26\u53F7\u5B9E\u9645\u4F7F\u7528\u7684\u533A\u57DF\u3002" }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null, onClick: () => action.run('xiaomi-url', async () => {
                        const result = await post('/auth/xiaomi/url', { region });
                        setUrl(result.url);
                        setUrlRegion(region);
                        setAuto(result.autoCallback === true);
                        setDone(null);
                    }), children: action.busy === null ? '获取授权地址' : '正在获取…' }) }), url === null ? null : (_jsxs("div", { children: [_jsxs("div", { className: "fg-actions", children: [_jsx("a", { className: "fg-link", href: url, target: "_blank", rel: "noreferrer", children: "\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u6388\u6743\u9875" }), _jsx(Copy, { value: url, label: "\u590D\u5236\u5730\u5740" })] }), auto ? (_jsxs("div", { className: "fg-hint", children: ["\u7B49\u5F85\u767B\u5F55\u7ED3\u679C\u2026\uFF08\u767B\u5F55\u5B8C\u6210\u540E\u6D4F\u89C8\u5668\u4F1A\u8DF3\u5230 ", _jsx("code", { className: "fg-code", children: "\u6388\u6743\u6210\u529F" }), " \u9875\u9762\uFF0C\u672C\u9875\u81EA\u52A8\u66F4\u65B0\u72B6\u6001\uFF09"] })) : null, auto && !showFallback ? (_jsxs("div", { className: "fg-hint", children: ["\u81EA\u52A8\u6388\u6743\u6CA1\u6709\u53CD\u5E94\uFF1F", _jsx("a", { className: "fg-link", onClick: () => setShowFallback(true), children: "\u624B\u52A8\u7C98\u8D34\u56DE\u8C03\u5730\u5740" })] })) : null, (!auto || showFallback) ? (_jsxs("div", { children: [_jsx(Field, { label: "\u7C98\u8D34\u56DE\u8C03\u5730\u5740\uFF08\u6216\u53EA\u7C98 code\uFF09", value: pasted, onChange: setPasted, placeholder: "https://127.0.0.1/?code=\u2026" }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || pasted.trim() === '', onClick: () => action.run('xiaomi-callback', async () => {
                                        const result = await post('/auth/xiaomi/callback', { input: pasted, region: urlRegion });
                                        setDone(result.region === null ? '授权成功' : `授权成功（区域 ${result.region}）`);
                                        setUrl(null);
                                        setPasted('');
                                    }), children: action.busy === null ? '完成授权' : '正在交换令牌…' }) })] })) : null] })), done === null ? null : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-ok", children: "\u6210\u529F" }), " ", done] })), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError }), _jsx(LogoutButton, { platformId: "xiaomi", onDone: props.reload, available: authenticated, reason: "\u767B\u5F55\u540E\u624D\u80FD\u9000\u51FA" })] }));
}
function TuyaLogin(props) {
    const hasQr = props.tools.has('auth/tuya_qr') && props.tools.has('auth/tuya_qr_status');
    const { reload } = props;
    const [userCode, setUserCode] = useState('');
    const [ticket, setTicket] = useState(null);
    const [generatedAt, setGeneratedAt] = useState(0);
    const [scan, setScan] = useState('idle');
    const [detail, setDetail] = useState(null);
    /** 非终态的等待说明（网络抖动等）：页面继续轮询，不把失败标签甩给用户。 */
    const [transient, setTransient] = useState(null);
    const action = useAction(props.reload);
    // 扫码等待放在服务端（单次最多 35 秒），这里只管循环再问一次：
    // 用户扫得快就即时返回，扫得慢也不会把页面变成一堆失败请求。
    // 单次请求失败（网络抖动、dsh 重启瞬间）同样只算等待中的插曲：
    // 在二维码有效期内继续问，终态失败只留给「已过期」。
    useEffect(() => {
        if (ticket === null || scan !== 'waiting')
            return;
        let cancelled = false;
        const loop = async () => {
            const expiresAt = generatedAt + Math.max(30, ticket.expireSeconds) * 1000;
            while (!cancelled) {
                if (Date.now() > expiresAt) {
                    setScan('error');
                    setDetail('二维码已过期，请重新生成（涂鸦二维码有效期很短）');
                    return;
                }
                try {
                    const status = await post('/auth/tuya/status', { token: ticket.token, userCode });
                    if (cancelled)
                        return;
                    if (status.status === 'authorized') {
                        setScan('authorized');
                        setDetail(status.uid === null ? '涂鸦账号已登录' : `涂鸦账号已登录（uid ${status.uid}）`);
                        reload();
                        return;
                    }
                    if (status.status === 'error') {
                        setScan('error');
                        setDetail(status.message ?? '二维码已失效，请重新生成');
                        return;
                    }
                }
                catch (cause) {
                    if (cancelled)
                        return;
                    setTransient(`请求没有成功（${cause.message}），自动重试中…`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
            }
        };
        void loop();
        return () => {
            cancelled = true;
        };
    }, [ticket, scan, userCode, generatedAt, reload]);
    const qrSrc = ticket === null ? null : withApiPrefix(ticket.imageUrl);
    return (_jsxs(PlatformCard, { name: "\u6D82\u9E26\uFF08Tuya\uFF09", account: props.account, unavailable: hasQr ? null : '当前上游构建没有涂鸦二维码工具（auth/tuya_qr）。', children: [_jsxs("div", { className: "fg-hint", children: ["\u7528\u6237\u4EE3\u7801\u5728\u6D82\u9E26 App \u91CC\uFF1A", _jsx("strong", { children: "\u6211\u7684 \u2192 \u8BBE\u7F6E \u2192 \u8D26\u53F7\u4E0E\u5B89\u5168 \u2192 \u7528\u6237\u4EE3\u7801" }), "\u3002\u586B\u597D\u540E\u751F\u6210\u4E8C\u7EF4\u7801\uFF0C\u7528\u6D82\u9E26 App \u53F3\u4E0A\u89D2 \u300C+ \u2192 \u626B\u4E00\u626B\u300D\u626B\u5B83\uFF0C\u518D\u5728 App \u91CC\u70B9\u300C\u786E\u8BA4\u767B\u5F55\u300D\u3002"] }), _jsx(Field, { label: "\u7528\u6237\u4EE3\u7801", value: userCode, onChange: setUserCode, placeholder: "AY1790336520\u2026" }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || userCode.trim() === '', onClick: () => action.run('tuya-qr', async () => {
                        const result = await post('/auth/tuya/qr', { userCode });
                        setTicket(result);
                        setGeneratedAt(Date.now());
                        setScan('waiting');
                        setDetail(null);
                        setTransient(null);
                    }), children: action.busy === null ? (ticket === null ? '生成二维码' : '重新生成') : '正在生成…' }) }), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError }), ticket === null || qrSrc === null ? null : (_jsxs("div", { children: [_jsx("img", { className: "fg-qr", src: qrSrc, alt: "\u6D82\u9E26\u6388\u6743\u4E8C\u7EF4\u7801" }), _jsxs("div", { className: "fg-hint", children: ["\u4E8C\u7EF4\u7801 ", ticket.expireSeconds, " \u79D2\u5185\u6709\u6548\u3002", scan === 'waiting' ? '正在等你扫码（会一直等到扫到为止，页面不用管）。' : null, scan === 'authorized' ? ' 已扫码确认。' : null, _jsx("a", { className: "fg-link", href: withApiPrefix(ticket.textUrl), target: "_blank", rel: "noreferrer", children: "\u56FE\u7247\u663E\u793A\u4E0D\u51FA\u6765\uFF1F\u7528\u6587\u672C\u4E8C\u7EF4\u7801" })] })] })), detail === null && transient === null ? null : (_jsx("div", { className: "fg-hint", children: transient !== null ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "fg-tag", children: "\u91CD\u8BD5" }), " ", transient] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: `fg-tag ${scan === 'authorized' ? 'fg-tag-ok' : 'fg-tag-bad'}`, children: scan === 'authorized' ? '成功' : '失败' }), " ", detail] })) })), _jsx(LogoutButton, { platformId: "tuya", onDone: props.reload, available: props.tools.has('auth/tuya_logout'), reason: "\u5F53\u524D\u4E0A\u6E38\u6784\u5EFA\u6CA1\u6709\u6D82\u9E26\u9000\u51FA\u5DE5\u5177\uFF08auth/tuya_logout\uFF09" })] }));
}
function MideaLogin(props) {
    const hasLogin = props.tools.has('auth/midea_login');
    const [account, setAccount] = useState('');
    const [password, setPassword] = useState('');
    const [cloud, setCloud] = useState('meiju');
    const [done, setDone] = useState(null);
    const action = useAction(props.reload);
    return (_jsxs(PlatformCard, { name: "\u7F8E\u7684\uFF08Midea\uFF09", account: props.account, unavailable: hasLogin ? null : '当前上游构建没有美的登录工具（auth/midea_login）。', children: [_jsx("div", { className: "fg-hint", children: "\u8D26\u53F7\u5BC6\u7801\u76F4\u63A5\u4EA4\u7ED9\u672C\u673A\u540E\u53F0\u670D\u52A1\uFF08127.0.0.1\uFF09\uFF0C\u63D2\u4EF6\u4E0D\u4FDD\u5B58\u3001\u4E0D\u5199\u65E5\u5FD7\u3002" }), _jsxs("div", { className: "fg-form-2", children: [_jsx(Field, { label: "\u7F8E\u7684\u8D26\u53F7", value: account, onChange: setAccount, placeholder: "\u624B\u673A\u53F7 / \u90AE\u7BB1" }), _jsx(Field, { label: "\u5BC6\u7801", value: password, onChange: setPassword, type: "password" }), _jsx(Select, { label: "\u5BA2\u6237\u7AEF\u7C7B\u578B", value: cloud, onChange: setCloud, options: [
                            { value: 'meiju', label: '美居（meiju）' },
                            { value: 'msmart', label: 'MSmartHome（msmart）' },
                        ] })] }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || account.trim() === '' || password === '', onClick: () => action.run('midea-login', async () => {
                        const result = await post('/auth/midea/login', {
                            account,
                            password,
                            cloud,
                        });
                        setDone(`登录成功，已同步 ${result.deviceCount} 个设备（${result.cloud}）`);
                        setPassword('');
                    }), children: action.busy === null ? '登录' : '正在登录…' }) }), done === null ? null : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-ok", children: "\u6210\u529F" }), " ", done] })), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError }), _jsx(LogoutButton, { platformId: "midea", onDone: props.reload, available: props.tools.has('auth/midea_logout'), reason: "\u5F53\u524D\u4E0A\u6E38\u6784\u5EFA\u6CA1\u6709\u7F8E\u7684\u9000\u51FA\u5DE5\u5177\uFF08auth/midea_logout\uFF09" })] }));
}
function EwelinkLogin(props) {
    const hasLogin = props.tools.has('auth/ewelink_login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [countryCode, setCountryCode] = useState('+86');
    const [done, setDone] = useState(null);
    const action = useAction(props.reload);
    return (_jsxs(PlatformCard, { name: "\u6613\u5FAE\u8054\uFF08eWeLink\uFF09", account: props.account, unavailable: hasLogin ? null : '当前上游构建没有易微联登录工具（auth/ewelink_login）。', children: [_jsx("div", { className: "fg-hint", children: "\u8D26\u53F7\u5BC6\u7801\u76F4\u63A5\u4EA4\u7ED9\u672C\u673A\u540E\u53F0\u670D\u52A1\uFF08127.0.0.1\uFF09\uFF0C\u63D2\u4EF6\u4E0D\u4FDD\u5B58\u3001\u4E0D\u5199\u65E5\u5FD7\u3002" }), _jsxs("div", { className: "fg-form-2", children: [_jsx(Field, { label: "\u90AE\u7BB1\u6216\u624B\u673A\u53F7", value: email, onChange: setEmail }), _jsx(Field, { label: "\u5BC6\u7801", value: password, onChange: setPassword, type: "password" }), _jsx(Field, { label: "\u56FD\u5BB6\u4EE3\u7801", value: countryCode, onChange: setCountryCode, placeholder: "+86", hint: "\u8D26\u53F7\u6CE8\u518C\u5730\uFF1B\u586B\u9519\u4F1A\u767B\u5F55\u5931\u8D25\u6216\u770B\u4E0D\u5230\u8BBE\u5907\u3002" })] }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || email.trim() === '' || password === '', onClick: () => action.run('ewelink-login', async () => {
                        const result = await post('/auth/ewelink/login', { email, password, countryCode });
                        setDone(`登录成功，已同步 ${result.deviceCount} 个设备`);
                        setPassword('');
                    }), children: action.busy === null ? '登录' : '正在登录…' }) }), done === null ? null : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-ok", children: "\u6210\u529F" }), " ", done] })), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError }), _jsx(LogoutButton, { platformId: "ewelink", onDone: props.reload, available: props.tools.has('auth/ewelink_logout'), reason: "\u5F53\u524D\u4E0A\u6E38\u6784\u5EFA\u6CA1\u6709\u6613\u5FAE\u8054\u9000\u51FA\u5DE5\u5177\uFF08auth/ewelink_logout\uFF09" })] }));
}
function HuaweiLogin(props) {
    const [account, setAccount] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [needCode, setNeedCode] = useState(false);
    const [challengeName, setChallengeName] = useState(null);
    const [done, setDone] = useState(null);
    const [notice, setNotice] = useState(null);
    const action = useAction(props.reload);
    const applyOutcome = (outcome) => {
        setNeedCode(outcome.needCode);
        setChallengeName(outcome.challengeName);
        if (outcome.retryWithoutCode) {
            // 关键分流：验证码已经通过、只是换令牌失败，会话已保留。
            // 这时再要一个验证码不但无用，还会白费用户一个码。
            setNotice('验证码已通过、会话已保留：无需重新输入，可直接继续（若状态仍是未登录，稍后会自动补齐令牌）。');
            props.reload();
            return;
        }
        if (outcome.authenticated) {
            setDone('华为账号已登录');
            setPassword('');
            setCode('');
            props.reload();
        }
    };
    return (_jsxs(PlatformCard, { name: "\u534E\u4E3A\u667A\u6167\u751F\u6D3B", account: props.account, unavailable: props.tools.has('auth/huawei_login')
            ? null
            : '本机后台服务（v1.2.19）没有华为登录工具 —— 上游在 v1.2.20 才加上 auth/huawei_login / auth/huawei_challenge / auth/huawei_logout。升级后台服务后这张卡片会自动出现，无需升级插件。', children: [_jsxs("div", { className: "fg-hint", children: ["\u4E24\u6B65\u9A8C\u8BC1\uFF1A\u5148\u63D0\u4EA4\u8D26\u53F7\u5BC6\u7801\uFF0C\u518D\u63D0\u4EA4\u9A8C\u8BC1\u7801\u3002", _jsx("strong", { children: "\u534E\u4E3A\u4E0D\u53D1\u77ED\u4FE1" }), " \u2014\u2014 \u9A8C\u8BC1\u7801\u663E\u793A\u5728\u5DF2\u767B\u5F55\u7684\u534E\u4E3A\u624B\u673A/\u5E73\u677F\u5F39\u7A97\u91CC\uFF0C \u6216\u300C\u8BBE\u7F6E \u2192 \u534E\u4E3A\u5E10\u53F7 \u2192 \u5E10\u53F7\u5B89\u5168\u300D\u3002"] }), _jsxs("div", { className: "fg-form-2", children: [_jsx(Field, { label: "\u534E\u4E3A\u8D26\u53F7\uFF08\u624B\u673A\u53F7\u6216\u90AE\u7BB1\uFF09", value: account, onChange: setAccount }), _jsx(Field, { label: "\u8D26\u53F7\u5BC6\u7801", value: password, onChange: setPassword, type: "password" })] }), needCode ? (_jsxs("div", { children: [_jsx(Field, { label: "\u53CC\u91CD\u9A8C\u8BC1\u7801", value: code, onChange: setCode, hint: challengeName === null ? undefined : `上游提示验证码发往：${challengeName}` }), _jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || code.trim() === '', onClick: () => action.run('huawei-challenge', async () => {
                                setNotice(null);
                                applyOutcome(await post('/auth/huawei/challenge', { code }));
                            }), children: action.busy === null ? '提交验证码' : '正在验证…' }) })] })) : (_jsx("div", { className: "fg-actions", children: _jsx(Btn, { variant: "primary", disabled: action.busy !== null || account.trim() === '' || password === '', onClick: () => action.run('huawei-login', async () => {
                        setNotice(null);
                        applyOutcome(await post('/auth/huawei/login', { account, password }));
                    }), children: action.busy === null ? '登录' : '正在登录…' }) })), notice === null ? null : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-warn", children: "\u6CE8\u610F" }), " ", notice] })), done === null ? null : (_jsxs("div", { className: "fg-hint", children: [_jsx("span", { className: "fg-tag fg-tag-ok", children: "\u6210\u529F" }), " ", done] })), action.error === null ? null : _jsx(ErrorCard, { raw: action.error, onDismiss: action.clearError }), _jsx(LogoutButton, { platformId: "huawei", onDone: props.reload, available: props.tools.has('auth/huawei_logout'), reason: "\u672C\u673A\u4E0A\u6E38\u6784\u5EFA\u6CA1\u6709\u534E\u4E3A\u9000\u51FA\u5DE5\u5177\uFF08\u9700 v1.2.20 \u53CA\u4EE5\u4E0A\uFF09" })] }));
}
function LoginPanel(props) {
    const capabilities = usePoll('/auth/capabilities', 20_000);
    const overview = usePoll('/account/overview', 10_000);
    const caps = capabilities.data;
    const tools = useMemo(() => new Set(caps?.tools ?? []), [caps]);
    const accounts = overview.data?.platforms ?? [];
    const accountOf = (id) => accounts.find((entry) => entry.platformId === id);
    const reload = props.reload;
    if (caps === null) {
        // 能力还在路上：先别渲染各平台卡片，否则会闪一下"本构建不支持"。
        return (_jsx("div", { className: "fg-root", children: _jsx(Card, { title: "\u5E73\u53F0\u767B\u5F55", children: _jsx("div", { className: "fg-empty", children: "\u6B63\u5728\u8BFB\u53D6\u540E\u53F0\u670D\u52A1\u7684\u6388\u6743\u80FD\u529B\u2026" }) }) }));
    }
    if (caps.childReachable === false) {
        return (_jsx("div", { className: "fg-root", children: _jsx(Card, { title: "\u5E73\u53F0\u767B\u5F55", children: _jsx("div", { className: "fg-empty", children: "\u540E\u53F0\u670D\u52A1\u672A\u8FD0\u884C\uFF1A\u8BF7\u5148\u5728\u300C\u670D\u52A1\u300D\u6807\u7B7E\u91CC\u5B89\u88C5\u5E76\u542F\u52A8\uFF0C\u518D\u56DE\u5230\u8FD9\u91CC\u767B\u5F55\u3002" }) }) }));
    }
    return (_jsxs("div", { className: "fg-root", children: [_jsx(Card, { title: "\u4ECE\u8FD9\u91CC\u767B\u5F55", children: _jsxs("div", { className: "fg-hint", children: ["\u8D26\u53F7\u5BC6\u7801 / \u9A8C\u8BC1\u7801\u53EA\u5728\u672C\u673A\u56DE\u73AF\u5185\u4EA4\u7ED9\u540E\u53F0\u670D\u52A1\u8FDB\u7A0B\uFF0C", _jsx("strong", { children: "\u63D2\u4EF6\u4E0D\u4FDD\u5B58\u3001\u4E0D\u5199\u65E5\u5FD7\u3001\u4E0D\u56DE\u663E" }), "\uFF1B\u9000\u51FA\u767B\u5F55\u4F1A\u6E05\u6389\u540E\u53F0\u670D\u52A1\u91CC\u7684\u4EE4\u724C\u3002 \u300C\u8D26\u53F7\u603B\u89C8\u300D\u6807\u7B7E\u53EA\u663E\u793A\u72B6\u6001\uFF0C\u767B\u5F55\u52A8\u4F5C\u90FD\u5728\u8FD9\u91CC\u5B8C\u6210\u3002"] }) }), _jsx(XiaomiLogin, { tools: tools, account: accountOf('xiaomi'), reload: reload }), _jsx(TuyaLogin, { tools: tools, account: accountOf('tuya'), reload: reload }), _jsx(MideaLogin, { tools: tools, account: accountOf('midea'), reload: reload }), _jsx(EwelinkLogin, { tools: tools, account: accountOf('ewelink'), reload: reload }), _jsx(HuaweiLogin, { account: accountOf('huawei'), tools: tools, reload: reload })] }));
}
function SettingsPanel(props) {
    const settings = usePoll('/settings', 30_000);
    const action = useAction(() => {
        props.reload();
        settings.reload();
    });
    const [draft, setDraft] = useState(null);
    const [note, setNote] = useState(null);
    const launcher = boot().launcher;
    const current = settings.data?.settings ?? null;
    const value = draft ?? current;
    useEffect(() => {
        if (current !== null)
            setDraft((previous) => previous ?? current);
    }, [current]);
    if (value === null) {
        return (_jsx("div", { className: "fg-root", children: _jsx(Card, { children: settings.error === null ? _jsx("div", { className: "fg-empty", children: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026" }) : _jsx(ErrorCard, { raw: settings.error, conclusion: "\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25" }) }) }));
    }
    const patch = (next) => setDraft({ ...value, ...next });
    const dirty = current !== null && JSON.stringify(current) !== JSON.stringify(value);
    return (_jsxs("div", { className: "fg-root", children: [action.error === null ? null : _jsx(ErrorCard, { raw: action.error, conclusion: "\u8BBE\u7F6E\u672A\u4FDD\u5B58", onDismiss: action.clearError }), note === null ? null : _jsx("div", { className: "fg-card fg-hint", children: note }), _jsxs(Card, { title: "\u540E\u53F0\u670D\u52A1", children: [_jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-server-port", children: "\u540E\u53F0\u670D\u52A1\u7AEF\u53E3" }), _jsx("input", { id: "fg-server-port", className: "fg-input fg-mono", type: "number", min: 1024, max: 65535, value: value.serverPort, onChange: (event) => patch({ serverPort: Number.parseInt(event.target.value, 10) || 0 }) }), _jsx("div", { className: "fg-hint", children: "\u7AEF\u53E3\u88AB\u5360\u7528\u65F6\u63D2\u4EF6\u4F1A\u81EA\u52A8\u5411\u4E0A\u987A\u5EF6\uFF0C\u5E76\u5728\u72B6\u6001\u91CC\u663E\u793A\u5B9E\u9645\u7AEF\u53E3\uFF0C\u4E0D\u4F1A\u56E0\u6B64\u542F\u52A8\u5931\u8D25\u3002" })] }), _jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-bind", children: "\u76D1\u542C\u5730\u5740" }), _jsxs("select", { id: "fg-bind", className: "fg-input", value: value.bindAddress, onChange: (event) => patch({ bindAddress: event.target.value }), children: [_jsx("option", { value: "127.0.0.1", children: "\u4EC5\u672C\u673A 127.0.0.1\uFF08\u63A8\u8350\uFF09" }), _jsx("option", { value: "0.0.0.0", children: "\u6240\u6709\u7F51\u5361 0.0.0.0\uFF08\u5C40\u57DF\u7F51\u53EF\u8BBF\u95EE\uFF09" })] }), _jsx("div", { className: "fg-hint", children: "\u4E0A\u6E38\u9ED8\u8BA4\u76D1\u542C 0.0.0.0\uFF0C\u4F1A\u628A\u7F51\u5173\u548C\u5E73\u53F0 token \u66B4\u9732\u7ED9\u6574\u4E2A\u5C40\u57DF\u7F51\u3002\u63D2\u4EF6\u9ED8\u8BA4\u53EA\u76D1\u542C\u672C\u673A\u3002" })] }), _jsxs("label", { className: "fg-check", children: [_jsx("input", { type: "checkbox", checked: value.autoStart, onChange: (event) => patch({ autoStart: event.target.checked }) }), _jsxs("span", { children: ["\u968F DSH \u542F\u52A8\u65F6\u81EA\u52A8\u542F\u52A8\u540E\u53F0\u670D\u52A1", _jsx("div", { className: "fg-hint", children: "\u5173\u95ED\u540E\uFF0CDSH \u542F\u52A8\u4E0D\u4F1A\u62C9\u8D77\u670D\u52A1\uFF0C\u9700\u8981\u5728\u8FD9\u91CC\u624B\u52A8\u70B9\u300C\u542F\u52A8\u300D\u3002" })] })] })] }), _jsxs(Card, { title: "\u4E0B\u8F7D\u6765\u6E90", children: [_jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-mirror", children: "\u955C\u50CF\u5730\u5740\u524D\u7F00" }), _jsx("input", { id: "fg-mirror", className: "fg-input fg-mono", placeholder: "https://mirror.example.com/miloco", value: value.mirrorBase ?? '', onChange: (event) => patch({ mirrorBase: event.target.value === '' ? null : event.target.value }) }), _jsx("div", { className: "fg-hint", children: "GitHub Releases \u4E0D\u53EF\u8FBE\u65F6\u6309\u6B64\u5730\u5740\u53D6\u540C\u540D\u6587\u4EF6\uFF08<\u524D\u7F00>/<\u6587\u4EF6\u540D>\uFF09\u3002\u5FC5\u987B\u662F https\u3002" })] }), _jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-local", children: "\u672C\u5730\u5B89\u88C5\u5305\u7EDD\u5BF9\u8DEF\u5F84" }), _jsx("input", { id: "fg-local", className: "fg-input fg-mono", placeholder: "/Users/you/Downloads/miloco-mcp-server-mac-arm64-v1.2.20.zip", value: value.localArchive ?? '', onChange: (event) => patch({ localArchive: event.target.value === '' ? null : event.target.value }) }), _jsx("div", { className: "fg-hint", children: "\u6700\u540E\u515C\u5E95\u7684\u6765\u6E90\u3002\u8BF7\u4F18\u5148\u4F7F\u7528\u300C\u670D\u52A1\u300D\u9875\u7684\u6307\u5B9A\u7248\u672C\u5B89\u88C5\uFF0C\u907F\u514D\u624B\u586B\u8DEF\u5F84\u3002" })] }), _jsxs("label", { className: "fg-check", children: [_jsx("input", { type: "checkbox", checked: value.allowUnverified, onChange: (event) => patch({ allowUnverified: event.target.checked }) }), _jsxs("span", { children: ["\u5141\u8BB8\u5B89\u88C5\u6CA1\u6709\u6821\u9A8C\u503C\u7684\u7248\u672C", _jsx("div", { className: "fg-hint", children: "\u9ED8\u8BA4\u62D2\u7EDD\u3002\u4E0A\u6E38\u4E2A\u522B\u8D44\u4EA7\u6CA1\u6709\u53D1\u5E03 .sha256\uFF0C\u5F00\u542F\u540E\u8FD9\u7C7B\u5305\u5C06\u4E0D\u505A\u5B8C\u6574\u6027\u6821\u9A8C\u3002" })] })] })] }), _jsxs(Card, { title: "\u63D2\u4EF6", children: [_jsxs("div", { className: "fg-field", children: [_jsx("label", { htmlFor: "fg-facade-port", children: "MCP \u95E8\u9762\u7AEF\u53E3" }), _jsx("input", { id: "fg-facade-port", className: "fg-input fg-mono", type: "number", min: 1024, max: 65535, value: value.facadePort, onChange: (event) => patch({ facadePort: Number.parseInt(event.target.value, 10) || 0 }) }), _jsxs("div", { className: "fg-hint", children: ["\u5B98\u65B9 MCP \u6865\u8FDE\u7684\u662F\u8FD9\u4E2A\u7AEF\u53E3\u3002\u5B83\u5199\u5728\u672C\u673A state.json \u91CC\uFF0CMCP \u6865\u5728 DSH \u542F\u52A8\u65F6\u8BFB\u53D6\uFF0C\u56E0\u6B64", _jsx("strong", { children: "\u6539\u52A8\u9700\u8981\u91CD\u542F DSH" }), "\u3002"] })] }), _jsxs("dl", { className: "fg-grid", children: [_jsx("dt", { children: "\u5B89\u88C5\u76EE\u5F55" }), _jsxs("dd", { children: [_jsx("span", { className: "fg-mono", children: settings.data?.root ?? '—' }), ' ', settings.data === null || settings.data === undefined ? null : _jsx(Copy, { value: settings.data.root })] }), _jsx("dt", { children: "\u63D2\u4EF6\u7248\u672C" }), _jsx("dd", { className: "fg-mono", children: boot().pluginVersion ?? '—' })] }), launcher === undefined ? null : (_jsxs(_Fragment, { children: [_jsx("div", { className: "fg-hint", style: { marginTop: 8 }, children: "\u63D2\u4EF6\u6CA1\u6709\u81EA\u66F4\u65B0\u63A5\u53E3\uFF1A\u5BBF\u4E3B\u5728\u542F\u52A8\u65F6\u8BFB\u53D6\u5305\u7684\u7248\u672C\uFF0C\u8FD0\u884C\u671F\u95F4\u65E0\u6CD5\u70ED\u66FF\u6362\u3002\u5347\u7EA7\u8BF7\u6267\u884C\u4E0B\u9762\u7684\u547D\u4EE4\uFF0C\u7136\u540E\u91CD\u542F DSH\u3002" }), _jsx("code", { className: "fg-code", children: launcher.upgradeCommand }), _jsxs("div", { className: "fg-actions", children: [_jsx(Copy, { value: launcher.upgradeCommand, label: "\u590D\u5236\u5347\u7EA7\u547D\u4EE4" }), launcher.profileKnown ? null : _jsx("span", { className: "fg-hint", children: "\u672A\u80FD\u8BC6\u522B\u5F53\u524D profile \u540D\uFF0C\u8BF7\u628A <\u4F60\u7684 profile \u540D> \u66FF\u6362\u6210\u5B9E\u9645\u503C\u3002" })] })] }))] }), _jsxs("div", { className: "fg-actions", children: [_jsx(Btn, { variant: "primary", disabled: !dirty || action.busy !== null, onClick: () => action.run('settings', async () => {
                            const result = await api('/settings', { method: 'PUT', body: JSON.stringify({
                                    mirrorBase: value.mirrorBase,
                                    localArchive: value.localArchive,
                                    allowUnverified: value.allowUnverified,
                                    bindAddress: value.bindAddress,
                                    cloudServer: value.cloudServer,
                                    autoStart: value.autoStart,
                                    serverPort: value.serverPort,
                                    facadePort: value.facadePort,
                                }) });
                            setNote(result.note);
                        }), children: "\u4FDD\u5B58\u8BBE\u7F6E" }), _jsx(Btn, { variant: "ghost", disabled: !dirty, onClick: () => setDraft(current), children: "\u653E\u5F03\u4FEE\u6539" })] })] }));
}
function LogsPanel() {
    const [lines, setLines] = useState([]);
    const [paused, setPaused] = useState(false);
    const [error, setError] = useState(null);
    const [source, setSource] = useState('all');
    const lastTs = useRef(0);
    const pausedRef = useRef(false);
    pausedRef.current = paused;
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            if (document.hidden || pausedRef.current)
                return;
            try {
                const fresh = await api(`/logs?since=${lastTs.current}&limit=400`);
                if (cancelled || fresh.length === 0)
                    return;
                lastTs.current = fresh[fresh.length - 1].ts;
                setLines((previous) => [...previous, ...fresh].slice(-1500));
                setError(null);
            }
            catch (cause) {
                if (!cancelled)
                    setError(cause.message);
            }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), 2000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);
    const shown = useMemo(() => (source === 'all' ? lines : lines.filter((line) => line.source === source)), [lines, source]);
    return (_jsxs("div", { className: "fg-root", children: [error === null ? null : _jsx(ErrorCard, { raw: error, conclusion: "\u8BFB\u53D6\u65E5\u5FD7\u5931\u8D25" }), _jsxs(Card, { title: _jsxs("span", { children: ["\u8FD0\u884C\u65E5\u5FD7", _jsx("span", { className: "fg-hint", style: { fontWeight: 400 }, children: "\uFF08\u63D2\u4EF6\u4E0E\u540E\u53F0\u670D\u52A1\u5408\u5E76\u5728\u4E00\u5904\uFF0C\u4FBF\u4E8E\u770B\u56E0\u679C\u987A\u5E8F\uFF09" })] }), children: [_jsxs("div", { className: "fg-actions", style: { marginTop: 0 }, children: [_jsxs("select", { className: "fg-input", style: { width: 'auto' }, value: source, onChange: (event) => setSource(event.target.value), children: [_jsx("option", { value: "all", children: "\u5168\u90E8" }), _jsx("option", { value: "plugin", children: "\u4EC5\u63D2\u4EF6" }), _jsx("option", { value: "server", children: "\u4EC5\u540E\u53F0\u670D\u52A1" })] }), _jsx(Btn, { onClick: () => setPaused((value) => !value), children: paused ? '继续刷新' : '暂停刷新' }), _jsx(Btn, { variant: "ghost", onClick: () => { setLines([]); lastTs.current = Date.now(); }, children: "\u6E05\u7A7A\u89C6\u56FE" }), _jsx(Copy, { value: shown.map((line) => `${new Date(line.ts).toISOString()} [${line.source}] ${line.level}: ${line.text}`).join('\n'), label: "\u590D\u5236\u5168\u90E8" })] }), _jsx("div", { className: "fg-logs", style: { marginTop: 8 }, children: shown.length === 0 ? (_jsx("div", { className: "fg-empty", children: "\u6682\u65E0\u65E5\u5FD7\u3002" })) : (shown.map((line, index) => (_jsxs("div", { className: `fg-log-line${line.level === 'error' ? ' fg-log-error' : line.level === 'warn' ? ' fg-log-warn' : ''}`, children: [_jsx("span", { className: "fg-log-ts", children: new Date(line.ts).toLocaleTimeString() }), _jsx("span", { children: line.source === 'server' ? '服务' : '插件' }), _jsx("span", { children: line.text })] }, `${line.ts}-${index}`)))) })] })] }));
}
// ────────────────────────────────────────────────────────────────── 根组件
function FeyagateSettings() {
    const [tab, setTab] = useState('service');
    const status = usePoll('/status', 2500);
    const reload = status.reload;
    const current = status.data;
    if (current === null) {
        return (_jsx("div", { className: "fg-root", children: status.error === null ? (_jsx("div", { className: "fg-empty", children: "\u6B63\u5728\u8BFB\u53D6\u540E\u53F0\u670D\u52A1\u72B6\u6001\u2026" })) : (_jsx(ErrorCard, { raw: status.error, conclusion: "\u65E0\u6CD5\u8FDE\u63A5 DSH \u5BBF\u4E3B" })) }));
    }
    const view = stateView(current);
    const primary = (() => {
        if (current.state === 'not-installed') {
            return {
                label: '安装后台服务',
                onClick: () => {
                    setTab('service');
                    void post('/install', {}).then(reload).catch(() => reload());
                },
            };
        }
        if (current.healthy)
            return { label: '查看日志', onClick: () => setTab('logs') };
        if (current.state === 'stopped' || current.state === 'error' || current.state === 'degraded') {
            return {
                label: '启动',
                onClick: () => {
                    void post('/service/start').then(reload).catch(() => reload());
                },
            };
        }
        return null;
    })();
    return (_jsxs("div", { className: "fg-root", children: [_jsx("div", { className: "fg-card", children: _jsxs("div", { className: "fg-hero", children: [_jsxs("div", { className: "fg-hero-main", children: [_jsxs("div", { className: `fg-hero-state ${TONE_CLASS[view.tone]}`, children: [_jsx("span", { "aria-hidden": "true", children: view.icon }), _jsx("span", { children: view.word }), current.currentVersion === null ? null : _jsxs("span", { className: "fg-tag", children: ["v", current.currentVersion] })] }), _jsx("div", { className: "fg-hero-detail", children: current.detail ?? `后台服务正在监听 127.0.0.1:${current.effectivePort ?? current.port}` }), current.circuitOpen ? (_jsx("div", { className: "fg-hero-detail fg-state-bad", children: "\u5DF2\u505C\u6B62\u81EA\u52A8\u91CD\u542F\u3002\u4FEE\u590D\u539F\u56E0\u540E\u70B9\u300C\u91CD\u542F\u300D\u6216\u300C\u56DE\u6EDA\u4E0A\u4E00\u7248\u672C\u300D\u53EF\u7ACB\u5373\u6062\u590D\u3002" })) : null] }), primary === null ? null : (_jsx(Btn, { variant: "primary", onClick: primary.onClick, children: primary.label }))] }) }), status.error === null ? null : _jsx(ErrorCard, { raw: status.error, conclusion: "\u72B6\u6001\u5237\u65B0\u5931\u8D25" }), _jsx("div", { className: "fg-tabs", role: "tablist", children: TABS.map((entry) => (_jsx("button", { type: "button", role: "tab", className: "fg-tab", "aria-selected": tab === entry.id, onClick: () => setTab(entry.id), children: entry.label }, entry.id))) }), tab === 'service' ? _jsx(ServicePanel, { status: current, reload: reload }) : null, tab === 'license' ? _jsx(LicensePanel, { status: current, reload: reload }) : null, tab === 'accounts' ? _jsx(AccountsPanel, { status: current }) : null, tab === 'login' ? _jsx(LoginPanel, { status: current, reload: reload }) : null, tab === 'settings' ? _jsx(SettingsPanel, { status: current, reload: reload }) : null, tab === 'logs' ? _jsx(LogsPanel, {}) : null] }));
}
export const inject = ['slots'];
export function apply(ctx) {
    insertStyles();
    // `inject` waits for the slot declaration, then the factory registers the page.
    // The register call must keep `{ name: ... }` as the first thing after
    // `register(` — the injector's skeleton validation matches that shape.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'feyagate',
        order: 30,
        label: () => '飞阳网关',
    }, FeyagateSettings));
    ctx.logger?.info('[dsh-feyagate-gateway] 设置页已注册');
}
//# sourceMappingURL=index.js.map