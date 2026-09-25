# MCP 桥工具列表不可用 —— 根因分析与修复方案

> 状态：需求分析（t1） · 2025-09
> 涉及文件：`src/mcp/facade.ts`、`src/runtime.ts`、`src/supervise/process.ts`、`src/install.ts`、`cordis.patch.yml`
> 外部依赖：`@deepseek-ai/dsh-mcp-client`（桥）、`@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`

## 0. 结论速览

- **直接原因**：facade 的 `notifyToolsChanged()` 只在子进程健康的「上升沿」触发一次；如果那一刻 MCP 桥的 SSE GET 流还没建立（或流数已清零），`notifications/tools/list_changed` 就**丢失且永不补发**，桥侧永远停留在启动时同步到的空工具表，直到 DSH 重启。
- **为什么桥没有自动救回**：`StreamableHTTPClientTransport` 只在 `connect()` 时打开一次 GET SSE 流，之后**不会重开**；而「桥连上」与「子进程健康」是两个**完全独立**的时序，两者交错过后没有任何一方会再主动碰对方。
- **推荐修复**：**方案 A（补发）+ 方案 B（按需兜底）组合**：
  1. `openStream()` 在流建立时，若子进程已健康立即补发一次 `list_changed`（修复「桥晚连」时序）；
  2. `notifyToolsChanged()` 投递数为 0 时置 `listChangedPending` 标志，任意新流建立或下次健康边沿时重放（修复「healthy 边沿早于所有流」时序）；
  3. facade 在「桥曾连过但子进程未健康」时做有界周期性重发（约 5s/次，上限 10 次，仅在有活跃流时发送，零额外开销兜底）；
  4. 保持 `childPort` 只读 `state.json` 的 `effectivePort`（现状即正确，见 §3.3），`cordis.patch.yml` **不需要改**。
- **验收**：新装（先装插件后装服务）与已装（服务先于 DSH 运行、桥接管后健康）两种时序下，桥无需重启 DSH 即可拿到非空工具列表。

---

## 1. 精确故障时序

### 场景 A：「装完不重启」——DSH 先启动，服务后安装

```
DSH boot                      插件 apply()                     安装 job (用户点按钮)
────────────────────────────  ──────────────────────────────  ──────────────────────────────
plugin row: apply()          await runtime.startFacade()
  ├─ facade.start()          facade 绑定 38081
  │   └─ state.patch(        state.json: facade.port=38081
  │        facade:{port})
  └─ resolve()               [不 await] void startService()
       → autoStart 但 not-installed
         → supervisor.ensureStarted()
           → activeVersion()=null
           → 返回 not-installed（不 spawn）
bridge row: apply()          （loader 在此之后才求值下一行）
  └─ startConnection()
       ├─ StreamableHTTPClientTransport.connect(url=…38081/mcp)
       │    ├─ POST initialize        → facade 秒答（capabilities.tools.listChanged=true）
       │    ├─ POST tools/list        → 子进程未装 → 本地答 { tools: [] }   ★ 桥注册 0 个工具
       │    └─ GET  (Accept: text/event-stream)
       │         → facade.openStream() → streams = {S1}，写 ': connected'
       └─ 同步完成，桥就绪（空表）
                                   用户在设置面板点「安装后台服务」
                                   下载 → 校验 → 解压 → setCurrentVersion
                                   supervisor.ensureStarted() → spawnChild(v)
                                     ├─ 端口漂移 → state.effectivePort=38083
                                     ├─ waitForHealthy(38083)：40×500ms，最长 ~20s
                                     ├─ 健康 → confirmHealthy(v)
                                     └─ onChange()
                                          → afterSupervisorChange()
                                             → healthy()=true, lastHealthy=false→true
                                             → facade.notifyToolsChanged()
                                                streams={S1} → 理论上送达
```

> 本场景的**理论路径**是通的（桥的 SSE 流 S1 自 boot 起一直开着）。
> 但注意 `afterSupervisorChange` 的触发依赖 `supervisor.onChange()` 的边沿——
> **安装 job 内 `ensureStarted()` 成功路径只调一次 `onChange`**，且它发生在
> `startService()` 的 `await` 链里；若该边沿发生在「SSE 流恰好在重连中/尚未建立」的窗口，
> 或（场景 B）流从未建立，`list_changed` 就丢了。真正的硬失败在场景 B。

### 场景 B：「桥晚连」——服务已健康，桥的 GET 流晚于 healthy 边沿

这是**必然复现**的主故障（对应 team goal 的 "or 桥的 GET 流晚于 healthy 边沿"）：

```
时刻   事件
────   ─────────────────────────────────────────────────────────────────────────
T0     DSH boot → plugin apply() → facade.start()（38081）
       state.json 已有 server.effectivePort=38083（上次 DSH 会话留下的服务还在跑，
       或本次 autoStart 已把它拉起并 confirmHealthy）
       [不 await] startService() → ensureStarted() → probeHealth(38083)=true
         → adopt/spawn → confirmHealthy → onChange() → afterSupervisorChange()
            → healthy()=true, lastHealthy=false→true
            → facade.notifyToolsChanged()
               此时 streams = ∅（桥还没走到 connect）   ★★ list_changed 丢弃，无接收方 ★★
T1     bridge row 求值 → StreamableHTTPClientTransport.connect()
         ├─ POST initialize   → 秒答
         ├─ POST tools/list   → facade: childPort()=38083 → 代理子进程 → 非空工具表
         │     （若此刻子进程已健康：桥其实能拿到工具——此路通）
         └─ GET SSE           → openStream() → streams={S2}
                                但没有任何东西告诉 S2「列表已经变了」——
                                不需要，因为 T1 的 tools/list 已经代理到真实子进程了
```

> 修正：场景 B 中若 **T1 的 `tools/list` 恰好代理到已健康子进程**，桥其实能拿到非空表。
> **真正的硬失败**是下面的场景 C。

### 场景 C：「桥连上空表 + healthy 边沿在桥流建立之前」（team goal 所述的核心故障）

关键前提：**桥的 SSE GET 流建立时刻 > 子进程 healthy 边沿时刻**，且两者都发生在
「桥的初始 `tools/list` 拿到空表」**之后**。这发生在：

```
T0  DSH boot → facade.start()（38081）
    子进程此刻未运行（首次安装/服务未启动）
    [不 await] startService() → ensureStarted()：
        - 未装 → not-installed（场景 A 前置），或
        - 已装但 autoStart 慢 / 健康检查尚未通过
T1  bridge 求值 → connect()
      ├─ POST initialize        → 秒答
      ├─ POST tools/list        → 子进程未健康 → 本地 { tools: [] }  ★★ 空表已注册 ★★
      └─ GET SSE → openStream() → streams={S1}（此刻子进程仍不健康）
T2  子进程终于 /health 通过 → confirmHealthy → onChange → afterSupervisorChange()
      → healthy()=true, lastHealthy=false→true
      → facade.notifyToolsChanged() → streams={S1} → 应送达
```

T2 在**理想实现**下会送达 S1。**但 team goal 报告它不可靠**，根源在两个实现细节
（见 §2 根因）使「送达」并非幂等、且存在一个**流为空**的窗口：

- 若 T1 的 SSE 流在 T2 之前因任何原因（网络抖动、DSH 宿主对该连接的 GC、
  `openStream` 尚未把 res 加入 `streams` 的竞态）未登记，则 `notifyToolsChanged`
  的 `streams` 为空 → `delivered=0` → **无人重放** → 桥永远空表。
- 桥侧 `StreamableHTTPClientTransport` 在 connect 之后**不再重开 GET 流**，
  也**不主动重发 tools/list**；它只被动等 `list_changed` 通知来触发 re-sync。
  于是「错过一次 `list_changed`」=「本会话内永久空表」。

**一句话根因**：facade 把「工具列表变化」建模成**一次性、无状态的 fire-and-forget
通知**（`notifyToolsChanged` 不记录「谁应该收到」），而接收端（桥）把这个通知
当作**唯一**的列表刷新通道且**不可重放**；两端都没有「状态对账」机制，
于是只要 healthy 边沿与桥流的建立**错过**，就永久失配。

---

## 2. 根因定位（文件 + 行）

### 2.1 `src/mcp/facade.ts` —— 通知是 fire-and-forget、无补发

| 位置 | 现状 | 问题 |
|---|---|---|
| `notifyToolsChanged()`（L233–245） | 遍历 `this.streams` 写入 `list_changed`；`delivered` 仅用于日志 | **无 pending 状态**：若 `streams` 为空，通知被丢弃且**永不重放**；若某条流写入失败，也只是 `delete`，不补发 |
| `openStream()`（L356–375） | 建流、写 `: connected`、加入 `streams`、注册 close 清理 | **不检查子进程是否已健康**：流建立时若子进程早已健康，不会主动补发一次 `list_changed`（也不重新 `tools/list`）——晚到的流拿不到「列表已经变了」的事实 |
| `handle()` 的 `tools/list` 分支（L115–118 `localAnswer`） | 子进程未健康时本地答 `{ tools: [] }` | 空表是**合法 MCP 应答**、不烧重试预算，但**不携带「稍后会变」的提示**；桥侧无从知道该等 |
| `childPort` 调用点（L278、L322） | 每请求读 `this.childPort()` | 本身正确（每请求读最新 effectivePort），见 §3.3 |

**核心缺陷**：facade 只把「变化」当瞬时事件，从不保存「当前应有的列表状态」供晚到者查询/重放。

### 2.2 `src/runtime.ts` —— 边沿只在 supervisor 回调里发一次

| 位置 | 现状 | 问题 |
|---|---|---|
| `afterSupervisorChange()`（L120–129） | 等 `supervisor.healthy()`，在 `healthy && !lastHealthy` 边沿调一次 `facade.notifyToolsChanged()` | **只依赖 supervisor 的 `onChange()` 触发**；`lastHealthy` 一旦置 true 就**不重发**，直到再次掉到不健康。若该唯一一次边沿落在「无桥流」窗口，就丢了 |
| `startService()`（L160–172） | `ensureStarted()` 成功后调一次 `afterSupervisorChange()` | 与 supervisor 内部 `onChange()`（spawn 成功、adopt、watchdog 重启、stop、dispose 等多处）叠加，**边沿来源分散且无统一「对账」点**；没有「流建立时主动对账」的路径 |
| `facade` 构造（L88–95） | `childPort: () => this.state.get().server.effectivePort` | 读 `state.json` 的 `effectivePort`，**正确**（见 §3.3）；但 `effectivePort` 仅在 `spawnChild`/`tryAdopt` 成功写、`stop()` 置 null |

**核心缺陷**：触发源（supervisor 边沿）与消费端（桥流）的**生命周期解耦**，且没有任何「消费端就绪时主动对账」的钩子。

### 2.3 `src/supervise/process.ts` —— 健康边沿的源头

- `spawnChild()` L345：`confirmHealthy` 后 `this.onChange()`（**一次**）。
- `tryAdopt()` L233：接管后 `this.onChange()`（**一次**）。
- `handleExit()` L394/405/429/441、`stop()` L522、`dispose()` L543：多次 `onChange()`，含「停止/崩溃」的不健康边沿。
- 健康判定唯一来源：`healthy()` L547–550 → `probeHealth(effectivePort)`。

`onChange()` 被 `runtime.afterSupervisorChange` 订阅，是唯一的「变化」信号总线。**问题不在它发太多，而在它发的唯一一次「变健康」边沿可能落空**（无流可投）。

### 2.4 `cordis.patch.yml` —— `url` 表达式（**不是根因，澄清**）

- L65–80：`url` 是 `!!js` 表达式，boot 时从 `state.json` 读 `facade.port`（默认 38081），拼 `http://127.0.0.1:<port>/mcp`。
- 它读的是 **`facade.port`（门面端口）**，不是子进程的 `effectivePort`。这是**正确设计**：桥永远指向门面，门面再按每请求 `childPort()` 代理到子进程。
- **结论**：`cordis.patch.yml` 的 url 表达式**不是本故障根因**，无需改。team goal 里「cordis.patch.yml 的 url 表达式」作为嫌疑项在此**排除**：它只决定「桥连到门面的哪个端口」，而门面端口在 `apply()` 前已写定、稳定可读。

> 澄清 team goal 的措辞：「保证 childPort 读到 effectivePort 时子进程健康」——`childPort` 读到的是 `state.json` 的 `server.effectivePort`，该字段由 supervisor 在 `spawnChild`（L265）/`tryAdopt`（L230）成功时写入、`stop()`（L520）置 null。**现状已满足「读到 effectivePort 时子进程健康」**（写入发生在 `waitForHealthy`/`probeHealth` 通过之后）。真正缺的是「桥流建立时对账」，不是端口读取。

---

## 3. 候选修复方案

### 方案 A：`openStream` 时若子进程已健康，立即补发 `list_changed`（推荐核心）

**改动**：`src/mcp/facade.ts`
- 给 `McpFacade` 增加一个注入的 `isChildHealthy(): Promise<boolean>`（或复用 `childPort() != null` 的近似），由 `runtime` 传 `supervisor.healthy`。
- `openStream()` 在把 res 加入 `streams` 之后，若子进程已健康，立即 `this.notifyToolsChanged()`（或只向这条新流发一次）。

**优点**：
- 直接覆盖「桥晚连」：无论 healthy 边沿何时发生，只要桥流**建立时**子进程已健康，立刻补发，桥 re-sync 拿到真实表。
- 改动集中在 facade 一处，不碰 supervisor/桥/patch.yml。
- 幂等：桥收到 `list_changed` 会 re-sync，重复无害。

**缺点/边界**：
- 只覆盖「流建立时已健康」。若「流建立时不健康 → 之后变健康」，仍依赖 `notifyToolsChanged` 那一刻流在集合里（即回到场景 C 的竞态）。需配合方案 B 的 pending 标志彻底闭合。
- `openStream` 是同步函数，需改成可 `await` 健康探测或异步 fire；注意 `streams.add` 后再异步发，避免竞态。

**改动范围**：`facade.ts`（+`openStream`、构造注入）；`runtime.ts`（构造 facade 时传 `isChildHealthy`）。

### 方案 B：`listChangedPending` 标志 + 有界周期性重发（推荐兜底）

**改动**：`src/mcp/facade.ts`
- 新增字段 `listChangedPending = false`。
- `notifyToolsChanged()`：若 `delivered === 0`（无任何流），置 `listChangedPending = true` 并启动一个有界定时器（如每 5s 重试一次 `notifyToolsChanged`，上限 ~10 次 / 50s），一旦投递成功或子进程变不健康则清标志、停定时器。
- `openStream()`：若 `listChangedPending`，立即重放一次。

**优点**：
- 彻底闭合「healthy 边沿落空」竞态：即使某一刻无流，只要后续任一时刻有流建立（方案 A/B 的 `openStream` 钩子）或有下一次健康边沿，都会补发。
- 不依赖桥侧行为，是 facade 自治的「最终一致」。
- 有界、自停，不造成长期噪音。

**缺点/边界**：
- 引入一个定时器，需管理生命周期（`stop()` 时清理，避免 dangling）。
- 若桥流长期不建立（桥根本没连），定时器到上限即停——正确行为（没人要收）。

**改动范围**：`facade.ts`（新增字段 + 定时器 + 清理）。

### 方案 C：facade 周期性全量重发 `list_changed`（无状态兜底，可选）

**改动**：`src/mcp/facade.ts`
- 在 `start()` 里加一个周期（如 30s）的 `setInterval`：若子进程健康 **且** `streams.size > 0`，就发一次 `list_changed`；若子进程不健康且曾有流，跳过。

**优点**：
- 最鲁棒：无论边沿何时丢，只要桥流在、子进程健康，最多 30s 后桥必 re-sync。
- 实现最简单（无 pending 状态）。

**缺点/边界**：
- 对已正常拿到工具的桥也会周期重发 `list_changed` → 桥每 30s 做一次无谓 re-sync（`tools/list` 全量拉取），有轻微开销、且可能让「稳定工具集」显得在抖动。
- 属于「蛮力兜底」，宜作为 A+B 之外的**最后保险**，不宜单独使用。

**改动范围**：`facade.ts`（`start()` 加定时器）。

### 方案 D：改 `cordis.patch.yml` 的 url 读 effectivePort + 健康边沿触发（**不推荐**）

**设想**：把桥直接指向子进程 `effectivePort`，并在健康边沿让桥重连。

**为什么不推荐**：
- **倒退**：现有设计刻意让桥指向**门面**而非子进程，正是为了 (a) 端口可漂移/运行时变、(b) 子进程未装时不烧桥的重连预算、(c) 升级窗口对模型零感知（见 facade.ts 头部注释与 README「三条要点」）。改成直指子进程会把这三项好处全部丢掉。
- **桥不会因 url 变化自动重连**：`StreamableHTTPClientTransport` 的 url 在 boot 时固定，DSH 运行期不会重新求值 `cordis.patch.yml`；要「健康边沿触发桥重连」需要桥侧或宿主支持动态 url，超出本插件可控范围。
- 治标不治本：即使桥直指子进程，「子进程未装时桥拿不到任何应答」的问题依旧，且会烧光桥的重连预算后**永久卸载工具**（facade 头部注释明确测量的 10 次/2.5min 预算）。

**改动范围**：`cordis.patch.yml`（url 表达式）；但收益为负。

**结论**：排除 D，采用 **A + B**（并可选加 C 作最终保险）。

---

## 4. 推荐方案与理由

**推荐：方案 A（openStream 补发）+ 方案 B（pending 标志 + 有界重发），可选叠加方案 C（周期兜底）。**

理由：

1. **对症**：本故障本质是「一次性通知 vs 不可重放消费端」的状态失配。A 解决「消费端晚到」，B 解决「通知发出时消费端缺席」，两者合起来让 facade 从「发一次」升级为「**最终送达**」——这正是 team goal 要的「让工具列表变化可靠送达」。
2. **改动最小、风险可控**：只动 `facade.ts` 与 `runtime.ts` 的构造注入，不碰 `supervisor`、`cordis.patch.yml`、桥（`dsh-mcp-client`）或 SDK。不破坏「桥指向门面」这一既有架构决定（README 三条要点、ADR-0001 的结论保持）。
3. **幂等安全**：`list_changed` 是通知，桥收到即 re-sync；重复发送无害（桥侧 `syncTools` 有 `syncChain` 串行化，见 dsh-mcp-client `lib/index.js` L369–377、L451–459）。
4. **不依赖桥侧行为变化**：桥是外部包（`@deepseek-ai/dsh-mcp-client`），其 `StreamableHTTPClientTransport` 只在 connect 时开 GET 流、只被动等 `list_changed`，我们**无法也不需要**改它；facade 侧自治补发是可控解。
5. **方案 C 作为可选保险**：若实测 A+B 仍偶发落空（如 SSE 流在重连间隙），再加 C 的 30s 周期兜底，代价是轻微 re-sync 开销。建议先上 A+B，观察后再决定 C。

**不推荐方案 D**（见 §3 方案 D）：它倒退架构、且无法在运行期触发桥重连。

---

## 5. 验证思路

目标：复现并验证两种时序下「桥无需重启 DSH 即可拿到非空工具列表」。

### 5.1 复现「装完不重启」（场景 A / C：先 DSH 后装服务）

1. 用干净 `DSH_HOME`（或 `DSH_FEYAGATE_HOME` 指向临时目录）启动 DSH，确认设置面板出现「飞阳网关」，`state.json` 有 `facade.port`、`server.effectivePort` 为 null。
2. 在对话里先问一次「列出我的智能家居设备」→ 预期：工具为 0（桥拿到空表，**但不应报连接失败**——门面已秒答 initialize）。
3. 打开 **设置 › 飞阳网关 › 服务**，点「安装后台服务」，等下载/校验/解压/启动走完（`waitForHealthy` 最长 ~20s）。
4. 安装完成后**不重启 DSH**，再次问「列出我的智能家居设备」→ **验收点：能调用到 `mcp__feyagate__*` 工具且返回非空**（即 `list_changed` 已送达、桥已 re-sync）。
5. 若失败，看 `facade` 日志是否打印 `已通知工具列表变化（N 个客户端流）`：
   - `N=0` → 复现了「healthy 边沿落空」，需方案 B 补发；
   - 无该行 → `afterSupervisorChange` 未触发边沿（检查 supervisor `onChange` 链路）。

### 5.2 复现「桥晚连」（场景 B/C：服务已健康，桥流晚于 healthy 边沿）

1. 在已安装、`autoStart=true` 的环境，**先让服务独立运行**：手动 `spawn` 出 `miloco-mcp-server`（或让上一次 DSH 会话留下子进程 + pid 文件），确认 `127.0.0.1:<effectivePort>/health` 返回 `{"status":"ok"}`。
2. 再启动 DSH。facade 起来后，`startService()` 会 `tryAdopt`/`ensureStarted` → `probeHealth` 命中 → 立即 `confirmHealthy` → `afterSupervisorChange` 在 **bridge row 求值之前** 就触发了一次 `notifyToolsChanged`（此时 `streams=∅` → 落空）。
3. 随后桥才 `connect()`：
   - 若 `openStream` 已按方案 A 实现 → 桥流建立时检测到子进程健康 → **立即补发** `list_changed` → 桥 re-sync 拿到非空表。
   - **验收点：不重启 DSH，对话里调用 `mcp__feyagate__*` 成功且非空**。
4. 反向确认修复前：在**未加方案 A** 的构建上重复 2–3，预期桥停在空表、`tools/list` 虽代理到子进程返回非空但桥不 re-sync（因为 `tools/list` 的 re-sync 只由 `list_changed` 通知触发，而初始同步已完成）→ 证明「桥晚连」确会卡死空表。

### 5.3 单元/集成断言（实现后）

- facade：`openStream` 后子进程健康 ⇒ 断言 `notifyToolsChanged` 被调用一次且 `delivered≥1`；子进程不健康 ⇒ 不补发。
- facade：`streams=∅` 时 `notifyToolsChanged` ⇒ `listChangedPending=true`；随后 `openStream` ⇒ 自动重放且 pending 清零。
- 端到端：用 `tests/test_mcp_proxy.py` 风格的 SSE 探针，断言「先 GET 流、后健康」与「先健康、后 GET 流」两种顺序，桥侧最终都收到 `tools/list_changed` 并 re-sync 到非空。

### 5.4 回归

- 升级/回滚（`install.ts` 的 stop→swap→start）期间工具短暂消失后恢复：每次 `confirmHealthy` 都走同一补发路径。
- 子进程崩溃→watchdog 重启→再健康：`lastHealthy` 边沿 + pending 逻辑保证每次恢复都补发。
- `stop()`/`dispose()`：补发定时器随 facade 清理，无 dangling；桥侧收到连接关闭走其自身 reconnect。

---

## 6. 落地清单（供实现阶段 t2 使用）

1. `facade.ts`：
   - 构造新增 `isChildHealthy?: () => Promise<boolean>`；`notifyToolsChanged` 增加 `delivered` 可见性（内部）。
   - `openStream()`：`streams.add` 后，若 `await isChildHealthy()` 为真 → `notifyToolsChanged()`；若 `listChangedPending` 为真 → 立即重放并清零。
   - 新增 `listChangedPending` + 有界重发定时器（方案 B）；`start()`/`stop()` 管理其生命周期。
   - （可选 C）`start()` 加 30s 周期兜底定时器。
2. `runtime.ts`：构造 `McpFacade` 时传入 `isChildHealthy: () => this.supervisor?.healthy() ?? Promise.resolve(false)`。
3. 不改 `cordis.patch.yml`、不改 `supervisor`、不改桥/SDK。
4. 验证按 §5；更新 README「三条要点」与 ADR-0001 补一句「list_changed 为最终送达（openStream 补发 + pending 重放）」。
