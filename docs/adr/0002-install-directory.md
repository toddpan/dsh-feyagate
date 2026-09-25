# ADR-0002：使用独立安装目录 `~/.dsh/dsh-feyagate`，不与 `~/.feyagate` 共享

> **这个文件解决什么问题**：回答"为什么不复用用户已经装好的 `~/.feyagate`"，并把三条真实的双份安装故障（端口互抢、身份漂移、token 互废）写成可检验的理由。

- **Status**：Accepted
- **Date**：2026-09-25
- **相关**：[ADR-0003](0003-generated-config.md)（生成物与字段归属）、[`docs/design.md` §6](../design.md)

---

## Context

这个仓库里已经有两套会把 `miloco-mcp-server` 装到本机的东西：

| 既存实现 | 安装位置 | 端口 | 凭据位置 |
|---|---|---|---|
| `app/feyagate-skill-gh`（Python CLI，PyPI `feyagate-skill`） | `~/.feyagate/{bin,lib,config,data,webui}` | `38080`（`config.yaml` 里可改） | `~/.feyagate/data/*_token.json`、`license.json` |
| `app/feyagate-desktop`（Electron） | `resources/server/`，运行期读 `config.runtime.yaml` | 默认 `38090`，占用时 `+1` 漂移 | 同目录下 `data/` |

而子进程本身有一个**不变式**（源码事实）：

- `src/main.cpp`：`license_mgr.set_data_dir(dirname(config_path)/data)`，`token_usage.json` 同样锚定 `dirname(config_path)/data`；
- `src/config.cpp` 的 `resolve_path()`：所有相对路径按 `config.yaml` 所在目录展开。

也就是说，**`config.yaml` 的位置决定了设备身份与许可证的归属**。把子进程的配置文件放到别处，等于给它一个新的 `device_id`。

## Decision

**插件用独立安装根目录 `~/.dsh/dsh-feyagate/`（`$DSH_HOME` 存在时为 `$DSH_HOME/dsh-feyagate/`），默认不与 `~/.feyagate` 共享任何文件；但对既存安装做只读探测，探测到就提供"attach：只连不管"的提示。**

具体规则：

1. **只读探测**（不写、不删、不改既存安装）：
   - 指针文件 `~/.config/feyagate/install_dir`（skill 安装器写的）；
   - `38080` / `38090` 上是否有 `/health` 应答，且应答者**不是**本插件拉起的进程（用 PID 与自己的 `state.json` 比对）。
2. 命中既存安装时，界面与文档的措辞是：**"检测到既有的 FeyaGate 后台服务（`~/.feyagate`）。本插件不会接管它；你可以继续用它，或者在本插件里另装一份。"** 并给出两个选项：只连（attach，不改二进制）或另装（推荐，独立目录）。
3. `config/` 与它旁边的 `data/` **永不迁移**：升级只新增 `versions/<ver>/`，从不移动配置与数据。
4. 安装根目录**不提供"改成别的目录"的设置项**（`PluginSettings` 里没有 `installRoot`）。这不是漏了：改目录 = 换一份 `device_id` = 授权与免费试用重新绑定，而"我从旧目录把凭据拷过去"又会造成同一授权码在两处漂移。要换位置只能整目录搬（`config.yaml` 与 `data/` 一起走），并且要明白设备身份是跟着目录走的。
5. 安装根目录内部：`config.yaml` **放在根目录本身**，`data/` 是它的兄弟（见 [ADR-0003](0003-generated-config.md) 的定案）。

## 为什么不是"复用 ~/.feyagate"：三条真实故障

### 故障一：端口互抢，表现为"服务起来了但工具连不上"

skill 与 desktop 都用 `38080` 系端口（desktop 默认 `38090` 并 `+1` 漂移）。若插件也复用 `~/.feyagate` 的配置并默认 `38080`：

- 用户先跑 `feyagate start`，再让插件启动服务 → 插件拉起的进程 `bind` 失败直接退出；
- 而 DSH 侧的门面仍然健康（它不依赖子进程），工具**会出现**，调用时才失败。
- 用户看到的现象是"工具在，但一用就报错"，而真正的原因在他看不见的地方（另一份安装占着端口）。

本插件的三条对策：独立目录、端口占用探测与漂移（默认起点 `38080`、范围 20 个端口）、以及健康检查失败时的**原因分类**（端口冲突 / 未签名 / 依赖缺失），不允许只说"启动失败"。

### 故障二：`device_id` 与授权漂移，表现为"我明明买过，怎么又变免费版了"

`license.json` 与 `device_id.txt` 锚定在 `dirname(config.yaml)/data`。任何"把配置写到别处"的实现都会：

- 生成新的随机 `device_id`；
- 让云端把设备视为**新设备** → 重新走免费试用（90 天）而不是已购授权；
- 对用户而言是"授权凭空消失"，且因为旧目录还在，看起来像插件把数据弄坏了。

因此本 ADR 的核心是那句不变式：**`config.yaml` 所在目录是身份，不是路径偏好。**

### 故障三：双份 token 互废，华为用户每个 bug 要多花一个验证码

同一账号在两份安装里各存一份凭据时：

- 小米 OAuth：两边各自 refresh，先刷的那个让另一个的短期令牌失效；
- 涂鸦扫码：两个独立 `user_code` 会话，登录状态来回覆盖；
- **华为（最严重）**：`silent_token` 换 `hms-lite/token` 用的 **silent code 是一次性的**（复用同一 code 会得到 `HTTP 400 {"error_code":400040001}`），且"长期会话保全"的判据是 `serviceToken + userId`。两套安装同时持有会话时，会互相把对方的 silent code 用掉，双方都走到"换取令牌失败"分支。
  按三端一致性要求，这个分支**不允许**显示成"验证失败"（真实事故：用户被要求"修改验证码后重试"，白费一个码），正确行为是落盘长期会话 + 回 `retry_without_code: true` + 自动用**新的** silent code 重试。但**双份安装**会让这个自愈逻辑反复互相打断。

**结论**：不是洁癖。双份安装不是"多占点磁盘"，是会**互相破坏对方的状态**。

## Consequences

**得到：**

- 插件的安装、升级、回滚、卸载完全自主，不会踩坏用户既有的 `~/.feyagate` 或 desktop 安装。
- `state.json`、`versions/`、`current` 指针的语义只服务一个消费者。
- 卸载清单明确：删 `~/.dsh/dsh-feyagate` 即可；既存安装原样保留。

**付出：**

- 用户可能因此在本机有**两份**二进制（磁盘 ~30–60 MB）。这是有意的：宁可多占磁盘，也不要身份漂移。
- 需要实现只读探测与 attach 提示，多一个状态分支。
- 用户想让两套共用账号时，需要明确地在两处分别登录（且不要同时用）。

**运维后果（写进 README）：**

- 卸载必须**先停服务**，再删目录（否则进程还在，端口还占着）。
- 卸载只删 `~/.dsh/dsh-feyagate`，不动 `~/.dsh/profiles/<profile>/`（那是 DSH 自己的）。

## Alternatives

### 复用 `~/.feyagate`

插件直接读 `~/.config/feyagate/install_dir` 指向的目录，复用其 `config.yaml` 与 `data/`。

- **否掉的原因**：三条故障都成立，且第一条（端口）会**在默认配置下**命中；第二、三条会破坏用户已有的授权与登录会话，属于不可接受的副作用。
- 部分保留：**只读探测**是这条思路里唯一安全的部分，已作为 attach 提示纳入决定。

### 复用 desktop 的 `resources/server/`

- **否掉的原因**：那是 Electron 应用私有目录，生命周期跟 App 安装绑定（重装 App 会丢），不适合作为"用户数据与许可证"的家。且它的端口默认 `38090` 并 `+1` 漂移，与插件的端口策略会互相打架。

### 装到 `~/.dsh/` 根下（不建子目录）

- **否掉的原因**：会与 DSH 自己的文件（`profiles/`、`cordis.patch.yml`、`credentials` 等）混在一起。独立子目录 `~/.dsh/dsh-feyagate/` 让"这个插件拥有什么"一眼可见，也便于卸载。

## 已定案：根目录内部的布局

本 ADR 最初留了一个未决项：`data/` 到底在哪。子进程把 `license.json` / `device_id.txt` / `token_usage.json` 锚定在 `dirname(config.yaml)/data`，而相对路径也一律按 `config.yaml` 所在目录展开 —— 所以"`config.yaml` 旁边"**就是**数据根。

**决定（已实现）**：`config.yaml` 放在安装根目录本身，`data/` 是它的兄弟。

```
~/.dsh/dsh-feyagate/
├── config.yaml     ← 子进程 --config 指向它；它的目录就是身份
├── data/           ← 凭据、license.json、device_id.txt、memory、skills
├── state.json
├── logs/server.log
├── versions/<version>/
├── cache/
└── current
```

三个候选里选它的理由：① 与 `src/paths.ts` 的声明一致；② 不需要任何字段级特例（另两个方案要么承认 `<root>/config/` 是锚点并改代码注释，要么写 `../data/...` 相对路径而**无法**覆盖三个硬编码路径）；③ `--config` 的路径短，排障时一眼能看出"身份目录"在哪。细节见 [ADR-0003](0003-generated-config.md)。
