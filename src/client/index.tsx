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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  ApiEnvelope,
  AuthCapabilities,
  CatalogEntry,
  GatewayInfo,
  JobSnapshot,
  LicenseView,
  LogLine,
  PlatformAccount,
  PluginSettings,
  RuntimeStatus,
  TuyaQrStatus,
  TuyaQrTicket,
} from './contract.js'

// ────────────────────────────────────────────────────────────────── 常量

const FALLBACK_PREFIX = '/dsh-feyagate'

interface BootGlobal {
  apiPrefix?: string
  pluginVersion?: string
  launcher?: { profile: string | null; installCommand: string; upgradeCommand: string; restartHint: string; profileKnown: boolean }
}

function boot(): BootGlobal {
  return ((globalThis as unknown as Record<string, unknown>).__DSH_FEYAGATE__ as BootGlobal | undefined) ?? {}
}

const API_PREFIX = boot().apiPrefix ?? FALLBACK_PREFIX

/**
 * 服务端字段里存的是带前缀的根相对路径（如 `/dsh-feyagate/auth/tuya/qr.png`）；
 * 直接再拼一遍前缀会变成 `/dsh-feyagate/dsh-feyagate/…`（接口 404）。统一走这里
 * 补齐：已带前缀的原样返回，没带的补上。
 */
function withApiPrefix(path: string): string {
  return path.startsWith(API_PREFIX) ? path : `${API_PREFIX}${path}`
}

/**
 * 六个分区的导航。`blurb` 是每个分区自己的一句话职责 —— tab 上只放 2 个字的短
 * 标签，长解释放到内容区顶部，避免用户先在标签栏里做阅读理解。
 */
const TABS = [
  { id: 'service', label: '服务', blurb: '后台服务装没装、什么版本、正不正常，以及安装 / 升级 / 启动 / 停止' },
  { id: 'login', label: '平台登录', blurb: '在这里登录或退出米家、涂鸦、美的、易微联、华为账号' },
  { id: 'accounts', label: '账号总览', blurb: '只看状态：哪个平台登录还在、掉了没有（不改任何东西）' },
  { id: 'license', label: '授权', blurb: '免费版能用哪些平台、授权码怎么填、试用还剩多久' },
  { id: 'settings', label: '设置', blurb: '端口、监听地址、下载镜像、开机自启等插件本身的选项' },
  { id: 'logs', label: '日志', blurb: '插件与后台服务合并的运行日志，出问题时把这段发给开发者' },
] as const

type TabId = (typeof TABS)[number]['id']

// ────────────────────────────────────────────────────────────────── 样式

const CSS = `
.fg-root { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6; }

/* 顶部状态条：一句话说明现在是好是坏，右边只放"需要用户做的事"。 */
.fg-statusbar { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); }
.fg-statusbar-main { flex: 1 1 260px; min-width: 0; }
.fg-statusbar-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-weight: 600; }
.fg-statusbar-detail { color: var(--dsw-alias-label-secondary); margin-top: 2px; overflow-wrap: anywhere; }
.fg-strip { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px;
  color: var(--dsw-alias-label-caption); font-size: 12px; }
.fg-statusbar-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* 分区导航：横排小胶囊，窄了就换行；每项下面配一句该分区的职责。 */
.fg-nav { display: flex; flex-direction: column; gap: 6px; }
.fg-nav-items { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 6px; }
.fg-nav-item { appearance: none; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.fg-nav-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.fg-nav-item[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); font-weight: 600; }
.fg-blurb { color: var(--dsw-alias-label-caption); font-size: 12px; }

.fg-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); }
.fg-card + .fg-card { margin-top: 10px; }
.fg-card-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fg-hint { color: var(--dsw-alias-label-caption); font-size: 12px; }
.fg-hint + .fg-hint { margin-top: 4px; }
.fg-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; max-width: 520px; }

.fg-btn { appearance: none; font: inherit; border-radius: 7px; padding: 5px 12px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.fg-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.fg-btn:disabled { opacity: .45; cursor: not-allowed; }
.fg-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.fg-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.fg-btn-danger { color: var(--dsw-alias-label-error); }
.fg-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.fg-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-link); padding-left: 2px; padding-right: 2px; }

/* 版本块：左边结论 + 事实，右边一个主按钮；完整版本号只在需要时展开。 */
.fg-version { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.fg-version-main { flex: 1 1 240px; min-width: 0; }
.fg-version-lead { font-weight: 600; }
.fg-version-facts { display: flex; gap: 4px 14px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
.fg-version-fact { color: var(--dsw-alias-label-caption); }
.fg-version-fact > b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.fg-version-note { color: var(--dsw-alias-label-caption); font-size: 12px; margin-top: 6px; }
.fg-version-action { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 100%; }

/* 次要内容默认折叠：主流程只留一条路，专家选项按需展开。 */
.fg-fold { margin-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; }
.fg-fold > summary { cursor: pointer; color: var(--dsw-alias-link); font-size: 12px; }
.fg-fold[open] > summary { margin-bottom: 6px; }

.fg-grid { display: grid; grid-template-columns: minmax(88px, max-content) minmax(0, 1fr); gap: 4px 12px; align-items: baseline; }
.fg-grid > dt { color: var(--dsw-alias-label-secondary); }
.fg-grid > dd { margin: 0; overflow-wrap: anywhere; }
.fg-grid + .fg-grid { margin-top: 8px; }
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

/* 服务状态一行流：● 运行中 · 端口 38080 · 已运行 3 分 12 秒 · 重启 0 次 */
.fg-statline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fg-statline > .fg-statsep { color: var(--dsw-alias-label-dimmed); }
.fg-statline > .fg-statlabel { color: var(--dsw-alias-label-secondary); }
.fg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-state-idle-primary); }
.fg-dot-ok { background: var(--dsw-alias-state-success-primary); }
.fg-dot-busy { background: var(--dsw-alias-state-business-primary); }
.fg-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.fg-dot-bad { background: var(--dsw-alias-state-error-primary); }

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
`

let stylesInserted = false

function insertStyles(): void {
  if (stylesInserted) return
  stylesInserted = true
  const existing = document.querySelector('style[data-plugin-css="dsh-feyagate"]')
  if (existing !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-feyagate')
  style.textContent = CSS
  document.head.appendChild(style)
}

// ────────────────────────────────────────────────────────────── HTTP 封装

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  let payload: ApiEnvelope<T>
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  if (payload.ok !== true) throw new Error(payload.error)
  return payload.data
}

const post = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

// ────────────────────────────────────────────────────────── 错误四层结构

interface Diagnosis {
  conclusion: string
  cause: string
  code: string
  actions: string[]
}

const RULES: Array<{ test: RegExp; code: string; conclusion: string; cause: (raw: string) => string; actions: string[] }> = [
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
]

/** Cut a raw message down to the 60-character budget the design allows. */
function clampCause(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

function diagnose(raw: string, conclusion?: string): Diagnosis {
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return { conclusion: conclusion ?? rule.conclusion, cause: clampCause(rule.cause(raw)), code: rule.code, actions: rule.actions }
    }
  }
  return {
    conclusion: conclusion ?? '操作未完成',
    cause: clampCause(raw),
    code: 'FG-API-000',
    actions: ['查看日志'],
  }
}

// ────────────────────────────────────────────────────────────── 基础控件

function Btn(props: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  title?: string
}): React.ReactElement {
  const variant = props.variant ?? 'default'
  const cls = variant === 'default' ? 'fg-btn' : `fg-btn fg-btn-${variant}`
  return (
    <button type="button" className={cls} onClick={props.onClick} disabled={props.disabled === true} title={props.title}>
      {props.children}
    </button>
  )
}

function Card(props: { title?: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="fg-card">
      {props.title === undefined ? null : <div className="fg-card-title">{props.title}</div>}
      {props.sub === undefined ? null : <div className="fg-hint">{props.sub}</div>}
      {props.children}
    </section>
  )
}

/** 状态圆点：把「运行中 / 已停止 / 异常」的颜色差异从文字里抽出来，一眼可扫。 */
function Dot(props: { tone: StateView['tone'] }): React.ReactElement {
  return <span className={`fg-dot${props.tone === 'idle' ? '' : ` fg-dot-${props.tone}`}`} aria-hidden="true" />
}

function Row(props: { main: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }): React.ReactElement {
  return (
    <div className="fg-row">
      <div className="fg-row-main">
        <div>{props.main}</div>
        {props.sub === undefined ? null : <div className="fg-row-sub">{props.sub}</div>}
      </div>
      {props.right}
    </div>
  )
}

function Copy(props: { value: string; label?: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="fg-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(props.value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        })
      }}
    >
      {copied ? '已复制' : (props.label ?? '复制')}
    </button>
  )
}

function ErrorCard(props: { raw: string; conclusion?: string; onDismiss?: () => void }): React.ReactElement {
  const diagnosis = diagnose(props.raw, props.conclusion)
  return (
    <div className="fg-error" role="alert">
      <div className="fg-error-title">
        <span>⚠ {diagnosis.conclusion}</span>
        <span className="fg-error-code">{diagnosis.code}</span>
      </div>
      <div className="fg-error-cause">原因：{diagnosis.cause}</div>
      <div className="fg-actions">
        {diagnosis.actions.map((action) => (
          <span key={action} className="fg-hint">
            · {action}
          </span>
        ))}
        {props.onDismiss === undefined ? null : <Btn variant="ghost" onClick={props.onDismiss}>关闭</Btn>}
      </div>
      <details className="fg-details">
        <summary>技术细节（供排障使用）</summary>
        <code className="fg-code">{props.raw}</code>
      </details>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────── 数据钩子

interface Poll<T> {
  data: T | null
  error: string | null
  reload: () => void
}

/** Poll one endpoint. Stops while the tab is hidden, so a background GUI idles. */
function usePoll<T>(path: string | null, intervalMs: number): Poll<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const pathRef = useRef(path)
  pathRef.current = path

  useEffect(() => {
    if (path === null) {
      setData(null)
      return
    }
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const result = await api<T>(path)
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [path, intervalMs, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { data, error, reload }
}

/**
 * Wrap an action: busy flag, error capture, and a reload callback.
 *
 * `run` returns a promise that never rejects (the failure is already parked in
 * `error`), so callers may chain extra work — the top status bar uses that to
 * refresh the runtime status right after an install starts.
 */
function useAction(onDone: () => void): {
  busy: string | null
  error: string | null
  clearError: () => void
  run: (label: string, body: () => Promise<unknown>) => Promise<void>
} {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(onDone)
  done.current = onDone

  const run = useCallback(async (label: string, body: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await body()
      done.current()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(null)
    }
  }, [])

  return { busy, error, clearError: () => setError(null), run }
}

// ────────────────────────────────────────────────────────────── 状态词映射

interface StateView {
  word: string
  icon: string
  tone: 'idle' | 'busy' | 'ok' | 'warn' | 'bad'
}

/** The status vocabulary is a contract with the design doc: one word each. */
function stateView(status: RuntimeStatus): StateView {
  switch (status.state) {
    case 'not-installed':
      return { word: '未安装', icon: '○', tone: 'idle' }
    case 'stopped':
      return { word: '已停止', icon: '■', tone: 'idle' }
    case 'starting':
      return { word: '启动中', icon: '◌', tone: 'busy' }
    case 'running':
      return { word: '运行中', icon: '●', tone: 'ok' }
    case 'degraded':
      return { word: '降级运行', icon: '▲', tone: 'warn' }
    case 'error':
      return { word: '异常', icon: '✕', tone: 'bad' }
    case 'updating':
      return { word: '升级中', icon: '⟳', tone: 'busy' }
    default:
      return { word: String(status.state), icon: '·', tone: 'idle' }
  }
}

const TONE_CLASS: Record<StateView['tone'], string> = {
  idle: 'fg-state-idle',
  busy: 'fg-state-busy',
  ok: 'fg-state-ok',
  warn: 'fg-state-warn',
  bad: 'fg-state-bad',
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

const JOB_PHASE_WORD: Record<JobSnapshot['phase'], string> = {
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
}

// ────────────────────────────────────────────────────────── 各分区面板

/**
 * 根组件与「服务」页共用的服务操作入口：顶部状态条上的按钮和页面里的按钮调
 * 的是同一段逻辑，两处不会给出不同的说法。
 */
interface ServiceAction {
  busy: boolean
  error: string | null
  clearError: () => void
  install: (target: string | null, allowUnverified: boolean, reinstall: boolean) => void
  rollback: (target: string) => void
  start: () => void
  stop: () => void
  restart: () => void
  cancel: () => void
  uninstall: (purgeData: boolean) => void
}

/** 「● 运行中 · 端口 38080 · 已运行 3 分 12 秒」。空字段直接不出现，不留一堆「—」。 */
function ServiceStatusLine(props: { status: RuntimeStatus; withPid?: boolean }): React.ReactElement {
  const status = props.status
  const view = stateView(status)
  const parts: string[] = []
  if (status.state === 'not-installed') {
    parts.push('还没有下载后台服务')
  } else if (status.healthy) {
    parts.push(`端口 ${status.effectivePort ?? status.port}`)
    if (status.uptimeMs !== null) parts.push(`已运行 ${formatDuration(status.uptimeMs)}`)
    if (props.withPid === true && status.pid !== null) parts.push(`进程号 ${status.pid}`)
    if (status.restarts > 0) parts.push(`本次会话自动重启 ${status.restarts} 次`)
  } else if (status.detail !== undefined) {
    parts.push(status.detail)
  }
  return (
    <div className="fg-statline">
      <Dot tone={view.tone} />
      <span className={TONE_CLASS[view.tone]}>{view.word}</span>
      {status.currentVersion === null ? null : <span className="fg-tag">v{status.currentVersion}</span>}
      {parts.map((part) => (
        <React.Fragment key={part}>
          <span className="fg-statsep">·</span>
          <span className="fg-statlabel">{part}</span>
        </React.Fragment>
      ))}
    </div>
  )
}

function JobProgress(props: { job: JobSnapshot | null; busy: boolean; onCancel: () => void }): React.ReactElement | null {
  const job = props.job
  if (job === null) return null
  // A finished job stays visible until the next one starts — after a failure the
  // user needs to see why, and the reason must outlive the task.
  const terminal = job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled'
  if (terminal && job.phase === 'done' && job.noop) {
    return <div className="fg-hint">{job.message ?? '无需操作'}</div>
  }
  return (
    <div>
      <div className="fg-row">
        <div className="fg-row-main">
          <div>
            {job.label} · {JOB_PHASE_WORD[job.phase]}
            {job.percent === null ? '' : ` · ${job.percent}%`}
          </div>
          {job.message === null ? null : <div className="fg-row-sub">{job.message}</div>}
          {job.error === null ? null : <div className="fg-row-sub fg-state-bad">原因：{job.error}</div>}
        </div>
        {props.busy && !terminal ? <Btn onClick={props.onCancel}>取消</Btn> : null}
      </div>
      {terminal ? null : (
        <div className={`fg-progress${job.percent === null ? ' fg-progress-indeterminate' : ''}`}>
          <i style={{ width: job.percent === null ? '32%' : `${job.percent}%` }} />
        </div>
      )}
      {job.bytesTotal === null || job.bytesDone === null ? null : (
        <div className="fg-hint">
          {formatBytes(job.bytesDone)} / {formatBytes(job.bytesTotal)}
        </div>
      )}
      {job.attemptedSources.length > 1 ? <div className="fg-hint">已尝试来源：{job.attemptedSources.join(' → ')}</div> : null}
    </div>
  )
}

function ServicePanel(props: { status: RuntimeStatus; service: ServiceAction }): React.ReactElement {
  const { status, service } = props
  const job = usePoll<{ job: JobSnapshot | null; busy: boolean }>('/jobs/current', 900)
  const catalog = usePoll<{ versions: CatalogEntry[]; recommended: string | null; compat: RuntimeStatus['manifest'] }>(
    '/install/catalog',
    30_000,
  )
  const [version, setVersion] = useState<string>('')
  const [allowUnverified, setAllowUnverified] = useState(false)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  const busy = service.busy
  const versions = catalog.data?.versions ?? []
  const catalogLoaded = catalog.data !== null
  const recommended = catalog.data?.recommended ?? null
  const installed = status.installedVersions
  const notInstalled = status.currentVersion === null
  const updateAvailable = recommended !== null && status.currentVersion !== recommended
  // 目前只有一个按钮会出现在主流程里；文案必须说清点了会发生什么。
  const actionLabel = !catalogLoaded
    ? '读取版本清单…'
    : notInstalled
      ? recommended === null
        ? '安装推荐版本'
        : `安装 v${recommended}`
      : updateAvailable
        ? `升级到 v${recommended}`
        : '检查更新'
  const currentJob = job.data?.job ?? null

  return (
    <div className="fg-root">
      {job.error === null ? null : <ErrorCard raw={job.error} conclusion="无法读取任务状态" />}

      {currentJob === null ? null : (
        <Card title="正在执行">
          <JobProgress job={currentJob} busy={job.data?.busy === true} onCancel={service.cancel} />
        </Card>
      )}

      <Card
        title={
          <span>
            版本
            {updateAvailable ? <span className="fg-tag fg-tag-busy">有更新</span> : null}
          </span>
        }
      >
        <div className="fg-version">
          <div className="fg-version-main">
            <div className="fg-version-lead">
              {notInstalled
                ? catalogLoaded && recommended !== null
                  ? `尚未安装，推荐安装 v${recommended}`
                  : '尚未安装后台服务'
                : updateAvailable
                  ? `发现新版本 v${recommended}`
                  : catalogLoaded
                    ? '已经是最新版本'
                    : `当前版本 v${status.currentVersion}`}
            </div>
            <div className="fg-version-facts">
              <span className="fg-version-fact">
                本机版本 <b>{status.currentVersion ?? '未安装'}</b>
              </span>
              <span className="fg-version-fact">
                最新可用 <b>{recommended ?? (catalogLoaded ? '暂无' : '读取中…')}</b>
              </span>
              {installed.length > 1 ? <span className="fg-version-fact">已下载 <b>{installed.length}</b> 个版本</span> : null}
            </div>
            <div className="fg-version-note">
              {notInstalled
                ? '安装会从官方发布渠道下载后台服务，校验通过后才启用；失败不会留下半个版本。'
                : '重装、指定某个版本、回滚、卸载都收在下面的「更多安装选项」里。'}
            </div>
          </div>
          <div className="fg-version-action">
            <Btn
              variant={updateAvailable || notInstalled ? 'primary' : 'default'}
              disabled={busy || !catalogLoaded}
              onClick={() => {
                if (notInstalled || updateAvailable) {
                  service.install(null, allowUnverified, false)
                  return
                }
                catalog.reload()
              }}
            >
              {busy ? '正在执行…' : actionLabel}
            </Btn>
          </div>
        </div>

        {service.error === null ? null : (
          <div style={{ marginTop: 10 }}>
            <ErrorCard raw={service.error} conclusion="服务操作未完成" onDismiss={service.clearError} />
          </div>
        )}

        <details className="fg-fold">
          <summary>更多安装选项（指定版本、允许无校验值、回滚）</summary>
          <div className="fg-hint">
            上游各平台的发布节奏不一致，所以某些平台上「最新」并不是全部版本；这里列出的都是本机平台真实存在的版本。
          </div>
          <div className="fg-field">
            <label htmlFor="fg-version">要安装的版本</label>
            <select
              id="fg-version"
              className="fg-input"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            >
              <option value="">推荐版本{recommended === null ? '' : ` v${recommended}`}</option>
              {versions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {entry.version}
                  {entry.installed ? '（已下载）' : ''}
                  {entry.unverified ? '（无校验值）' : ''}
                </option>
              ))}
            </select>
          </div>
          <label className="fg-check">
            <input type="checkbox" checked={allowUnverified} onChange={(event) => setAllowUnverified(event.target.checked)} />
            <span>
              允许安装没有校验值的版本
              <div className="fg-hint">默认拒绝。只有你确认来源可信时才开启；开启后这类包不做完整性校验。</div>
            </span>
          </label>
          <div className="fg-actions">
            <Btn
              disabled={busy || versions.length === 0}
              onClick={() => service.install(version === '' ? null : version, allowUnverified, version !== '' && version === status.currentVersion)}
            >
              {version === ''
                ? '安装推荐版本'
                : version === status.currentVersion
                  ? `重新安装 v${version}`
                  : `安装 v${version}`}
            </Btn>
            {status.lastKnownGood === null || status.lastKnownGood === status.currentVersion ? null : (
              <Btn disabled={busy} onClick={() => service.rollback(status.lastKnownGood as string)}>
                回滚到 v{status.lastKnownGood}
              </Btn>
            )}
            {notInstalled ? null : (
              <Btn disabled={busy} onClick={() => service.install(status.currentVersion, allowUnverified, true)}>
                重新安装 v{status.currentVersion}
              </Btn>
            )}
            <Btn variant="ghost" onClick={catalog.reload}>
              重新读取清单
            </Btn>
          </div>
          <dl className="fg-grid">
            <dt>已下载版本</dt>
            <dd className="fg-mono">{installed.length === 0 ? '无' : installed.join('、')}</dd>
            <dt>上一可用</dt>
            <dd className="fg-mono">{status.lastKnownGood ?? '无'}</dd>
            <dt>兼容区间</dt>
            <dd className="fg-mono">
              ≥ {status.manifest.minSupportedServer}
              {status.manifest.maxTestedServer === null ? '' : ` · 已测至 ${status.manifest.maxTestedServer}`}
            </dd>
          </dl>
        </details>
      </Card>

      <Card title="运行状态" sub="启动 / 停止 / 重启只影响后台服务，不会动平台账号与授权。">
        {notInstalled ? null : <ServiceStatusLine status={status} withPid />}
        {status.circuitOpen ? (
          <div className="fg-hint fg-state-bad">
            已停止自动重启。修好原因后点「重启服务」，或到上面「更多安装选项」里回滚上一版本。
          </div>
        ) : null}
        <div className="fg-actions">
          {notInstalled ? (
            <span className="fg-hint">装好后台服务后，这里会出现「启动服务 / 停止服务 / 重启服务」。</span>
          ) : (
            <>
              {status.healthy ? (
                <>
                  <Btn disabled={busy} onClick={service.restart}>
                    重启服务
                  </Btn>
                  <Btn variant="danger" disabled={busy} onClick={service.stop}>
                    停止服务
                  </Btn>
                </>
              ) : (
                <>
                  <Btn variant="primary" disabled={busy} onClick={service.start}>
                    启动服务
                  </Btn>
                  <Btn disabled={busy} onClick={service.restart}>
                    重启服务
                  </Btn>
                </>
              )}
            </>
          )}
        </div>
        {status.effectivePort !== null && status.effectivePort !== status.port ? (
          <div className="fg-hint">
            配置端口 {status.port} 当时被占用，实际监听 {status.effectivePort}；端口在「设置」里改。
          </div>
        ) : null}
      </Card>

      <Card title="卸载" sub="不可逆操作，放在最后，避免误点。">
        <details className="fg-fold" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
          <summary>我要卸载后台服务</summary>
          <div className="fg-hint">
            卸载会停止服务并删除已下载的版本目录。<strong>data/ 目录默认保留</strong>——设备标识、授权码与各平台登录 token 都在那里，删掉就要重新登录、并可能重新消耗试用期。
          </div>
          <div className="fg-actions">
            {confirmUninstall ? (
              <>
                <Btn
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmUninstall(false)
                    service.uninstall(false)
                  }}
                >
                  确认卸载（保留数据）
                </Btn>
                <Btn
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmUninstall(false)
                    service.uninstall(true)
                  }}
                >
                  确认卸载并删除数据
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirmUninstall(false)}>
                  取消
                </Btn>
              </>
            ) : (
              <Btn variant="danger" disabled={busy || notInstalled} onClick={() => setConfirmUninstall(true)}>
                卸载后台服务
              </Btn>
            )}
          </div>
        </details>
      </Card>
    </div>
  )
}

function LicensePanel(props: { status: RuntimeStatus; reload: () => void }): React.ReactElement {
  const overview = usePoll<{
    info: GatewayInfo | null
    license: LicenseView | null
    reachable: boolean
  }>('/account/overview', 10_000)
  const action = useAction(props.reload)
  const [key, setKey] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const license = overview.data?.license ?? null
  const info = overview.data?.info ?? null
  const busy = action.busy !== null

  const edition = license?.edition ?? info?.license.edition ?? null
  const editionTag = ((): { text: string; cls: string } => {
    if (edition === 'licensed') return { text: '授权版', cls: 'fg-tag-ok' }
    if (edition === 'expired') return { text: '订阅已过期', cls: 'fg-tag-bad' }
    if (license?.subscriptionActive === false) return { text: '免费', cls: '' }
    return { text: '免费', cls: '' }
  })()
  /**
   * 免费版：免费版没有订阅，也就没有「到期」这件事 —— 写"无限期"而不是留一个
   * 空破折号，或者像以前那样把子进程的空字符串拼成 `— · 还剩 0 天`。
   */
  const freeEdition = edition === null || edition === 'free'
  const subscriptionText =
    license?.subscriptionExpiresAt ?? (freeEdition ? '无限期（免费版）' : '—')
  const graceText = ((): string => {
    const expires = license?.gracePeriodExpiresAt ?? null
    if (expires !== null) {
      const days = license?.graceRemainingDays
      return days === null || days === undefined ? `${expires}（已到期）` : `${expires} · 还剩 ${days} 天`
    }
    return freeEdition ? '无限期（免费版不涉及）' : '—'
  })()

  return (
    <div className="fg-root">
      {action.error === null ? null : <ErrorCard raw={action.error} conclusion="授权操作未完成" onDismiss={action.clearError} />}
      {overview.data !== null && overview.data.reachable === false ? (
        <Card>
          <div className="fg-empty">
            后台服务未运行，无法读取授权状态。授权信息保存在本机 data/license.json，启动服务后会立即恢复显示。
          </div>
        </Card>
      ) : null}

      <Card
        title={<span>授权状态 <span className={`fg-tag ${editionTag.cls}`}>{editionTag.text}</span></span>}
        sub="授权决定「免费版能用哪些平台」，和「账号总览」里的登录状态是两件事。"
      >
        <dl className="fg-grid">
          <dt>授权码</dt>
          <dd className="fg-mono">{license?.keyMasked === null || license?.keyMasked === '' ? '未填写' : license?.keyMasked}</dd>
          <dt>订阅到期</dt>
          <dd>{subscriptionText}</dd>
          <dt>宽限期</dt>
          <dd>{graceText}</dd>
          <dt>产品</dt>
          <dd>{license?.product ?? info?.license.product ?? '—'}</dd>
        </dl>
        <div className="fg-field">
          <label htmlFor="fg-license">输入授权码</label>
          <input
            id="fg-license"
            className="fg-input"
            placeholder="FG-XXXX-XXXX-XXXX"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className="fg-hint">格式 FG-XXXX-XXXX-XXXX。授权码一码一机，激活后不能转移到另一台设备。</div>
        </div>
        <div className="fg-actions">
          <Btn
            variant="primary"
            disabled={busy || key.trim() === ''}
            onClick={() =>
              action.run('activate', async () => {
                await post('/license/activate', { licenseKey: key.trim() })
                setKey('')
              })
            }
          >
            {busy ? '正在激活…' : '写入并激活'}
          </Btn>
          {confirmClear ? (
            <>
              <Btn variant="danger" disabled={busy} onClick={() => { setConfirmClear(false); action.run('deactivate', () => post('/license/deactivate')) }}>
                确认解除
              </Btn>
              <Btn variant="ghost" onClick={() => setConfirmClear(false)}>
                取消
              </Btn>
            </>
          ) : (
            <Btn
              variant="danger"
              disabled={busy || (license?.keyMasked ?? '') === ''}
              onClick={() => setConfirmClear(true)}
            >
              解除授权
            </Btn>
          )}
        </div>
        <details className="fg-fold">
          <summary>设备标识与云端规则（排障用）</summary>
          <dl className="fg-grid">
            <dt>设备标识</dt>
            <dd>
              <span className="fg-mono">{license?.deviceId ?? info?.deviceId ?? '—'}</span>{' '}
              {license?.deviceId === null || license?.deviceId === undefined ? null : <Copy value={license.deviceId} />}
            </dd>
            <dt>云端规则</dt>
            <dd>{license?.capabilitiesLoaded === true ? '已同步' : '未同步（显示为本地默认规则）'}</dd>
          </dl>
          <div className="fg-hint">设备标识绑定授权与试用期，请勿删除插件数据目录。</div>
        </details>
      </Card>

      <Card
        title="平台能力"
        sub={(license?.capabilitiesMessage ?? null) ?? '这一栏由服务端下发的规则决定，和账号登录状态无关。'}
      >
        {(license?.platforms ?? []).length === 0 ? (
          <div className="fg-empty">尚未拿到平台能力列表。</div>
        ) : (
          (license?.platforms ?? []).map((entry) => {
            // 0 天 = 该平台没有试用期（米家就是永久免费），不该写成"试用剩 0 天"。
            const trial = entry.trialRemainingDays
            return (
              <Row
                key={entry.platform}
                main={entry.platform}
                sub={entry.message ?? undefined}
                right={
                  <span className={`fg-tag ${entry.enabled ? 'fg-tag-ok' : 'fg-tag-warn'}`}>
                    {entry.enabled ? '可用' : '不可用'}
                    {trial === null || trial === undefined || trial <= 0 ? '' : ` · 试用剩 ${trial} 天`}
                  </span>
                }
              />
            )
          })
        )}
      </Card>
    </div>
  )
}

function AccountsPanel(props: { status: RuntimeStatus }): React.ReactElement {
  void props.status
  const overview = usePoll<{
    platforms: PlatformAccount[]
    cameras: Array<{ deviceId: string; name: string; online: boolean }>
    cameraSupported: boolean | null
    reachable: boolean
  }>('/account/overview', 10_000)

  const data = overview.data
  return (
    <div className="fg-root">
      <Card title="平台账号" sub="只读总览。要登录或退出，请切到「平台登录」。">
        {data === null || data.reachable === false ? (
          <div className="fg-empty">后台服务未运行，无法读取平台登录状态。先在「服务」页把服务启动起来。</div>
        ) : data.platforms.length === 0 ? (
          <div className="fg-empty">服务端未返回平台列表。</div>
        ) : (
          data.platforms.map((entry) => {
            const sub = accountSummary(entry)
            return (
              <Row
                key={entry.platformId}
                main={entry.platformName}
                sub={sub}
                right={
                  <span className={`fg-tag ${entry.authenticated ? 'fg-tag-ok' : ''}`}>
                    {entry.authenticated ? '账号已登录' : '账号未登录'}
                  </span>
                }
              />
            )
          })
        )}
      </Card>

      <Card title="摄像头" sub="摄像头画面与取流仍在聊天里让模型调用工具（xiaomi/camera_*），这里只显示有没有。">
        {data?.cameraSupported === false ? (
          <div className="fg-hint">
            当前平台的上游构建不包含摄像头能力（Windows 版本编译时关闭了取流），因此这里不会有摄像头。其它平台功能不受影响。
          </div>
        ) : data === null || data.reachable === false ? (
          <div className="fg-empty">后台服务未运行。</div>
        ) : data.cameras.length === 0 ? (
          <div className="fg-empty">没有摄像头。若已登录米家，可在聊天里让模型调用 xiaomi/camera_list 刷新。</div>
        ) : (
          data.cameras.map((camera) => (
            <Row
              key={camera.deviceId}
              main={camera.name}
              sub={camera.deviceId}
              right={<span className={`fg-tag ${camera.online ? 'fg-tag-ok' : 'fg-tag-warn'}`}>{camera.online ? '在线' : '离线'}</span>}
            />
          ))
        )}
      </Card>
    </div>
  )
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
function accountSummary(account: PlatformAccount): string | undefined {
  const remaining = account.authStatus['token_remaining_seconds']
  const region = account.authStatus['cloud_server'] ?? account.authStatus['region']
  const parts = [
    typeof region === 'string' && region !== '' ? `区域 ${region}` : null,
    typeof remaining === 'number' ? `登录有效期剩 ${formatDuration(remaining * 1000)}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  hint?: string
}): React.ReactElement {
  return (
    <div className="fg-field">
      <label>{props.label}</label>
      <input
        className="fg-input"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint === undefined ? null : <div className="fg-hint">{props.hint}</div>}
    </div>
  )
}

function Select(props: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}): React.ReactElement {
  return (
    <div className="fg-field">
      <label>{props.label}</label>
      <select className="fg-input" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** One platform's card: name, live status, and either the flow or the reason. */
function PlatformCard(props: {
  name: string
  account: PlatformAccount | undefined
  unavailable?: string | null
  children?: React.ReactNode
}): React.ReactElement {
  const account = props.account
  const summary = account === undefined ? undefined : accountSummary(account)
  return (
    <Card
      title={
        // 标题本身就是 flex 行（.fg-card-title），不要再套 .fg-row —— 那个类带 border-top，
        // 会在平台名上方画一条多余的横线。
        <>
          {props.name}
          <span className={`fg-tag ${account?.authenticated === true ? 'fg-tag-ok' : ''}`}>
            {account === undefined ? '状态未知' : account.authenticated ? '已登录' : '未登录'}
          </span>
        </>
      }
    >
      {summary === undefined ? null : <div className="fg-hint">{summary}</div>}
      {props.unavailable == null || props.unavailable === '' ? (
        props.children
      ) : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-warn">本构建不支持</span> {props.unavailable}
        </div>
      )}
    </Card>
  )
}

/** 退出登录：调一次宿主接口，然后让状态重新拉取。 */
function LogoutButton(props: {
  platformId: string
  onDone: () => void
  available: boolean
  reason?: string
}): React.ReactElement {
  const action = useAction(props.onDone)
  if (!props.available) {
    return <div className="fg-hint">退出登录：{props.reason ?? '当前上游构建没有该平台的退出接口'}</div>
  }
  return (
    <div>
      <div className="fg-actions">
        <Btn
          variant="danger"
          disabled={action.busy !== null}
          onClick={() => action.run('logout', () => post('/auth/logout', { platform: props.platformId }))}
        >
          {action.busy === null ? '退出登录' : '正在退出…'}
        </Btn>
      </div>
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
    </div>
  )
}

function XiaomiLogin(props: {
  tools: Set<string>
  account: PlatformAccount | undefined
  reload: () => void
}): React.ReactElement {
  const hasUrl = props.tools.has('xiaomi/auth_url') && props.tools.has('xiaomi/auth_callback')
  const [region, setRegion] = useState('cn')
  const [url, setUrl] = useState<string | null>(null)
  // 发起授权时的区域要沿用给回调：上游 callback 的 region 会覆盖当前区域，
  // 两步之间用户改了下拉框就会导致"看不到设备"（桌面端也用 regionRef 这么做）。
  const [urlRegion, setUrlRegion] = useState('cn')
  const [auto, setAuto] = useState(false)
  const [showFallback, setShowFallback] = useState(false)
  const [pasted, setPasted] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const action = useAction(props.reload)
  const authenticated = props.account?.authenticated === true
  // 保持 reload 最新引用，轮询定时器里用 ref 取，避免闭包过期
  const reloadRef = useRef(props.reload)
  reloadRef.current = props.reload

  // 自动回调模式（v1.2.21+）：授权 URL 的 redirect_uri 指向后台服务自身，
  // 用户在浏览器登录完成后本机服务自动完成 code 交换 —— 这里只负责发现
  // 登录状态翻转，等价于 Android 端"拦截回调自动授权"的体验。
  useEffect(() => {
    if (url === null) return
    if (authenticated) {
      setDone(`授权成功（区域 ${urlRegion}）`)
      setUrl(null)
      setShowFallback(false)
      setPasted('')
      return
    }
    const timer = setInterval(() => reloadRef.current(), 2500)
    return () => clearInterval(timer)
  }, [url, authenticated, urlRegion])

  return (
    <PlatformCard
      name="米家（小米）"
      account={props.account}
      unavailable={hasUrl ? null : '当前上游构建没有米家授权工具（xiaomi/auth_url、xiaomi/auth_callback）。'}
    >
      <div className="fg-hint">
        {auto === true
          ? '三步：选区域 → 获取授权地址 → 在浏览器里登录。登录成功后浏览器会自动跳回本机服务完成授权（页面显示"授权成功"），无需粘贴任何地址 —— 本页会自动检测并更新登录状态。'
          : '三步：选区域 → 获取授权地址 → 在浏览器里登录并确认授权。登录完成后浏览器会跳到一个打不开的页面（https://127.0.0.1/?code=…），这是正常的 —— 授权码只在该页面的地址栏里；把地址栏整段复制下来，粘贴到下方"粘贴回调地址"输入框，点"完成授权"即可。'}
      </div>
      <div className="fg-form-2">
        <Select
          label="账号区域"
          value={region}
          onChange={setRegion}
          options={[
            { value: 'cn', label: 'cn 中国大陆' },
            { value: 'de', label: 'de 欧洲（德国）' },
            { value: 'i2', label: 'i2 印度' },
            { value: 'ru', label: 'ru 俄罗斯' },
            { value: 'sg', label: 'sg 新加坡' },
            { value: 'us', label: 'us 美国' },
          ]}
        />
      </div>
      <div className="fg-hint">选错区域会看不到设备；应选账号实际使用的区域。</div>
      <div className="fg-actions">
        <Btn
          variant="primary"
          disabled={action.busy !== null}
          onClick={() =>
            action.run('xiaomi-url', async () => {
              const result = await post<{ url: string; autoCallback?: boolean }>('/auth/xiaomi/url', { region })
              setUrl(result.url)
              setUrlRegion(region)
              setAuto(result.autoCallback === true)
              setDone(null)
            })
          }
        >
          {action.busy === null ? '获取授权地址' : '正在获取…'}
        </Btn>
      </div>
      {url === null ? null : (
        <div>
          <div className="fg-actions">
            <a className="fg-link" href={url} target="_blank" rel="noreferrer">
              在浏览器里打开授权页
            </a>
            <Copy value={url} label="复制地址" />
          </div>
          {auto ? (
            <div className="fg-hint">
              等待登录结果…（登录完成后浏览器会跳到 <code className="fg-code">授权成功</code> 页面，本页自动更新状态）
            </div>
          ) : null}
          {auto && !showFallback ? (
            <div className="fg-hint">
              自动授权没有反应？<a className="fg-link" onClick={() => setShowFallback(true)}>手动粘贴回调地址</a>
            </div>
          ) : null}
          {(!auto || showFallback) ? (
            <div>
              <Field
                label="粘贴回调地址（或只粘 code）"
                value={pasted}
                onChange={setPasted}
                placeholder="https://127.0.0.1/?code=…"
              />
              <div className="fg-actions">
                <Btn
                  variant="primary"
                  disabled={action.busy !== null || pasted.trim() === ''}
                  onClick={() =>
                    action.run('xiaomi-callback', async () => {
                      const result = await post<{ region: string | null }>('/auth/xiaomi/callback', { input: pasted, region: urlRegion })
                      setDone(result.region === null ? '授权成功' : `授权成功（区域 ${result.region}）`)
                      setUrl(null)
                      setPasted('')
                    })
                  }
                >
                  {action.busy === null ? '完成授权' : '正在交换令牌…'}
                </Btn>
              </div>
            </div>
          ) : null}
        </div>
      )}
      {done === null ? null : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-ok">成功</span> {done}
        </div>
      )}
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
      <LogoutButton platformId="xiaomi" onDone={props.reload} available={authenticated} reason="登录后才能退出" />
    </PlatformCard>
  )
}

function TuyaLogin(props: {
  tools: Set<string>
  account: PlatformAccount | undefined
  reload: () => void
}): React.ReactElement {
  const hasQr = props.tools.has('auth/tuya_qr') && props.tools.has('auth/tuya_qr_status')
  const { reload } = props
  const [userCode, setUserCode] = useState('')
  const [ticket, setTicket] = useState<TuyaQrTicket | null>(null)
  const [generatedAt, setGeneratedAt] = useState(0)
  const [scan, setScan] = useState<'idle' | 'waiting' | 'authorized' | 'error'>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  /** 非终态的等待说明（网络抖动等）：页面继续轮询，不把失败标签甩给用户。 */
  const [transient, setTransient] = useState<string | null>(null)
  const action = useAction(props.reload)

  // 扫码等待放在服务端（单次最多 35 秒），这里只管循环再问一次：
  // 用户扫得快就即时返回，扫得慢也不会把页面变成一堆失败请求。
  // 单次请求失败（网络抖动、dsh 重启瞬间）同样只算等待中的插曲：
  // 在二维码有效期内继续问，终态失败只留给「已过期」。
  useEffect(() => {
    if (ticket === null || scan !== 'waiting') return
    let cancelled = false
    const loop = async (): Promise<void> => {
      const expiresAt = generatedAt + Math.max(30, ticket.expireSeconds) * 1000
      while (!cancelled) {
        if (Date.now() > expiresAt) {
          setScan('error')
          setDetail('二维码已过期，请重新生成（涂鸦二维码有效期很短）')
          return
        }
        try {
          const status = await post<TuyaQrStatus>('/auth/tuya/status', { token: ticket.token, userCode })
          if (cancelled) return
          if (status.status === 'authorized') {
            setScan('authorized')
            setDetail(status.uid === null ? '涂鸦账号已登录' : `涂鸦账号已登录（uid ${status.uid}）`)
            reload()
            return
          }
          if (status.status === 'error') {
            setScan('error')
            setDetail(status.message ?? '二维码已失效，请重新生成')
            return
          }
        } catch (cause) {
          if (cancelled) return
          setTransient(`请求没有成功（${(cause as Error).message}），自动重试中…`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
      }
    }
    void loop()
    return () => {
      cancelled = true
    }
  }, [ticket, scan, userCode, generatedAt, reload])

  const qrSrc = ticket === null ? null : withApiPrefix(ticket.imageUrl)

  return (
    <PlatformCard
      name="涂鸦（Tuya）"
      account={props.account}
      unavailable={hasQr ? null : '当前上游构建没有涂鸦二维码工具（auth/tuya_qr）。'}
    >
      <div className="fg-hint">
        用户代码在涂鸦 App 里：<strong>我的 → 设置 → 账号与安全 → 用户代码</strong>。填好后生成二维码，用涂鸦 App 右上角
        「+ → 扫一扫」扫它，再在 App 里点「确认登录」。
      </div>
      <Field label="用户代码" value={userCode} onChange={setUserCode} placeholder="AY1790336520…" />
      <div className="fg-actions">
        <Btn
          variant="primary"
          disabled={action.busy !== null || userCode.trim() === ''}
          onClick={() =>
            action.run('tuya-qr', async () => {
              const result = await post<TuyaQrTicket>('/auth/tuya/qr', { userCode })
              setTicket(result)
              setGeneratedAt(Date.now())
              setScan('waiting')
              setDetail(null)
              setTransient(null)
            })
          }
        >
          {action.busy === null ? (ticket === null ? '生成二维码' : '重新生成') : '正在生成…'}
        </Btn>
      </div>
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
      {ticket === null || qrSrc === null ? null : (
        <div>
          <img className="fg-qr" src={qrSrc} alt="涂鸦授权二维码" />
          <div className="fg-hint">
            二维码 {ticket.expireSeconds} 秒内有效。
            {scan === 'waiting' ? '正在等你扫码（会一直等到扫到为止，页面不用管）。' : null}
            {scan === 'authorized' ? ' 已扫码确认。' : null}
            <a className="fg-link" href={withApiPrefix(ticket.textUrl)} target="_blank" rel="noreferrer">
              图片显示不出来？用文本二维码
            </a>
          </div>
        </div>
      )}
      {detail === null && transient === null ? null : (
        <div className="fg-hint">
          {transient !== null ? (
            <>
              <span className="fg-tag">重试</span> {transient}
            </>
          ) : (
            <>
              <span className={`fg-tag ${scan === 'authorized' ? 'fg-tag-ok' : 'fg-tag-bad'}`}>{scan === 'authorized' ? '成功' : '失败'}</span> {detail}
            </>
          )}
        </div>
      )}
      <LogoutButton
        platformId="tuya"
        onDone={props.reload}
        available={props.tools.has('auth/tuya_logout')}
        reason="当前上游构建没有涂鸦退出工具（auth/tuya_logout）"
      />
    </PlatformCard>
  )
}

function MideaLogin(props: {
  tools: Set<string>
  account: PlatformAccount | undefined
  reload: () => void
}): React.ReactElement {
  const hasLogin = props.tools.has('auth/midea_login')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [cloud, setCloud] = useState('meiju')
  const [done, setDone] = useState<string | null>(null)
  const action = useAction(props.reload)

  return (
    <PlatformCard
      name="美的（Midea）"
      account={props.account}
      unavailable={hasLogin ? null : '当前上游构建没有美的登录工具（auth/midea_login）。'}
    >
      <div className="fg-hint">账号密码直接交给本机后台服务（127.0.0.1），插件不保存、不写日志。</div>
      <div className="fg-form-2">
        <Field label="美的账号" value={account} onChange={setAccount} placeholder="手机号 / 邮箱" />
        <Field label="密码" value={password} onChange={setPassword} type="password" />
        <Select
          label="客户端类型"
          value={cloud}
          onChange={setCloud}
          options={[
            { value: 'meiju', label: '美居（meiju）' },
            { value: 'msmart', label: 'MSmartHome（msmart）' },
          ]}
        />
      </div>
      <div className="fg-actions">
        <Btn
          variant="primary"
          disabled={action.busy !== null || account.trim() === '' || password === ''}
          onClick={() =>
            action.run('midea-login', async () => {
              const result = await post<{ deviceCount: number; cloud: string }>('/auth/midea/login', {
                account,
                password,
                cloud,
              })
              setDone(`登录成功，已同步 ${result.deviceCount} 个设备（${result.cloud}）`)
              setPassword('')
            })
          }
        >
          {action.busy === null ? '登录' : '正在登录…'}
        </Btn>
      </div>
      {done === null ? null : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-ok">成功</span> {done}
        </div>
      )}
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
      <LogoutButton
        platformId="midea"
        onDone={props.reload}
        available={props.tools.has('auth/midea_logout')}
        reason="当前上游构建没有美的退出工具（auth/midea_logout）"
      />
    </PlatformCard>
  )
}

function EwelinkLogin(props: {
  tools: Set<string>
  account: PlatformAccount | undefined
  reload: () => void
}): React.ReactElement {
  const hasLogin = props.tools.has('auth/ewelink_login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [countryCode, setCountryCode] = useState('+86')
  const [done, setDone] = useState<string | null>(null)
  const action = useAction(props.reload)

  return (
    <PlatformCard
      name="易微联（eWeLink）"
      account={props.account}
      unavailable={hasLogin ? null : '当前上游构建没有易微联登录工具（auth/ewelink_login）。'}
    >
      <div className="fg-hint">账号密码直接交给本机后台服务（127.0.0.1），插件不保存、不写日志。</div>
      <div className="fg-form-2">
        <Field label="邮箱或手机号" value={email} onChange={setEmail} />
        <Field label="密码" value={password} onChange={setPassword} type="password" />
        <Field
          label="国家代码"
          value={countryCode}
          onChange={setCountryCode}
          placeholder="+86"
          hint="账号注册地；填错会登录失败或看不到设备。"
        />
      </div>
      <div className="fg-actions">
        <Btn
          variant="primary"
          disabled={action.busy !== null || email.trim() === '' || password === ''}
          onClick={() =>
            action.run('ewelink-login', async () => {
              const result = await post<{ deviceCount: number }>('/auth/ewelink/login', { email, password, countryCode })
              setDone(`登录成功，已同步 ${result.deviceCount} 个设备`)
              setPassword('')
            })
          }
        >
          {action.busy === null ? '登录' : '正在登录…'}
        </Btn>
      </div>
      {done === null ? null : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-ok">成功</span> {done}
        </div>
      )}
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
      <LogoutButton
        platformId="ewelink"
        onDone={props.reload}
        available={props.tools.has('auth/ewelink_logout')}
        reason="当前上游构建没有易微联退出工具（auth/ewelink_logout）"
      />
    </PlatformCard>
  )
}

function HuaweiLogin(props: {
  account: PlatformAccount | undefined
  tools: Set<string>
  reload: () => void
}): React.ReactElement {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [challengeName, setChallengeName] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const action = useAction(props.reload)

  const applyOutcome = (outcome: { authenticated: boolean; needCode: boolean; challengeName: string | null; retryWithoutCode: boolean }): void => {
    setNeedCode(outcome.needCode)
    setChallengeName(outcome.challengeName)
    if (outcome.retryWithoutCode) {
      // 关键分流：验证码已经通过、只是换令牌失败，会话已保留。
      // 这时再要一个验证码不但无用，还会白费用户一个码。
      setNotice('验证码已通过、会话已保留：无需重新输入，可直接继续（若状态仍是未登录，稍后会自动补齐令牌）。')
      props.reload()
      return
    }
    if (outcome.authenticated) {
      setDone('华为账号已登录')
      setPassword('')
      setCode('')
      props.reload()
    }
  }

  return (
    <PlatformCard
      name="华为智慧生活"
      account={props.account}
      unavailable={
        props.tools.has('auth/huawei_login')
          ? null
          : '本机后台服务（v1.2.19）没有华为登录工具 —— 上游在 v1.2.20 才加上 auth/huawei_login / auth/huawei_challenge / auth/huawei_logout。升级后台服务后这张卡片会自动出现，无需升级插件。'
      }
    >
      <div className="fg-hint">
        两步验证：先提交账号密码，再提交验证码。<strong>华为不发短信</strong> —— 验证码显示在已登录的华为手机/平板弹窗里，
        或「设置 → 华为帐号 → 帐号安全」。
      </div>
      <div className="fg-form-2">
        <Field label="华为账号（手机号或邮箱）" value={account} onChange={setAccount} />
        <Field label="账号密码" value={password} onChange={setPassword} type="password" />
      </div>
      {needCode ? (
        <div>
          <Field
            label="双重验证码"
            value={code}
            onChange={setCode}
            hint={challengeName === null ? undefined : `上游提示验证码发往：${challengeName}`}
          />
          <div className="fg-actions">
            <Btn
              variant="primary"
              disabled={action.busy !== null || code.trim() === ''}
              onClick={() =>
                action.run('huawei-challenge', async () => {
                  setNotice(null)
                  applyOutcome(await post('/auth/huawei/challenge', { code }))
                })
              }
            >
              {action.busy === null ? '提交验证码' : '正在验证…'}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="fg-actions">
          <Btn
            variant="primary"
            disabled={action.busy !== null || account.trim() === '' || password === ''}
            onClick={() =>
              action.run('huawei-login', async () => {
                setNotice(null)
                applyOutcome(await post('/auth/huawei/login', { account, password }))
              })
            }
          >
            {action.busy === null ? '登录' : '正在登录…'}
          </Btn>
        </div>
      )}
      {notice === null ? null : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-warn">注意</span> {notice}
        </div>
      )}
      {done === null ? null : (
        <div className="fg-hint">
          <span className="fg-tag fg-tag-ok">成功</span> {done}
        </div>
      )}
      {action.error === null ? null : <ErrorCard raw={action.error} onDismiss={action.clearError} />}
      <LogoutButton
        platformId="huawei"
        onDone={props.reload}
        available={props.tools.has('auth/huawei_logout')}
        reason="本机上游构建没有华为退出工具（需 v1.2.20 及以上）"
      />
    </PlatformCard>
  )
}

function LoginPanel(props: { status: RuntimeStatus; reload: () => void }): React.ReactElement {
  const capabilities = usePoll<AuthCapabilities>('/auth/capabilities', 20_000)
  const overview = usePoll<{ platforms: PlatformAccount[]; reachable: boolean }>('/account/overview', 10_000)
  const caps = capabilities.data
  const tools = useMemo(() => new Set(caps?.tools ?? []), [caps])
  const accounts = overview.data?.platforms ?? []
  const accountOf = (id: string): PlatformAccount | undefined => accounts.find((entry) => entry.platformId === id)
  const reload = props.reload

  if (caps === null) {
    // 能力还在路上：先别渲染各平台卡片，否则会闪一下"本构建不支持"。
    return (
      <div className="fg-root">
        <Card title="平台登录">
          <div className="fg-empty">正在读取后台服务的授权能力…</div>
        </Card>
      </div>
    )
  }

  if (caps.childReachable === false) {
    return (
      <div className="fg-root">
        <Card title="平台登录">
          <div className="fg-empty">后台服务未运行：请先在「服务」页安装并启动它，再回到这里登录。</div>
        </Card>
      </div>
    )
  }

  return (
    <div className="fg-root">
      <Card
        title="从这里登录"
        sub="账号密码 / 验证码只在本机回环内交给后台服务，插件不保存、不写日志、不回显；退出登录会清掉服务里的令牌。"
      >
        <div className="fg-hint">
          <strong>登录只是第一步。</strong>登录后设备控制、场景、记忆、技能、触发规则、Vision AI 都在<strong>聊天里</strong>让模型调用工具完成，例如：
        </div>
        <dl className="fg-grid">
          <dt>设备</dt>
          <dd>「帮我把客厅灯打开」「空调调到 26 度」</dd>
          <dt>摄像头</dt>
          <dd>「看看客厅现在有人吗」「米家摄像头连一下」</dd>
          <dt>场景与定时</dt>
          <dd>「执行回家场景」「明早 7 点叫我」</dd>
          <dt>自动化</dt>
          <dd>「检测到有人进客厅就开灯」（摄像头触发规则）</dd>
        </dl>
      </Card>
      <XiaomiLogin tools={tools} account={accountOf('xiaomi')} reload={reload} />
      <TuyaLogin tools={tools} account={accountOf('tuya')} reload={reload} />
      <MideaLogin tools={tools} account={accountOf('midea')} reload={reload} />
      <EwelinkLogin tools={tools} account={accountOf('ewelink')} reload={reload} />
      <HuaweiLogin account={accountOf('huawei')} tools={tools} reload={reload} />
    </div>
  )
}

function SettingsPanel(props: { status: RuntimeStatus; reload: () => void }): React.ReactElement {
  const settings = usePoll<{ settings: PluginSettings; root: string }>('/settings', 30_000)
  const action = useAction(() => {
    props.reload()
    settings.reload()
  })
  const [draft, setDraft] = useState<PluginSettings | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const launcher = boot().launcher

  const current = settings.data?.settings ?? null
  const value = draft ?? current

  useEffect(() => {
    if (current !== null) setDraft((previous) => previous ?? current)
  }, [current])

  if (value === null) {
    return (
      <div className="fg-root">
        <Card>{settings.error === null ? <div className="fg-empty">正在读取设置…</div> : <ErrorCard raw={settings.error} conclusion="读取设置失败" />}</Card>
      </div>
    )
  }

  const patch = (next: Partial<PluginSettings>): void => setDraft({ ...value, ...next })
  const dirty = current !== null && JSON.stringify(current) !== JSON.stringify(value)
  // 端口 / 监听地址写进 config.yaml，只有重启后台服务才会生效；其余字段立即写入。
  // 按钮文案如实说出这件事，省得改完端口发现没变。
  const needsRestart =
    current !== null && (current.serverPort !== value.serverPort || current.bindAddress !== value.bindAddress)

  return (
    <div className="fg-root">
      {action.error === null ? null : <ErrorCard raw={action.error} conclusion="设置未保存" onDismiss={action.clearError} />}
      {note === null ? null : <div className="fg-card fg-hint">{note}</div>}

      <Card title="后台服务" sub="保存后写入配置；改了端口或监听地址，要重启后台服务才生效。">
        <div className="fg-field">
          <label htmlFor="fg-server-port">后台服务端口</label>
          <input
            id="fg-server-port"
            className="fg-input fg-mono"
            type="number"
            min={1024}
            max={65535}
            value={value.serverPort}
            onChange={(event) => patch({ serverPort: Number.parseInt(event.target.value, 10) || 0 })}
          />
          <div className="fg-hint">端口被占用时插件会自动向上顺延，并在状态里显示实际端口，不会因此启动失败。</div>
        </div>
        <div className="fg-field">
          <label htmlFor="fg-bind">监听地址</label>
          <select id="fg-bind" className="fg-input" value={value.bindAddress} onChange={(event) => patch({ bindAddress: event.target.value as PluginSettings['bindAddress'] })}>
            <option value="127.0.0.1">仅本机 127.0.0.1（推荐）</option>
            <option value="0.0.0.0">所有网卡 0.0.0.0（局域网可访问）</option>
          </select>
          <div className="fg-hint">上游默认监听 0.0.0.0，会把网关和平台 token 暴露给整个局域网。插件默认只监听本机。</div>
        </div>
        <label className="fg-check">
          <input type="checkbox" checked={value.autoStart} onChange={(event) => patch({ autoStart: event.target.checked })} />
          <span>
            随 DSH 启动时自动启动后台服务
            <div className="fg-hint">关闭后，DSH 启动不会拉起服务，需要到「服务」页手动点「启动服务」。</div>
          </span>
        </label>
      </Card>

      <Card title="下载来源" sub="默认走官方发布渠道；只有网络不通或离线安装时才需要改这里。">
        <div className="fg-field">
          <label htmlFor="fg-mirror">镜像地址前缀</label>
          <input
            id="fg-mirror"
            className="fg-input fg-mono"
            placeholder="https://mirror.example.com/miloco"
            value={value.mirrorBase ?? ''}
            onChange={(event) => patch({ mirrorBase: event.target.value === '' ? null : event.target.value })}
          />
          <div className="fg-hint">GitHub Releases 不可达时按此地址取同名文件（&lt;前缀&gt;/&lt;文件名&gt;）。必须是 https。</div>
        </div>
        <div className="fg-field">
          <label htmlFor="fg-local">本地安装包绝对路径</label>
          <input
            id="fg-local"
            className="fg-input fg-mono"
            placeholder="/Users/you/Downloads/miloco-mcp-server-mac-arm64-v1.2.20.zip"
            value={value.localArchive ?? ''}
            onChange={(event) => patch({ localArchive: event.target.value === '' ? null : event.target.value })}
          />
          <div className="fg-hint">最后兜底的来源。一般不需要：安装某个具体版本请用「服务」页的「更多安装选项」。</div>
        </div>
        <label className="fg-check">
          <input type="checkbox" checked={value.allowUnverified} onChange={(event) => patch({ allowUnverified: event.target.checked })} />
          <span>
            允许安装没有校验值的版本
            <div className="fg-hint">默认拒绝。上游个别资产没有发布 .sha256，开启后这类包将不做完整性校验。</div>
          </span>
        </label>
      </Card>

      <Card title="插件">
        <div className="fg-field">
          <label htmlFor="fg-facade-port">MCP 门面端口</label>
          <input
            id="fg-facade-port"
            className="fg-input fg-mono"
            type="number"
            min={1024}
            max={65535}
            value={value.facadePort}
            onChange={(event) => patch({ facadePort: Number.parseInt(event.target.value, 10) || 0 })}
          />
          <div className="fg-hint">
            官方 MCP 桥连的是这个端口。它写在本机 state.json 里，MCP 桥在 DSH 启动时读取，因此<strong>改动需要重启 DSH</strong>。
          </div>
        </div>
        <dl className="fg-grid">
          <dt>安装目录</dt>
          <dd>
            <span className="fg-mono">{settings.data?.root ?? '—'}</span>{' '}
            {settings.data === null || settings.data === undefined ? null : <Copy value={settings.data.root} />}
          </dd>
          <dt>插件版本</dt>
          <dd className="fg-mono">{boot().pluginVersion ?? '—'}</dd>
        </dl>
        {launcher === undefined ? null : (
          <>
            <div className="fg-hint" style={{ marginTop: 8 }}>
              插件没有自更新接口：宿主在启动时读取包的版本，运行期间无法热替换。升级请执行下面的命令，然后重启 DSH。
            </div>
            <code className="fg-code">{launcher.upgradeCommand}</code>
            <div className="fg-actions">
              <Copy value={launcher.upgradeCommand} label="复制升级命令" />
              {launcher.profileKnown ? null : <span className="fg-hint">未能识别当前 profile 名，请把 &lt;你的 profile 名&gt; 替换成实际值。</span>}
            </div>
          </>
        )}
      </Card>

      <div className="fg-actions">
        <Btn variant="primary" disabled={!dirty || action.busy !== null} onClick={() => action.run('settings', async () => {
          const result = await api<{ note: string | null }>('/settings', { method: 'PUT', body: JSON.stringify({
            mirrorBase: value.mirrorBase,
            localArchive: value.localArchive,
            allowUnverified: value.allowUnverified,
            bindAddress: value.bindAddress,
            cloudServer: value.cloudServer,
            autoStart: value.autoStart,
            serverPort: value.serverPort,
            facadePort: value.facadePort,
          }) })
          setNote(result.note)
        })}>
          {action.busy === null ? (dirty && needsRestart ? '保存（改端口需重启服务）' : '保存设置') : '正在保存…'}
        </Btn>
        <Btn variant="ghost" disabled={!dirty} onClick={() => setDraft(current)}>
          放弃修改
        </Btn>
      </div>
    </div>
  )
}

function LogsPanel(): React.ReactElement {
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<'all' | 'plugin' | 'server'>('all')
  const lastTs = useRef(0)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (document.hidden || pausedRef.current) return
      try {
        const fresh = await api<LogLine[]>(`/logs?since=${lastTs.current}&limit=400`)
        if (cancelled || fresh.length === 0) return
        lastTs.current = fresh[fresh.length - 1]!.ts
        setLines((previous) => [...previous, ...fresh].slice(-1500))
        setError(null)
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const shown = useMemo(() => (source === 'all' ? lines : lines.filter((line) => line.source === source)), [lines, source])

  return (
    <div className="fg-root">
      {error === null ? null : <ErrorCard raw={error} conclusion="读取日志失败" />}
      <Card
        title="运行日志"
        sub="插件与后台服务的日志合并在一处，便于看清因果顺序；贴给开发者排障时用「复制全部」。"
      >
        <div className="fg-actions" style={{ marginTop: 0 }}>
          <select className="fg-input" style={{ width: 'auto' }} value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="all">全部</option>
            <option value="plugin">仅插件</option>
            <option value="server">仅后台服务</option>
          </select>
          <Btn onClick={() => setPaused((value) => !value)}>{paused ? '继续刷新' : '暂停刷新'}</Btn>
          <Btn variant="ghost" onClick={() => { setLines([]); lastTs.current = Date.now() }}>
            清空视图
          </Btn>
          <Copy value={shown.map((line) => `${new Date(line.ts).toISOString()} [${line.source}] ${line.level}: ${line.text}`).join('\n')} label="复制全部" />
        </div>
        <div className="fg-logs" style={{ marginTop: 8 }}>
          {shown.length === 0 ? (
            <div className="fg-empty">暂无日志。</div>
          ) : (
            shown.map((line, index) => (
              <div key={`${line.ts}-${index}`} className={`fg-log-line${line.level === 'error' ? ' fg-log-error' : line.level === 'warn' ? ' fg-log-warn' : ''}`}>
                <span className="fg-log-ts">{new Date(line.ts).toLocaleTimeString()}</span>
                <span>{line.source === 'server' ? '服务' : '插件'}</span>
                <span>{line.text}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────── 根组件

function FeyagateSettings(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('service')
  const status = usePoll<RuntimeStatus>('/status', 2500)
  // 顶部状态条要显示「几个平台已登录 / 试用还剩几天」，所以这里也订阅账号总览。
  // 服务没起来时后端会立刻返回 reachable:false，轮询代价很小。
  const overview = usePoll<{
    platforms: PlatformAccount[]
    license: LicenseView | null
    reachable: boolean
  }>('/account/overview', 15_000)

  const reload = status.reload
  const current = status.data

  // 所有服务写操作都从这里发出：顶部状态条和「服务」页调的是同一段逻辑，
  // 不会出现两个入口说法不一致、或者同一时刻点出两个任务。
  const action = useAction(reload)
  const busy = action.busy !== null

  const wrap = useCallback(
    (label: string, run: () => Promise<unknown>) => {
      action.run(label, () => run().finally(reload))
    },
    [action, reload],
  )

  const install = useCallback(
    (target: string | null, allowUnverified: boolean, reinstall: boolean): void => {
      wrap('install', () => post('/install', { version: target, allowUnverified, reinstall }))
    },
    [wrap],
  )

  const service = useMemo<ServiceAction>(
    () => ({
      busy,
      error: action.error,
      clearError: action.clearError,
      install,
      rollback: (target) => wrap('rollback', () => post('/install/rollback', { version: target })),
      start: () => wrap('start', () => post('/service/start')),
      stop: () => wrap('stop', () => post('/service/stop')),
      restart: () => wrap('restart', () => post('/service/restart')),
      cancel: () => wrap('cancel', () => post('/jobs/cancel')),
      uninstall: (purgeData) => wrap('uninstall', () => post('/install/uninstall', { purgeData })),
    }),
    [action.clearError, action.error, busy, install, wrap],
  )

  if (current === null) {
    return (
      <div className="fg-root">
        {status.error === null ? (
          <div className="fg-empty">正在读取后台服务状态…</div>
        ) : (
          <ErrorCard raw={status.error} conclusion="无法连接 DSH 宿主" />
        )}
      </div>
    )
  }

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]
  const accounts = overview.data?.platforms ?? []
  const reachable = overview.data?.reachable === true
  const signedIn = accounts.filter((entry) => entry.authenticated).length
  const license = overview.data?.license ?? null
  const trialDays = license?.platforms.reduce<number | null>((lowest, platform) => {
    const days = platform.trialRemainingDays
    if (days === null || days === undefined) return lowest
    return lowest === null ? days : Math.min(lowest, days)
  }, null)

  /**
   * 状态条右侧永远只放「现在该做的那一件事」：没装 → 安装，没在跑 → 启动，
   * 一切正常 → 不放按钮（健康时推进日志页属于噪音，日志自己是一个分区）。
   */
  const primary = ((): { label: string; onClick: () => void } | null => {
    if (current.state === 'not-installed') {
      return { label: '安装后台服务', onClick: () => install(null, false, false) }
    }
    if (current.state === 'stopped' || current.state === 'error' || current.state === 'degraded') {
      return { label: '启动服务', onClick: () => service.start() }
    }
    return null
  })()

  return (
    <div className="fg-root">
      <div className="fg-statusbar">
        <div className="fg-statusbar-main">
          <ServiceStatusLine status={current} />
          <div className="fg-strip">
            <span>{reachable ? `${signedIn}/${accounts.length} 个平台已登录` : '平台状态未同步'}</span>
            {trialDays === null ? null : (
              <>
                <span>·</span>
                <span>免费试用还剩 {trialDays} 天</span>
              </>
            )}
            {current.facadePort === null || current.facadePort === undefined ? null : (
              <>
                <span>·</span>
                <span>MCP 门面端口 {current.facadePort}</span>
              </>
            )}
          </div>
          {current.circuitOpen ? (
            <div className="fg-statusbar-detail fg-state-bad">已停止自动重启：修好原因后点「重启服务」，或回滚上一版本。</div>
          ) : null}
        </div>
        {primary === null ? null : (
          <div className="fg-statusbar-actions">
            <Btn variant="primary" disabled={busy} onClick={primary.onClick}>
              {busy ? '正在执行…' : primary.label}
            </Btn>
          </div>
        )}
      </div>

      {action.error === null ? null : <ErrorCard raw={action.error} conclusion="服务操作未完成" onDismiss={action.clearError} />}
      {status.error === null ? null : <ErrorCard raw={status.error} conclusion="状态刷新失败" />}

      <div className="fg-nav">
        <div className="fg-nav-items" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className="fg-nav-item"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="fg-blurb">{active.blurb}</div>
      </div>

      {tab === 'service' ? <ServicePanel status={current} service={service} /> : null}
      {tab === 'license' ? <LicensePanel status={current} reload={reload} /> : null}
      {tab === 'accounts' ? <AccountsPanel status={current} /> : null}
      {tab === 'login' ? <LoginPanel status={current} reload={reload} /> : null}
      {tab === 'settings' ? <SettingsPanel status={current} reload={reload} /> : null}
      {tab === 'logs' ? <LogsPanel /> : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────── 插件注册入口

interface SlotRegisterOptions {
  name: string
  id: string
  order: number
  label: () => string
}

interface ClientContext {
  slots: {
    inject(slot: string, factory: () => (() => void) | void): () => void
    register(options: SlotRegisterOptions, component: React.ComponentType): () => void
  }
  effect(fn: () => (() => void) | void, label?: string): () => void
  logger?: { info(message: string): void; warn(message: string): void }
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  insertStyles()
  // `inject` waits for the slot declaration, then the factory registers the page.
  // The register call must keep `{ name: ... }` as the first thing after
  // `register(` — the injector's skeleton validation matches that shape.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'feyagate',
    order: 30,
    label: () => '飞阳网关',
  }, FeyagateSettings))
  ctx.logger?.info('[dsh-feyagate-gateway] 设置页已注册')
}
