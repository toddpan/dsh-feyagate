# ADR-0004：二进制升级 = 权威清单 + 多源降级 + `versions/` 不可变 + `pending` 回滚

> **这个文件解决什么问题**：回答"怎么保证下载到的是对的文件、下载不到时怎么办、装到一半断电会怎样"这三件事。

- **Status**：Accepted（清单与清单生成器已落地）
- **Date**：2026-09-25
- **相关**：[ADR-0001](0001-mcp-integration.md)（升级窗口对模型零感知）、[`manifest/server-manifest.json`](../../manifest/server-manifest.json)、[`scripts/gen-manifest.mjs`](../../scripts/gen-manifest.mjs)

---

## Context

上游 `miloco-mcp-server` 的产物发布在两个渠道：

| 渠道 | 内容 | 实测问题 |
|---|---|---|
| GitHub Releases `toddpan/miloco-mcp-server-releases` | 逐平台压缩包 + 部分资产的 `.sha256` sidecar | **资产命名逐版本漂移**；部分版本缺平台 |
| FOTA `oneapi.sooncore.com/ota/fota.json` | `feyagate-skill-*` 三条，带 url + **md5** | **缺 mac-arm64 与 linux-arm64**；各平台版本错位（1.2.19 / 1.2.20 / 1.2.17） |

命名漂移的实测样本（同一仓库、同一年）：

| 版本 | 平台 | 真实资产名 |
|---|---|---|
| v1.2.20 | mac-arm64 | `miloco-mcp-server-mac-arm64-v1.2.20.zip` ← 规范形态 |
| v1.2.20 | mac-x64 | `miloco-mcp-server-mac-x64-v1.2.20.tar.gz` ← **完全没有 zip** |
| v1.2.20 | win-x64 | —— ← **这个版本没有任何 Windows 资产** |
| v1.2.19 | win-x64 | `miloco-mcp-server-1.2.19-windows-x64.zip` ← 版本号在前、写 `windows` |
| v1.2.19 | win-x64 | `miloco-mcp-server.exe` ← 还有一个**裸可执行文件** |
| v1.2.17 | linux-arm64 | `miloco-mcp-server-linux-arm64-v1.2.17.tar.gz` ← linux-arm64 **停在 1.2.17** |

结论：**"版本 + 平台 → 拼文件名"必然失败**。同时子进程没有 `--version`/`--validate`，`/health` 也不含版本，所以"装了什么版本"只能由安装方自己记账。

## Decision

四件事组合成一条升级链路。

### 1. 权威清单 `manifest/server-manifest.json`

清单记录**真实存在过的资产**，而不是命名模板：每个平台每个版本一组 `{file, kind, size, url, sha256}`（无 sidecar 时为 `null`），另加：

- `pluginCompat.minSupportedServer`（`1.2.17`：低于它拒绝运行）/ `maxTestedServer`（`1.2.20`：高于它提示"未测试"）；
- `channel.stable`：**逐平台**的默认目标版本（`mac-arm64/mac-x64/linux-x64` → `1.2.20`，`linux-arm64` → `1.2.17`，`win-x64` → `1.2.19`），因此不会去追一个该平台不存在的版本；
- `fotaType`：FOTA 里各平台对应的 `type` id（`mac-arm64` / `linux-arm64` 为 `null`，实测无条目）。

维护入口只有一条命令：

```bash
node scripts/gen-manifest.mjs                     # 全量重算
node scripts/gen-manifest.mjs --tag v1.2.20       # 单个 tag
node scripts/gen-manifest.mjs --compute-missing   # 给"无 sidecar"的默认目标补算 sha256
```

`--compute-missing` 的存在理由见下一条。

### 2. 多源降级 + 先校验后解压

按序尝试，前一个失败才走下一个，并记录 `attemptedSources[]` 供失败时展示：

```
① GitHub Releases（清单里的精确文件名 + sha256）
        ↓ 不可达 / 404 / 校验失败
② FOTA fota.json（url + md5；缺平台时跳过）
        ↓
③ 可配置镜像前缀（用户/环境变量给的前缀 + 同一个文件名）
        ↓
④ 本地包（离线安装：用户给一个本地压缩包路径）
```

**顺序不可交换的两步**：

1. 下载到 `cache/`；
2. **先校验，后解压** —— sha256 优先，FOTA 场景回退 md5。校验失败 → **删除已下载文件** → 中止（绝不"先解开再删"）。

**无校验值 = 必须用户显式确认**：清单里 `sha256: null` 的资产（没有 `.sha256` sidecar 且未被 `--compute-missing` 补过）不允许静默安装 —— 这是 `--compute-missing` 的意义：把"默认目标"这条路走通，更早的钉版本留在不可校验状态，因此不在 happy path 上。

### 3. `versions/<version>/` 不可变 + `current` 指针

```
~/.dsh/dsh-feyagate/
├── versions/
│   ├── 1.2.19/          ← 装过的旧版本原样保留（回滚 = 切指针，不重新下载）
│   └── 1.2.20/          ← 新版本装进新目录，从不覆盖旧目录
└── current              ← 一行版本号的**指针文件**（不是软链接：Windows 无特权建不了）
```

- 解压目标目录先清空；解压中断/失败 → 清掉整个 `versions/<ver>/`，回到"未安装"，**绝不留下半套二进制**。
- `current` 是文件而不是 symlink，为了 Windows 上不需要开发者模式/管理员权限。
- 指针是**兜底事实源**：激活时最后写它；启动时若指针与 `state.json` 的 `currentVersion` 不一致，**信指针**。

### 4. `pending` 握手 → 断电安全与自动回滚

```
装 vX：停服务 → 下载 → 校验 → 解压到 versions/vX/
      → state.markPending(vX)      ★ 落盘："我正要起一个还没证明过自己的版本"
      → 切 current → 拉起 → 轮询 /health（40 × 500ms）
           ├ 成功 → confirmHealthy(vX)：currentVersion=vX、lastKnownGood=被替换的旧版本、pending=null
           └ 失败 → 停进程 → 切回 lastKnownGood → 拉起旧版本 → 界面常驻橙条
下次 boot：若 pending != null（上次激活没走完 confirm）→ 不信任 current，直接回滚
```

（`markPending` / `confirmHealthy` 的接口在 [`src/state.ts`](../../src/state.ts)。）

配套的体验规则：失败后 **24 小时内不自动重试**（避免失败循环）；升级**失败禁止用 toast 承载**，必须留常驻痕迹直到用户处理。

## Consequences

**得到：**

- 上游再改一次命名，插件不需要发版就能正确安装（改清单即可）。
- Windows 与 linux-arm64 用户不会被"追一个不存在的版本"卡住。
- 断电阻断的窗口从"可能留下半套二进制"缩小到"多一次回滚"，且回滚是切指针级的秒级操作。
- 下载源不可达时，用户拿到的是"已试过 GitHub 与 FOTA，可换镜像或本地包"，而不是"网络错误"。

**付出：**

- 每次上游发版都需要维护者跑一次 `gen-manifest.mjs` 并提交 —— 这是**有意的**：清单是审计点，自动跟随上游等于放弃审计。
- 需要在磁盘上保留旧版本（每个 6–30 MB），回滚才能免下载；界面要提供"清理旧版本"。
- 无 sidecar 的资产需要用户显式确认才能装，多一次交互（但这是安全诉求的必然代价）。

**风险与缓解：**

| 风险 | 缓解 |
|---|---|
| 清单过期（上游发了新版，清单没更新） | 界面显示"最新可用版本来自本插件内置清单"，并给维护者入口；版本戳与清单不一致时提示重新生成 |
| 维护者手工改清单改错 | `scripts/verify-manifest.mjs`（CI 校验：URL 与文件名一致、`channel` 指向存在的资产、`pluginCompat` 区间合法）—— **该脚本待补** |
| 镜像被投毒 | 镜像走同一套 sha256 校验；校验不通过即删除中止 |

## Alternatives

### 运行时拼文件名（版本 + 平台）

- **否掉的原因**：实测必然失败（v1.2.20 无 Windows 资产；mac-x64 只有 tar.gz）。这是本 ADR 存在的直接起因。

### 只信 FOTA 的 `fota.json`

- **否掉的原因**：缺 mac-arm64 与 linux-arm64 条目，且各平台版本错位，不能作为权威版本源。**降级为兜底源**（它自带 md5，比什么都没有强）。

### 覆盖式升级（装到同一个目录，失败就重装）

- **否掉的原因**：无法回滚（旧版本已被覆盖），而且"重装"在断网时不可行。`versions/` 不可变的代价只是一点磁盘，换取的是**离线秒级回滚**。

### 用 `pending` 之外的校验方式（例如启动后 N 秒算健康）

- **否掉的原因**：不解决断电。断电发生在"切指针之后、健康确认之前"时，单靠运行期健康检查无法知道"上次到底确认了没有" —— 必须有落盘的 `pending` 标记。

### 用软链接做 `current`

- **否掉的原因**：Windows 上创建 symlink 需要特权/开发者模式。指针文件在所有平台行为一致。

## 待验证 / 待补

- `scripts/build.sh` 与 `scripts/verify-manifest.mjs` 尚未落地，而 `package.json` 已引用它们。
- FOTA 的 md5 校验只在"FOTA 作为下载源"时生效；此时清单里的 sha256 不可用（文件不同源），界面上要如实说明"本次安装使用 FOTA 的 md5 校验"。
