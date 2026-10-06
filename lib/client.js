window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-feyagate-gateway",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
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
		const FALLBACK_PREFIX = "/dsh-feyagate";
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
			{
				id: "service",
				label: "服务"
			},
			{
				id: "license",
				label: "授权"
			},
			{
				id: "accounts",
				label: "账号总览"
			},
			{
				id: "login",
				label: "平台登录"
			},
			{
				id: "settings",
				label: "设置"
			},
			{
				id: "logs",
				label: "日志"
			}
		];
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
			if (stylesInserted) return;
			stylesInserted = true;
			if (document.querySelector("style[data-plugin-css=\"dsh-feyagate\"]") !== null) return;
			const style = document.createElement("style");
			style.setAttribute("data-plugin-css", "dsh-feyagate");
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		async function api(path, init) {
			const response = await fetch(`${API_PREFIX}${path}`, {
				...init,
				headers: {
					"Content-Type": "application/json",
					...init?.headers ?? {}
				}
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`);
			}
			if (payload.ok !== true) throw new Error(payload.error);
			return payload.data;
		}
		const post = (path, body) => api(path, {
			method: "POST",
			body: body === void 0 ? void 0 : JSON.stringify(body)
		});
		const RULES = [
			{
				test: /github|ENOTFOUND|EAI_AGAIN|fetch failed|网络|不可达/i,
				code: "FG-NET-001",
				conclusion: "下载服务器不可达",
				cause: () => "无法连接 GitHub Releases。若本机需要代理，请配置镜像地址后重试。",
				actions: ["配置镜像地址"]
			},
			{
				test: /超时|timeout|ETIMEDOUT/i,
				code: "FG-NET-002",
				conclusion: "下载超时",
				cause: (raw) => raw,
				actions: ["重试", "改用镜像"]
			},
			{
				test: /中断|aborted|ECONNRESET/i,
				code: "FG-NET-003",
				conclusion: "下载中断",
				cause: (raw) => raw,
				actions: ["重试"]
			},
			{
				test: /Library not loaded|dyld|image not found|error while loading shared libraries|cannot open shared object file/i,
				code: "FG-PKG-004",
				conclusion: "安装包缺少运行库",
				cause: (raw) => raw,
				actions: ["换一个版本", "查看技术细节"]
			},
			{
				test: /sha256|校验|md5|指纹/i,
				code: "FG-PKG-001",
				conclusion: "安装包校验未通过",
				cause: (raw) => raw,
				actions: ["换一个来源重试"]
			},
			{
				test: /解压|extract|zip|tar/i,
				code: "FG-PKG-002",
				conclusion: "解压失败",
				cause: (raw) => raw,
				actions: ["删除缓存后重试"]
			},
			{
				test: /空间|ENOSPC/i,
				code: "FG-PKG-003",
				conclusion: "磁盘空间不足",
				cause: (raw) => raw,
				actions: ["清理磁盘空间"]
			},
			{
				test: /未签名|Gatekeeper|quarantine|codesign/i,
				code: "FG-PERM-001",
				conclusion: "被系统安全策略拦截",
				cause: (raw) => raw,
				actions: ["查看技术细节"]
			},
			{
				test: /EACCES|EPERM|不可写|权限/i,
				code: "FG-PERM-002",
				conclusion: "安装目录不可写",
				cause: (raw) => raw,
				actions: ["检查目录权限"]
			},
			{
				test: /EADDRINUSE|端口.*占用|被占用/,
				code: "FG-PORT-001",
				conclusion: "端口已被占用",
				cause: (raw) => raw,
				actions: ["改端口", "停止占用端口的进程"]
			},
			{
				test: /健康检查/,
				code: "FG-BOOT-001",
				conclusion: "服务启动后无响应",
				cause: (raw) => raw,
				actions: ["查看日志", "回滚上一版本"]
			},
			{
				test: /异常退出|崩溃/,
				code: "FG-BOOT-002",
				conclusion: "服务运行中退出",
				cause: (raw) => raw,
				actions: ["查看日志", "回滚上一版本"]
			},
			{
				test: /授权码/,
				code: "FG-LIC-001",
				conclusion: "授权码未被接受",
				cause: (raw) => raw,
				actions: ["核对授权码"]
			},
			{
				test: /来源.*不一致|拒绝|403/,
				code: "FG-API-403",
				conclusion: "管理接口拒绝了请求",
				cause: (raw) => raw,
				actions: ["从本机页面重试"]
			},
			{
				test: /已有任务/,
				code: "FG-API-409",
				conclusion: "已有任务在进行",
				cause: () => "同一个时刻只能有一个安装/升级任务。",
				actions: ["等待完成", "取消"]
			}
		];
		/** Cut a raw message down to the 60-character budget the design allows. */
		function clampCause(text) {
			const flat = text.replace(/\s+/g, " ").trim();
			return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
		}
		function diagnose(raw, conclusion) {
			for (const rule of RULES) if (rule.test.test(raw)) return {
				conclusion: conclusion ?? rule.conclusion,
				cause: clampCause(rule.cause(raw)),
				code: rule.code,
				actions: rule.actions
			};
			return {
				conclusion: conclusion ?? "操作未完成",
				cause: clampCause(raw),
				code: "FG-API-000",
				actions: ["查看日志"]
			};
		}
		function Btn(props) {
			const variant = props.variant ?? "default";
			const cls = variant === "default" ? "fg-btn" : `fg-btn fg-btn-${variant}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: cls,
				onClick: props.onClick,
				disabled: props.disabled === true,
				title: props.title,
				children: props.children
			});
		}
		function Card(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "fg-card",
				children: [props.title === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fg-card-title",
					children: props.title
				}), props.children]
			});
		}
		function Row(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fg-row-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: props.main }), props.sub === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-row-sub",
						children: props.sub
					})]
				}), props.right]
			});
		}
		function Copy(props) {
			const [copied, setCopied] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "fg-copy",
				onClick: () => {
					navigator.clipboard?.writeText(props.value).then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1600);
					});
				},
				children: copied ? "已复制" : props.label ?? "复制"
			});
		}
		function ErrorCard(props) {
			const diagnosis = diagnose(props.raw, props.conclusion);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-error",
				role: "alert",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-error-title",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚠ ", diagnosis.conclusion] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "fg-error-code",
							children: diagnosis.code
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-error-cause",
						children: ["原因：", diagnosis.cause]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-actions",
						children: [diagnosis.actions.map((action) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "fg-hint",
							children: ["· ", action]
						}, action)), props.onDismiss === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "ghost",
							onClick: props.onDismiss,
							children: "关闭"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "fg-details",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: "技术细节（供排障使用）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
							className: "fg-code",
							children: props.raw
						})]
					})
				]
			});
		}
		/** Poll one endpoint. Stops while the tab is hidden, so a background GUI idles. */
		function usePoll(path, intervalMs) {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [nonce, setNonce] = (0, react.useState)(0);
			const pathRef = (0, react.useRef)(path);
			pathRef.current = path;
			(0, react.useEffect)(() => {
				if (path === null) {
					setData(null);
					return;
				}
				let cancelled = false;
				const tick = async () => {
					if (document.hidden) return;
					try {
						const result = await api(path);
						if (!cancelled) {
							setData(result);
							setError(null);
						}
					} catch (cause) {
						if (!cancelled) setError(cause.message);
					}
				};
				tick();
				const timer = window.setInterval(() => void tick(), intervalMs);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [
				path,
				intervalMs,
				nonce
			]);
			return {
				data,
				error,
				reload: (0, react.useCallback)(() => setNonce((value) => value + 1), [])
			};
		}
		/** Wrap an action: busy flag, error capture, and a reload callback. */
		function useAction(onDone) {
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const done = (0, react.useRef)(onDone);
			done.current = onDone;
			return {
				busy,
				error,
				clearError: () => setError(null),
				run: (0, react.useCallback)((label, body) => {
					setBusy(label);
					setError(null);
					body().then(() => done.current()).catch((cause) => setError(cause.message)).finally(() => setBusy(null));
				}, [])
			};
		}
		/** The status vocabulary is a contract with the design doc: one word each. */
		function stateView(status) {
			switch (status.state) {
				case "not-installed": return {
					word: "未安装",
					icon: "○",
					tone: "idle"
				};
				case "stopped": return {
					word: "已停止",
					icon: "■",
					tone: "idle"
				};
				case "starting": return {
					word: "启动中",
					icon: "◌",
					tone: "busy"
				};
				case "running": return {
					word: "运行中",
					icon: "●",
					tone: "ok"
				};
				case "degraded": return {
					word: "降级运行",
					icon: "▲",
					tone: "warn"
				};
				case "error": return {
					word: "异常",
					icon: "✕",
					tone: "bad"
				};
				case "updating": return {
					word: "升级中",
					icon: "⟳",
					tone: "busy"
				};
				default: return {
					word: String(status.state),
					icon: "·",
					tone: "idle"
				};
			}
		}
		const TONE_CLASS = {
			idle: "fg-state-idle",
			busy: "fg-state-busy",
			ok: "fg-state-ok",
			warn: "fg-state-warn",
			bad: "fg-state-bad"
		};
		function formatBytes(bytes) {
			if (bytes === null) return "";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
			return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		}
		function formatDuration(ms) {
			if (ms === null) return "";
			const seconds = Math.floor(ms / 1e3);
			if (seconds < 60) return `${seconds} 秒`;
			if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
			return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
		}
		const JOB_PHASE_WORD = {
			queued: "排队中",
			resolving: "解析中",
			downloading: "下载中",
			verifying: "校验中",
			extracting: "解压中",
			activating: "切换版本",
			starting: "启动中",
			confirming: "确认中",
			done: "已完成",
			failed: "失败",
			cancelled: "已取消"
		};
		function JobProgress(props) {
			const job = props.job;
			if (job === null) return null;
			const terminal = job.phase === "done" || job.phase === "failed" || job.phase === "cancelled";
			if (terminal && job.phase === "done" && job.noop) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-hint",
				children: job.message ?? "无需操作"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fg-row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-row-main",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								job.label,
								" · ",
								JOB_PHASE_WORD[job.phase],
								job.percent === null ? "" : ` · ${job.percent}%`
							] }),
							job.message === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "fg-row-sub",
								children: job.message
							}),
							job.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-row-sub fg-state-bad",
								children: ["原因：", job.error]
							})
						]
					}), props.busy && !terminal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
						onClick: props.onCancel,
						children: "取消"
					}) : null]
				}),
				terminal ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: `fg-progress${job.percent === null ? " fg-progress-indeterminate" : ""}`,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { width: job.percent === null ? "32%" : `${job.percent}%` } })
				}),
				job.bytesTotal === null || job.bytesDone === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fg-hint",
					children: [
						formatBytes(job.bytesDone),
						" / ",
						formatBytes(job.bytesTotal)
					]
				}),
				job.attemptedSources.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fg-hint",
					children: ["已尝试来源：", job.attemptedSources.join(" → ")]
				}) : null
			] });
		}
		function ServicePanel(props) {
			const { status, reload } = props;
			const job = usePoll("/jobs/current", 900);
			const catalog = usePoll("/install/catalog", 3e4);
			const action = useAction(reload);
			const [version, setVersion] = (0, react.useState)("");
			const [allowUnverified, setAllowUnverified] = (0, react.useState)(false);
			const [confirmUninstall, setConfirmUninstall] = (0, react.useState)(false);
			const busy = action.busy !== null;
			const versions = catalog.data?.versions ?? [];
			const recommended = catalog.data?.recommended ?? null;
			const installed = status.installedVersions;
			const updateAvailable = recommended !== null && status.currentVersion !== recommended;
			const startInstall = (target) => {
				action.run("install", () => post("/install", {
					version: target,
					allowUnverified,
					reinstall: target !== null && target === status.currentVersion
				}));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						conclusion: "服务操作未完成",
						onDismiss: action.clearError
					}),
					job.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: job.error,
						conclusion: "无法读取任务状态"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "版本",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
							className: "fg-grid",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "当前版本" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: status.currentVersion ?? "—" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "可升级到" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [recommended ?? "—", updateAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "fg-tag fg-tag-busy",
									style: { marginLeft: 8 },
									children: "有更新"
								}) : null] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "上一可用版本" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: status.lastKnownGood ?? "—" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "已安装" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
									className: "fg-mono",
									children: installed.length === 0 ? "—" : installed.join("、")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "兼容区间" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", {
									className: "fg-mono",
									children: [
										"≥ ",
										status.manifest.minSupportedServer,
										status.manifest.maxTestedServer === null ? "" : ` · 已测至 ${status.manifest.maxTestedServer}`
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-actions",
							children: [
								updateAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "primary",
									disabled: busy,
									onClick: () => startInstall(null),
									children: status.currentVersion === null ? "安装后台服务" : `升级到 v${recommended}`
								}) : null,
								status.currentVersion === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									disabled: busy,
									onClick: () => startInstall(status.currentVersion),
									children: "重新安装当前版本"
								}),
								status.lastKnownGood === null || status.lastKnownGood === status.currentVersion ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Btn, {
									disabled: busy,
									onClick: () => action.run("rollback", () => post("/install/rollback", { version: status.lastKnownGood })),
									children: ["回滚到 v", status.lastKnownGood]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "指定版本",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "fg-hint",
								children: "上游各平台的发布节奏不一致：Windows 停在 1.2.19，macOS Intel 与 Linux arm64 也落后于最新版。这里列出的是本机平台真实存在的版本。"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									htmlFor: "fg-version",
									children: "版本"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									id: "fg-version",
									className: "fg-input",
									value: version,
									onChange: (event) => setVersion(event.target.value),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: "",
										children: [
											"（使用推荐版本 ",
											recommended ?? "—",
											"）"
										]
									}), versions.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: entry.version,
										children: [
											entry.version,
											entry.installed ? "（已安装）" : "",
											entry.unverified ? "（无校验值）" : ""
										]
									}, entry.version))]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "fg-check",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: allowUnverified,
									onChange: (event) => setAllowUnverified(event.target.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["允许安装没有校验值的版本", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "fg-hint",
									children: "上游未为该资产提供 sha256 时无法校验完整性。默认拒绝；只有你确认来源可信时才应开启。"
								})] })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									disabled: busy || versions.length === 0,
									onClick: () => startInstall(version === "" ? null : version),
									children: "安装所选版本"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "ghost",
									onClick: catalog.reload,
									children: "重新读取清单"
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "控制",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-actions",
								style: { marginTop: 0 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
										disabled: busy,
										onClick: () => action.run("start", () => post("/service/start")),
										children: "启动"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
										variant: "danger",
										disabled: busy,
										onClick: () => action.run("stop", () => post("/service/stop")),
										children: "停止"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
										disabled: busy,
										onClick: () => action.run("restart", () => post("/service/restart")),
										children: "重启"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
								className: "fg-grid",
								style: { marginTop: 10 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "进程号" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
										className: "fg-mono",
										children: status.pid ?? "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "监听端口" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", {
										className: "fg-mono",
										children: [status.port, status.effectivePort === null || status.effectivePort === status.port ? "" : `（实际 ${status.effectivePort}）`]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "运行时长" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: formatDuration(status.uptimeMs) || "—" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "本次会话重启" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: status.restarts === 0 ? "无" : `${status.restarts} 次` })
								]
							}),
							job.data?.job === null || job.data === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { marginTop: 10 },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobProgress, {
									job: job.data.job,
									busy: job.data.busy,
									onCancel: () => action.run("cancel", () => post("/jobs/cancel"))
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "卸载",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hint",
							children: [
								"卸载会停止后台服务并删除已安装的版本目录。",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "data/ 目录默认保留" }),
								"——设备标识、授权码与各平台登录 token 都在那里，删除后需要重新登录、并可能重新消耗试用期。"
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "fg-actions",
							children: confirmUninstall ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "danger",
									disabled: busy,
									onClick: () => {
										setConfirmUninstall(false);
										action.run("uninstall", () => post("/install/uninstall", { purgeData: false }));
									},
									children: "确认卸载（保留数据）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "danger",
									disabled: busy,
									onClick: () => {
										setConfirmUninstall(false);
										action.run("uninstall", () => post("/install/uninstall", { purgeData: true }));
									},
									children: "确认卸载并删除数据"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "ghost",
									onClick: () => setConfirmUninstall(false),
									children: "取消"
								})
							] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
								variant: "danger",
								disabled: busy,
								onClick: () => setConfirmUninstall(true),
								children: "卸载后台服务"
							})
						})]
					})
				]
			});
		}
		function LicensePanel(props) {
			const overview = usePoll("/account/overview", 1e4);
			const action = useAction(props.reload);
			const [key, setKey] = (0, react.useState)("");
			const [confirmClear, setConfirmClear] = (0, react.useState)(false);
			const license = overview.data?.license ?? null;
			const info = overview.data?.info ?? null;
			const busy = action.busy !== null;
			const edition = license?.edition ?? info?.license.edition ?? null;
			const editionTag = (() => {
				if (edition === "licensed") return {
					text: "授权版",
					cls: "fg-tag-ok"
				};
				if (edition === "expired") return {
					text: "订阅已过期",
					cls: "fg-tag-bad"
				};
				if (license?.subscriptionActive === false) return {
					text: "免费",
					cls: ""
				};
				return {
					text: "免费",
					cls: ""
				};
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						conclusion: "授权操作未完成",
						onDismiss: action.clearError
					}),
					overview.data !== null && overview.data.reachable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "后台服务未运行，无法读取授权状态。授权信息保存在本机 data/license.json，启动服务后会立即恢复显示。"
					}) }) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["授权状态 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `fg-tag ${editionTag.cls}`,
							children: editionTag.text
						})] }),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
								className: "fg-grid",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "授权码" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
										className: "fg-mono",
										children: license?.keyMasked === null || license?.keyMasked === "" ? "未填写" : license?.keyMasked
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "产品" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: license?.product ?? info?.license.product ?? "—" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "设备标识" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "fg-mono",
											children: license?.deviceId ?? info?.deviceId ?? "—"
										}),
										" ",
										license?.deviceId === null || license?.deviceId === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Copy, { value: license.deviceId })
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "订阅到期" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: license?.subscriptionExpiresAt ?? "—（永久或未订阅）" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "宽限期" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [license?.gracePeriodExpiresAt ?? "—", license?.graceRemainingDays === null || license?.graceRemainingDays === void 0 ? "" : ` · 还剩 ${license.graceRemainingDays} 天`] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "云端规则" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [license?.capabilitiesLoaded === true ? "已同步" : "未同步（显示为本地默认规则）", license?.capabilitiesMessage === null || license?.capabilitiesMessage === void 0 ? "" : ` · ${license.capabilitiesMessage}`] })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									htmlFor: "fg-license",
									children: "输入授权码"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "fg-license",
									className: "fg-input",
									placeholder: "FG-XXXX-XXXX-XXXX",
									value: key,
									onChange: (event) => setKey(event.target.value)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "primary",
									disabled: busy || key.trim() === "",
									onClick: () => action.run("activate", async () => {
										await post("/license/activate", { licenseKey: key.trim() });
										setKey("");
									}),
									children: "写入并激活"
								}), confirmClear ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "danger",
									disabled: busy,
									onClick: () => {
										setConfirmClear(false);
										action.run("deactivate", () => post("/license/deactivate"));
									},
									children: "确认解除"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "ghost",
									onClick: () => setConfirmClear(false),
									children: "取消"
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
									variant: "danger",
									disabled: busy,
									onClick: () => setConfirmClear(true),
									children: "解除授权"
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "平台能力",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hint",
							children: [
								"这一栏是",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "授权" }),
								"能覆盖哪些平台、各自试用还剩多久，由服务端下发的规则决定；它不是登录状态（登录状态见「账号总览」）。"
							]
						}), (license?.platforms ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "fg-empty",
							children: "尚未拿到平台能力列表。"
						}) : (license?.platforms ?? []).map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							main: entry.platform,
							sub: entry.message ?? void 0,
							right: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `fg-tag ${entry.enabled ? "fg-tag-ok" : "fg-tag-warn"}`,
								children: [entry.enabled ? "可用" : "不可用", entry.trialRemainingDays === null || entry.trialRemainingDays === void 0 ? "" : ` · 试用剩 ${entry.trialRemainingDays} 天`]
							})
						}, entry.platform))]
					})
				]
			});
		}
		function AccountsPanel(props) {
			const data = usePoll("/account/overview", 1e4).data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
					title: "平台账号",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							"这一栏是",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "登录" }),
							"状态。登录动作在「",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "平台登录" }),
							"」标签里完成（也可以继续在聊天里让模型调用工具）。"
						]
					}), data === null || data.reachable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "后台服务未运行，无法读取平台登录状态。"
					}) : data.platforms.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "服务端未返回平台列表。"
					}) : data.platforms.map((entry) => {
						const sub = accountSummary(entry);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							main: entry.platformName,
							sub,
							right: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `fg-tag ${entry.authenticated ? "fg-tag-ok" : ""}`,
								children: entry.authenticated ? "账号已登录" : "账号未登录"
							})
						}, entry.platformId);
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
					title: "摄像头",
					children: data?.cameraSupported === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: "当前平台的上游构建不包含摄像头能力（Windows 版本编译时关闭了取流），因此这里不会有摄像头。其它平台功能不受影响。"
					}) : data === null || data.reachable === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "后台服务未运行。"
					}) : data.cameras.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "没有摄像头。若已登录米家，可在聊天里让模型调用 xiaomi/camera_list 刷新。"
					}) : data.cameras.map((camera) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
						main: camera.name,
						sub: camera.deviceId,
						right: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `fg-tag ${camera.online ? "fg-tag-ok" : "fg-tag-warn"}`,
							children: camera.online ? "在线" : "离线"
						})
					}, camera.deviceId))
				})]
			});
		}
		/** `区域 cn · 登录有效期剩 2 天` —— 与「账号总览」用同一套词。 */
		function accountSummary(account) {
			const remaining = account.authStatus["token_remaining_seconds"];
			const region = account.authStatus["cloud_server"] ?? account.authStatus["region"];
			const parts = [typeof region === "string" && region !== "" ? `区域 ${region}` : null, typeof remaining === "number" ? `登录有效期剩 ${formatDuration(remaining * 1e3)}` : null].filter((part) => part !== null);
			return parts.length === 0 ? void 0 : parts.join(" · ");
		}
		function Field(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: props.label }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: "fg-input",
						type: props.type ?? "text",
						value: props.value,
						placeholder: props.placeholder ?? "",
						onChange: (event) => props.onChange(event.target.value)
					}),
					props.hint === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: props.hint
					})
				]
			});
		}
		function Select(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-field",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: props.label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
					className: "fg-input",
					value: props.value,
					onChange: (event) => props.onChange(event.target.value),
					children: props.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.value,
						children: option.label
					}, option.value))
				})]
			});
		}
		/** One platform's card: name, live status, and either the flow or the reason. */
		function PlatformCard(props) {
			const account = props.account;
			const summary = account === void 0 ? void 0 : accountSummary(account);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [props.name, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `fg-tag ${account?.authenticated === true ? "fg-tag-ok" : ""}`,
					children: account === void 0 ? "状态未知" : account.authenticated ? "已登录" : "未登录"
				})] }),
				children: [summary === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fg-hint",
					children: summary
				}), props.unavailable == null || props.unavailable === "" ? props.children : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fg-hint",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "fg-tag fg-tag-warn",
							children: "本构建不支持"
						}),
						" ",
						props.unavailable
					]
				})]
			});
		}
		/** 退出登录：调一次宿主接口，然后让状态重新拉取。 */
		function LogoutButton(props) {
			const action = useAction(props.onDone);
			if (!props.available) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-hint",
				children: ["退出登录：", props.reason ?? "当前上游构建没有该平台的退出接口"]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-actions",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
					variant: "danger",
					disabled: action.busy !== null,
					onClick: () => action.run("logout", () => post("/auth/logout", { platform: props.platformId })),
					children: action.busy === null ? "退出登录" : "正在退出…"
				})
			}), action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
				raw: action.error,
				onDismiss: action.clearError
			})] });
		}
		function XiaomiLogin(props) {
			const hasUrl = props.tools.has("xiaomi/auth_url") && props.tools.has("xiaomi/auth_callback");
			const [region, setRegion] = (0, react.useState)("cn");
			const [url, setUrl] = (0, react.useState)(null);
			const [urlRegion, setUrlRegion] = (0, react.useState)("cn");
			const [auto, setAuto] = (0, react.useState)(false);
			const [showFallback, setShowFallback] = (0, react.useState)(false);
			const [pasted, setPasted] = (0, react.useState)("");
			const [done, setDone] = (0, react.useState)(null);
			const action = useAction(props.reload);
			const authenticated = props.account?.authenticated === true;
			const reloadRef = (0, react.useRef)(props.reload);
			reloadRef.current = props.reload;
			(0, react.useEffect)(() => {
				if (url === null) return;
				if (authenticated) {
					setDone(`授权成功（区域 ${urlRegion}）`);
					setUrl(null);
					setShowFallback(false);
					setPasted("");
					return;
				}
				const timer = setInterval(() => reloadRef.current(), 2500);
				return () => clearInterval(timer);
			}, [
				url,
				authenticated,
				urlRegion
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PlatformCard, {
				name: "米家（小米）",
				account: props.account,
				unavailable: hasUrl ? null : "当前上游构建没有米家授权工具（xiaomi/auth_url、xiaomi/auth_callback）。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: auto === true ? "三步：选区域 → 获取授权地址 → 在浏览器里登录。登录成功后浏览器会自动跳回本机服务完成授权（页面显示\"授权成功\"），无需粘贴任何地址 —— 本页会自动检测并更新登录状态。" : "三步：选区域 → 获取授权地址 → 在浏览器里登录并确认授权。登录完成后浏览器会跳到一个打不开的页面（https://127.0.0.1/?code=…），这是正常的 —— 授权码只在该页面的地址栏里；把地址栏整段复制下来，粘贴到下方\"粘贴回调地址\"输入框，点\"完成授权\"即可。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-form-2",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Select, {
							label: "账号区域",
							value: region,
							onChange: setRegion,
							options: [
								{
									value: "cn",
									label: "cn 中国大陆"
								},
								{
									value: "de",
									label: "de 欧洲（德国）"
								},
								{
									value: "i2",
									label: "i2 印度"
								},
								{
									value: "ru",
									label: "ru 俄罗斯"
								},
								{
									value: "sg",
									label: "sg 新加坡"
								},
								{
									value: "us",
									label: "us 美国"
								}
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: "选错区域会看不到设备；应选账号实际使用的区域。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null,
							onClick: () => action.run("xiaomi-url", async () => {
								const result = await post("/auth/xiaomi/url", { region });
								setUrl(result.url);
								setUrlRegion(region);
								setAuto(result.autoCallback === true);
								setDone(null);
							}),
							children: action.busy === null ? "获取授权地址" : "正在获取…"
						})
					}),
					url === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "fg-link",
								href: url,
								target: "_blank",
								rel: "noreferrer",
								children: "在浏览器里打开授权页"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Copy, {
								value: url,
								label: "复制地址"
							})]
						}),
						auto ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hint",
							children: [
								"等待登录结果…（登录完成后浏览器会跳到 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: "fg-code",
									children: "授权成功"
								}),
								" 页面，本页自动更新状态）"
							]
						}) : null,
						auto && !showFallback ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hint",
							children: ["自动授权没有反应？", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "fg-link",
								onClick: () => setShowFallback(true),
								children: "手动粘贴回调地址"
							})]
						}) : null,
						!auto || showFallback ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "粘贴回调地址（或只粘 code）",
							value: pasted,
							onChange: setPasted,
							placeholder: "https://127.0.0.1/?code=…"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "fg-actions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
								variant: "primary",
								disabled: action.busy !== null || pasted.trim() === "",
								onClick: () => action.run("xiaomi-callback", async () => {
									const result = await post("/auth/xiaomi/callback", {
										input: pasted,
										region: urlRegion
									});
									setDone(result.region === null ? "授权成功" : `授权成功（区域 ${result.region}）`);
									setUrl(null);
									setPasted("");
								}),
								children: action.busy === null ? "完成授权" : "正在交换令牌…"
							})
						})] }) : null
					] }),
					done === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag fg-tag-ok",
								children: "成功"
							}),
							" ",
							done
						]
					}),
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						onDismiss: action.clearError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogoutButton, {
						platformId: "xiaomi",
						onDone: props.reload,
						available: authenticated,
						reason: "登录后才能退出"
					})
				]
			});
		}
		function TuyaLogin(props) {
			const hasQr = props.tools.has("auth/tuya_qr") && props.tools.has("auth/tuya_qr_status");
			const { reload } = props;
			const [userCode, setUserCode] = (0, react.useState)("");
			const [ticket, setTicket] = (0, react.useState)(null);
			const [generatedAt, setGeneratedAt] = (0, react.useState)(0);
			const [scan, setScan] = (0, react.useState)("idle");
			const [detail, setDetail] = (0, react.useState)(null);
			/** 非终态的等待说明（网络抖动等）：页面继续轮询，不把失败标签甩给用户。 */
			const [transient, setTransient] = (0, react.useState)(null);
			const action = useAction(props.reload);
			(0, react.useEffect)(() => {
				if (ticket === null || scan !== "waiting") return;
				let cancelled = false;
				const loop = async () => {
					const expiresAt = generatedAt + Math.max(30, ticket.expireSeconds) * 1e3;
					while (!cancelled) {
						if (Date.now() > expiresAt) {
							setScan("error");
							setDetail("二维码已过期，请重新生成（涂鸦二维码有效期很短）");
							return;
						}
						try {
							const status = await post("/auth/tuya/status", {
								token: ticket.token,
								userCode
							});
							if (cancelled) return;
							if (status.status === "authorized") {
								setScan("authorized");
								setDetail(status.uid === null ? "涂鸦账号已登录" : `涂鸦账号已登录（uid ${status.uid}）`);
								reload();
								return;
							}
							if (status.status === "error") {
								setScan("error");
								setDetail(status.message ?? "二维码已失效，请重新生成");
								return;
							}
						} catch (cause) {
							if (cancelled) return;
							setTransient(`请求没有成功（${cause.message}），自动重试中…`);
							await new Promise((resolve) => setTimeout(resolve, 2e3));
							continue;
						}
					}
				};
				loop();
				return () => {
					cancelled = true;
				};
			}, [
				ticket,
				scan,
				userCode,
				generatedAt,
				reload
			]);
			const qrSrc = ticket === null ? null : withApiPrefix(ticket.imageUrl);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PlatformCard, {
				name: "涂鸦（Tuya）",
				account: props.account,
				unavailable: hasQr ? null : "当前上游构建没有涂鸦二维码工具（auth/tuya_qr）。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							"用户代码在涂鸦 App 里：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "我的 → 设置 → 账号与安全 → 用户代码" }),
							"。填好后生成二维码，用涂鸦 App 右上角 「+ → 扫一扫」扫它，再在 App 里点「确认登录」。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "用户代码",
						value: userCode,
						onChange: setUserCode,
						placeholder: "AY1790336520…"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null || userCode.trim() === "",
							onClick: () => action.run("tuya-qr", async () => {
								const result = await post("/auth/tuya/qr", { userCode });
								setTicket(result);
								setGeneratedAt(Date.now());
								setScan("waiting");
								setDetail(null);
								setTransient(null);
							}),
							children: action.busy === null ? ticket === null ? "生成二维码" : "重新生成" : "正在生成…"
						})
					}),
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						onDismiss: action.clearError
					}),
					ticket === null || qrSrc === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
						className: "fg-qr",
						src: qrSrc,
						alt: "涂鸦授权二维码"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							"二维码 ",
							ticket.expireSeconds,
							" 秒内有效。",
							scan === "waiting" ? "正在等你扫码（会一直等到扫到为止，页面不用管）。" : null,
							scan === "authorized" ? " 已扫码确认。" : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								className: "fg-link",
								href: withApiPrefix(ticket.textUrl),
								target: "_blank",
								rel: "noreferrer",
								children: "图片显示不出来？用文本二维码"
							})
						]
					})] }),
					detail === null && transient === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: transient !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag",
								children: "重试"
							}),
							" ",
							transient
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `fg-tag ${scan === "authorized" ? "fg-tag-ok" : "fg-tag-bad"}`,
								children: scan === "authorized" ? "成功" : "失败"
							}),
							" ",
							detail
						] })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogoutButton, {
						platformId: "tuya",
						onDone: props.reload,
						available: props.tools.has("auth/tuya_logout"),
						reason: "当前上游构建没有涂鸦退出工具（auth/tuya_logout）"
					})
				]
			});
		}
		function MideaLogin(props) {
			const hasLogin = props.tools.has("auth/midea_login");
			const [account, setAccount] = (0, react.useState)("");
			const [password, setPassword] = (0, react.useState)("");
			const [cloud, setCloud] = (0, react.useState)("meiju");
			const [done, setDone] = (0, react.useState)(null);
			const action = useAction(props.reload);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PlatformCard, {
				name: "美的（Midea）",
				account: props.account,
				unavailable: hasLogin ? null : "当前上游构建没有美的登录工具（auth/midea_login）。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: "账号密码直接交给本机后台服务（127.0.0.1），插件不保存、不写日志。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-form-2",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "美的账号",
								value: account,
								onChange: setAccount,
								placeholder: "手机号 / 邮箱"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "密码",
								value: password,
								onChange: setPassword,
								type: "password"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Select, {
								label: "客户端类型",
								value: cloud,
								onChange: setCloud,
								options: [{
									value: "meiju",
									label: "美居（meiju）"
								}, {
									value: "msmart",
									label: "MSmartHome（msmart）"
								}]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null || account.trim() === "" || password === "",
							onClick: () => action.run("midea-login", async () => {
								const result = await post("/auth/midea/login", {
									account,
									password,
									cloud
								});
								setDone(`登录成功，已同步 ${result.deviceCount} 个设备（${result.cloud}）`);
								setPassword("");
							}),
							children: action.busy === null ? "登录" : "正在登录…"
						})
					}),
					done === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag fg-tag-ok",
								children: "成功"
							}),
							" ",
							done
						]
					}),
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						onDismiss: action.clearError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogoutButton, {
						platformId: "midea",
						onDone: props.reload,
						available: props.tools.has("auth/midea_logout"),
						reason: "当前上游构建没有美的退出工具（auth/midea_logout）"
					})
				]
			});
		}
		function EwelinkLogin(props) {
			const hasLogin = props.tools.has("auth/ewelink_login");
			const [email, setEmail] = (0, react.useState)("");
			const [password, setPassword] = (0, react.useState)("");
			const [countryCode, setCountryCode] = (0, react.useState)("+86");
			const [done, setDone] = (0, react.useState)(null);
			const action = useAction(props.reload);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PlatformCard, {
				name: "易微联（eWeLink）",
				account: props.account,
				unavailable: hasLogin ? null : "当前上游构建没有易微联登录工具（auth/ewelink_login）。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-hint",
						children: "账号密码直接交给本机后台服务（127.0.0.1），插件不保存、不写日志。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-form-2",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "邮箱或手机号",
								value: email,
								onChange: setEmail
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "密码",
								value: password,
								onChange: setPassword,
								type: "password"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
								label: "国家代码",
								value: countryCode,
								onChange: setCountryCode,
								placeholder: "+86",
								hint: "账号注册地；填错会登录失败或看不到设备。"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null || email.trim() === "" || password === "",
							onClick: () => action.run("ewelink-login", async () => {
								const result = await post("/auth/ewelink/login", {
									email,
									password,
									countryCode
								});
								setDone(`登录成功，已同步 ${result.deviceCount} 个设备`);
								setPassword("");
							}),
							children: action.busy === null ? "登录" : "正在登录…"
						})
					}),
					done === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag fg-tag-ok",
								children: "成功"
							}),
							" ",
							done
						]
					}),
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						onDismiss: action.clearError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogoutButton, {
						platformId: "ewelink",
						onDone: props.reload,
						available: props.tools.has("auth/ewelink_logout"),
						reason: "当前上游构建没有易微联退出工具（auth/ewelink_logout）"
					})
				]
			});
		}
		function HuaweiLogin(props) {
			const [account, setAccount] = (0, react.useState)("");
			const [password, setPassword] = (0, react.useState)("");
			const [code, setCode] = (0, react.useState)("");
			const [needCode, setNeedCode] = (0, react.useState)(false);
			const [challengeName, setChallengeName] = (0, react.useState)(null);
			const [done, setDone] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const action = useAction(props.reload);
			const applyOutcome = (outcome) => {
				setNeedCode(outcome.needCode);
				setChallengeName(outcome.challengeName);
				if (outcome.retryWithoutCode) {
					setNotice("验证码已通过、会话已保留：无需重新输入，可直接继续（若状态仍是未登录，稍后会自动补齐令牌）。");
					props.reload();
					return;
				}
				if (outcome.authenticated) {
					setDone("华为账号已登录");
					setPassword("");
					setCode("");
					props.reload();
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PlatformCard, {
				name: "华为智慧生活",
				account: props.account,
				unavailable: props.tools.has("auth/huawei_login") ? null : "本机后台服务（v1.2.19）没有华为登录工具 —— 上游在 v1.2.20 才加上 auth/huawei_login / auth/huawei_challenge / auth/huawei_logout。升级后台服务后这张卡片会自动出现，无需升级插件。",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							"两步验证：先提交账号密码，再提交验证码。",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "华为不发短信" }),
							" —— 验证码显示在已登录的华为手机/平板弹窗里， 或「设置 → 华为帐号 → 帐号安全」。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-form-2",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "华为账号（手机号或邮箱）",
							value: account,
							onChange: setAccount
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "账号密码",
							value: password,
							onChange: setPassword,
							type: "password"
						})]
					}),
					needCode ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "双重验证码",
						value: code,
						onChange: setCode,
						hint: challengeName === null ? void 0 : `上游提示验证码发往：${challengeName}`
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null || code.trim() === "",
							onClick: () => action.run("huawei-challenge", async () => {
								setNotice(null);
								applyOutcome(await post("/auth/huawei/challenge", { code }));
							}),
							children: action.busy === null ? "提交验证码" : "正在验证…"
						})
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: action.busy !== null || account.trim() === "" || password === "",
							onClick: () => action.run("huawei-login", async () => {
								setNotice(null);
								applyOutcome(await post("/auth/huawei/login", {
									account,
									password
								}));
							}),
							children: action.busy === null ? "登录" : "正在登录…"
						})
					}),
					notice === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag fg-tag-warn",
								children: "注意"
							}),
							" ",
							notice
						]
					}),
					done === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-hint",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fg-tag fg-tag-ok",
								children: "成功"
							}),
							" ",
							done
						]
					}),
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						onDismiss: action.clearError
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogoutButton, {
						platformId: "huawei",
						onDone: props.reload,
						available: props.tools.has("auth/huawei_logout"),
						reason: "本机上游构建没有华为退出工具（需 v1.2.20 及以上）"
					})
				]
			});
		}
		function LoginPanel(props) {
			const capabilities = usePoll("/auth/capabilities", 2e4);
			const overview = usePoll("/account/overview", 1e4);
			const caps = capabilities.data;
			const tools = (0, react.useMemo)(() => new Set(caps?.tools ?? []), [caps]);
			const accounts = overview.data?.platforms ?? [];
			const accountOf = (id) => accounts.find((entry) => entry.platformId === id);
			const reload = props.reload;
			if (caps === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
					title: "平台登录",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "正在读取后台服务的授权能力…"
					})
				})
			});
			if (caps.childReachable === false) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
					title: "平台登录",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-empty",
						children: "后台服务未运行：请先在「服务」标签里安装并启动，再回到这里登录。"
					})
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
						title: "从这里登录",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hint",
							children: [
								"账号密码 / 验证码只在本机回环内交给后台服务进程，",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "插件不保存、不写日志、不回显" }),
								"；退出登录会清掉后台服务里的令牌。 「账号总览」标签只显示状态，登录动作都在这里完成。"
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(XiaomiLogin, {
						tools,
						account: accountOf("xiaomi"),
						reload
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TuyaLogin, {
						tools,
						account: accountOf("tuya"),
						reload
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MideaLogin, {
						tools,
						account: accountOf("midea"),
						reload
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EwelinkLogin, {
						tools,
						account: accountOf("ewelink"),
						reload
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HuaweiLogin, {
						account: accountOf("huawei"),
						tools,
						reload
					})
				]
			});
		}
		function SettingsPanel(props) {
			const settings = usePoll("/settings", 3e4);
			const action = useAction(() => {
				props.reload();
				settings.reload();
			});
			const [draft, setDraft] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			const launcher = boot().launcher;
			const current = settings.data?.settings ?? null;
			const value = draft ?? current;
			(0, react.useEffect)(() => {
				if (current !== null) setDraft((previous) => previous ?? current);
			}, [current]);
			if (value === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-root",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, { children: settings.error === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fg-empty",
					children: "正在读取设置…"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
					raw: settings.error,
					conclusion: "读取设置失败"
				}) })
			});
			const patch = (next) => setDraft({
				...value,
				...next
			});
			const dirty = current !== null && JSON.stringify(current) !== JSON.stringify(value);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [
					action.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: action.error,
						conclusion: "设置未保存",
						onDismiss: action.clearError
					}),
					note === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-card fg-hint",
						children: note
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "后台服务",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "fg-server-port",
										children: "后台服务端口"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "fg-server-port",
										className: "fg-input fg-mono",
										type: "number",
										min: 1024,
										max: 65535,
										value: value.serverPort,
										onChange: (event) => patch({ serverPort: Number.parseInt(event.target.value, 10) || 0 })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hint",
										children: "端口被占用时插件会自动向上顺延，并在状态里显示实际端口，不会因此启动失败。"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "fg-bind",
										children: "监听地址"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										id: "fg-bind",
										className: "fg-input",
										value: value.bindAddress,
										onChange: (event) => patch({ bindAddress: event.target.value }),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "127.0.0.1",
											children: "仅本机 127.0.0.1（推荐）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "0.0.0.0",
											children: "所有网卡 0.0.0.0（局域网可访问）"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hint",
										children: "上游默认监听 0.0.0.0，会把网关和平台 token 暴露给整个局域网。插件默认只监听本机。"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "fg-check",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: value.autoStart,
									onChange: (event) => patch({ autoStart: event.target.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["随 DSH 启动时自动启动后台服务", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "fg-hint",
									children: "关闭后，DSH 启动不会拉起服务，需要在这里手动点「启动」。"
								})] })]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "下载来源",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "fg-mirror",
										children: "镜像地址前缀"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "fg-mirror",
										className: "fg-input fg-mono",
										placeholder: "https://mirror.example.com/miloco",
										value: value.mirrorBase ?? "",
										onChange: (event) => patch({ mirrorBase: event.target.value === "" ? null : event.target.value })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hint",
										children: "GitHub Releases 不可达时按此地址取同名文件（<前缀>/<文件名>）。必须是 https。"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "fg-local",
										children: "本地安装包绝对路径"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "fg-local",
										className: "fg-input fg-mono",
										placeholder: "/Users/you/Downloads/miloco-mcp-server-mac-arm64-v1.2.20.zip",
										value: value.localArchive ?? "",
										onChange: (event) => patch({ localArchive: event.target.value === "" ? null : event.target.value })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hint",
										children: "最后兜底的来源。请优先使用「服务」页的指定版本安装，避免手填路径。"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "fg-check",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: value.allowUnverified,
									onChange: (event) => patch({ allowUnverified: event.target.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["允许安装没有校验值的版本", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "fg-hint",
									children: "默认拒绝。上游个别资产没有发布 .sha256，开启后这类包将不做完整性校验。"
								})] })]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						title: "插件",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: "fg-facade-port",
										children: "MCP 门面端口"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "fg-facade-port",
										className: "fg-input fg-mono",
										type: "number",
										min: 1024,
										max: 65535,
										value: value.facadePort,
										onChange: (event) => patch({ facadePort: Number.parseInt(event.target.value, 10) || 0 })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "fg-hint",
										children: [
											"官方 MCP 桥连的是这个端口。它写在本机 state.json 里，MCP 桥在 DSH 启动时读取，因此",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "改动需要重启 DSH" }),
											"。"
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
								className: "fg-grid",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "安装目录" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "fg-mono",
											children: settings.data?.root ?? "—"
										}),
										" ",
										settings.data === null || settings.data === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Copy, { value: settings.data.root })
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "插件版本" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
										className: "fg-mono",
										children: boot().pluginVersion ?? "—"
									})
								]
							}),
							launcher === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "fg-hint",
									style: { marginTop: 8 },
									children: "插件没有自更新接口：宿主在启动时读取包的版本，运行期间无法热替换。升级请执行下面的命令，然后重启 DSH。"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: "fg-code",
									children: launcher.upgradeCommand
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "fg-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Copy, {
										value: launcher.upgradeCommand,
										label: "复制升级命令"
									}), launcher.profileKnown ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "fg-hint",
										children: "未能识别当前 profile 名，请把 <你的 profile 名> 替换成实际值。"
									})]
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "primary",
							disabled: !dirty || action.busy !== null,
							onClick: () => action.run("settings", async () => {
								const result = await api("/settings", {
									method: "PUT",
									body: JSON.stringify({
										mirrorBase: value.mirrorBase,
										localArchive: value.localArchive,
										allowUnverified: value.allowUnverified,
										bindAddress: value.bindAddress,
										cloudServer: value.cloudServer,
										autoStart: value.autoStart,
										serverPort: value.serverPort,
										facadePort: value.facadePort
									})
								});
								setNote(result.note);
							}),
							children: "保存设置"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
							variant: "ghost",
							disabled: !dirty,
							onClick: () => setDraft(current),
							children: "放弃修改"
						})]
					})
				]
			});
		}
		function LogsPanel() {
			const [lines, setLines] = (0, react.useState)([]);
			const [paused, setPaused] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [source, setSource] = (0, react.useState)("all");
			const lastTs = (0, react.useRef)(0);
			const pausedRef = (0, react.useRef)(false);
			pausedRef.current = paused;
			(0, react.useEffect)(() => {
				let cancelled = false;
				const tick = async () => {
					if (document.hidden || pausedRef.current) return;
					try {
						const fresh = await api(`/logs?since=${lastTs.current}&limit=400`);
						if (cancelled || fresh.length === 0) return;
						lastTs.current = fresh[fresh.length - 1].ts;
						setLines((previous) => [...previous, ...fresh].slice(-1500));
						setError(null);
					} catch (cause) {
						if (!cancelled) setError(cause.message);
					}
				};
				tick();
				const timer = window.setInterval(() => void tick(), 2e3);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, []);
			const shown = (0, react.useMemo)(() => source === "all" ? lines : lines.filter((line) => line.source === source), [lines, source]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
					raw: error,
					conclusion: "读取日志失败"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
					title: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["运行日志", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "fg-hint",
						style: { fontWeight: 400 },
						children: "（插件与后台服务合并在一处，便于看因果顺序）"
					})] }),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fg-actions",
						style: { marginTop: 0 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "fg-input",
								style: { width: "auto" },
								value: source,
								onChange: (event) => setSource(event.target.value),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "all",
										children: "全部"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "plugin",
										children: "仅插件"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "server",
										children: "仅后台服务"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
								onClick: () => setPaused((value) => !value),
								children: paused ? "继续刷新" : "暂停刷新"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
								variant: "ghost",
								onClick: () => {
									setLines([]);
									lastTs.current = Date.now();
								},
								children: "清空视图"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Copy, {
								value: shown.map((line) => `${new Date(line.ts).toISOString()} [${line.source}] ${line.level}: ${line.text}`).join("\n"),
								label: "复制全部"
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-logs",
						style: { marginTop: 8 },
						children: shown.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "fg-empty",
							children: "暂无日志。"
						}) : shown.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: `fg-log-line${line.level === "error" ? " fg-log-error" : line.level === "warn" ? " fg-log-warn" : ""}`,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "fg-log-ts",
									children: new Date(line.ts).toLocaleTimeString()
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: line.source === "server" ? "服务" : "插件" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: line.text })
							]
						}, `${line.ts}-${index}`))
					})]
				})]
			});
		}
		function FeyagateSettings() {
			const [tab, setTab] = (0, react.useState)("service");
			const status = usePoll("/status", 2500);
			const reload = status.reload;
			const current = status.data;
			if (current === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "fg-root",
				children: status.error === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "fg-empty",
					children: "正在读取后台服务状态…"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
					raw: status.error,
					conclusion: "无法连接 DSH 宿主"
				})
			});
			const view = stateView(current);
			const primary = (() => {
				if (current.state === "not-installed") return {
					label: "安装后台服务",
					onClick: () => {
						setTab("service");
						post("/install", {}).then(reload).catch(() => reload());
					}
				};
				if (current.healthy) return {
					label: "查看日志",
					onClick: () => setTab("logs")
				};
				if (current.state === "stopped" || current.state === "error" || current.state === "degraded") return {
					label: "启动",
					onClick: () => {
						post("/service/start").then(reload).catch(() => reload());
					}
				};
				return null;
			})();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fg-root",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-card",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fg-hero",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "fg-hero-main",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: `fg-hero-state ${TONE_CLASS[view.tone]}`,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												children: view.icon
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: view.word }),
											current.currentVersion === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "fg-tag",
												children: ["v", current.currentVersion]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hero-detail",
										children: current.detail ?? `后台服务正在监听 127.0.0.1:${current.effectivePort ?? current.port}`
									}),
									current.circuitOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "fg-hero-detail fg-state-bad",
										children: "已停止自动重启。修复原因后点「重启」或「回滚上一版本」可立即恢复。"
									}) : null
								]
							}), primary === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Btn, {
								variant: "primary",
								onClick: primary.onClick,
								children: primary.label
							})]
						})
					}),
					status.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorCard, {
						raw: status.error,
						conclusion: "状态刷新失败"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "fg-tabs",
						role: "tablist",
						children: TABS.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							role: "tab",
							className: "fg-tab",
							"aria-selected": tab === entry.id,
							onClick: () => setTab(entry.id),
							children: entry.label
						}, entry.id))
					}),
					tab === "service" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServicePanel, {
						status: current,
						reload
					}) : null,
					tab === "license" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LicensePanel, {
						status: current,
						reload
					}) : null,
					tab === "accounts" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountsPanel, { status: current }) : null,
					tab === "login" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LoginPanel, {
						status: current,
						reload
					}) : null,
					tab === "settings" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPanel, {
						status: current,
						reload
					}) : null,
					tab === "logs" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LogsPanel, {}) : null
				]
			});
		}
		const inject = ["slots"];
		function apply(ctx) {
			insertStyles();
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "feyagate",
				order: 30,
				label: () => "飞阳网关"
			}, FeyagateSettings));
			ctx.logger?.info("[dsh-feyagate-gateway] 设置页已注册");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map