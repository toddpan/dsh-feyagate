# ADR-0003：`config.yaml` 由插件生成、标记为生成物，字段归属明确

> **这个文件解决什么问题**：回答"`config.yaml` 到底谁说了算" —— 子进程会自己重写这个文件，插件也会写，必须有唯一写者与字段归属，否则两边配置打架。

- **Status**：Accepted
- **Date**：2026-09-25
- **相关**：[ADR-0002](0002-install-directory.md)、[`docs/design.md` §6](../design.md)

---

## Context

`miloco-mcp-server` 用 `--config <path>`（或 `-c`）读一个 YAML 配置。这个文件**不是纯输入**：子进程会在几种情况下把它**整文件重写**。源码事实（`src/config.cpp`）：

```cpp
// 三个"子进程会写回"的函数，形态完全一致：
YAML::Node root = YAML::LoadFile(config_path);   // 1. 读整棵树
root["vision"]["api_key"] = vision.api_key;      // 2. 只改自己的节点
std::ofstream out(config_path); out << root;     // 3. 整文件重写
```

- `save_xiaozhi_endpoint()` / `save_xiaozhi_endpoints()`：MCP 工具 `xiaozhi/add|remove|set_endpoint` 会调用；后者还把第一个端点同步写进 `xiaozhi.endpoint` 做向后兼容。
- `save_vision_config()`：`config/set_vision` 工具会调用。
- `save_trigger_config()`：`config/set_trigger` 工具会调用。

由此推出三条必须处理的事实：

1. **重写会丢注释与排版**（`out << root` 是 yaml-cpp 的序列化，不保留原文本）。文件的"人类可编辑性"只在子进程第一次回写之前存在。
2. **重写保留未知键**（它读的是整棵树，插件拥有的键会原样被再写回去）。
3. **两边同时写 = 最后写者胜**：插件也是"读整文件 → 改字段 → 写整文件"，没有任何锁。

配置项还不少（`config.yaml` 模板里有 `server` / `auth` / `camera` / `xiaozhi` / `license` / `tuya` / `midea` / `ewelink` / `vision` / `trigger` / `memory` / `skill` 共 12 组，另加华为组），其中一部分是"插件为了托管必须决定"的（http 端口、绑定地址、各 token 文件路径），另一部分是"用户业务配置"（Vision 的 API Key、触发规则阈值）。

## Decision

**插件是 `config.yaml` 的唯一写者，生成的文件带"生成物"标记；字段按三分类归属，子进程回写的字段读回合并、绝不覆盖。**

### 1. 生成物标记

生成的文件顶部写入三行注释头（说明它由插件生成、**手工修改会被下一次启动覆盖**、未被管理的键会被原样保留），并把文件权限设为 `0600`（用户配好 Vision 之后这里就有 API Key）。界面与文档都明确写：**不要手改** —— 子进程回写会把注释抹掉，两端同时改会打架。

> **诚实的边界**：注释头只在插件写文件时存在。子进程第一次 `save_*` 回写就把它抹掉了（yaml-cpp 的序列化不带注释）。所以"这是生成物"这件事主要靠**权限位 + 文档 + 界面文案**传达，不能靠文件里的注释当持久标记。

### 2. 字段归属

归属由代码里的两个名单决定，不是靠文档约定（[`src/config-gen.ts`](../../src/config-gen.ts)）：

| 名单 | 语义 | 字段 |
|---|---|---|
| `MANAGED_FIELDS` | **每次都覆盖**，反映插件当前意图 | `server.http_port`、`server.bind_address`、`server.webui_dir`、`server.ws_port`、`auth.token_file`、`tuya.token_file`、`midea.token_file`、`ewelink.token_file`、`huawei.token_file`、`memory.data_dir`、`skill.user_dir`、`skill.builtin_dir` |
| `SEED_ONLY_FIELDS` | **只在缺失时写入** —— 这是"升级不会把用户改过的值改回去"的关键 | `camera.*`（6 项）、`auth.cloud_server`、`xiaozhi.reconnect_interval_ms`、`vision.enabled`/`base_url`/`model`、`trigger.enabled`、`memory.enabled`、`skill.enabled` |
| 子进程拥有并回写 | 插件只读回显示 | `xiaozhi.endpoint`/`endpoints`、`vision.*` 其余键、`trigger.*` 其余键 |
| 插件直接写入、不在名单 | 路径必须相对根目录稳定 | `license.license_file`（`data/license.json`）、各 `*_token_file` 的值 |
| 完全不碰 | 子进程按自己的默认值处理 | `license.server_url`/`product`、`huawei.device_id`/`device_name`（**谁来写尚未核实**）、`xiaozhi.server_name`/`server_version` |

（完整表与默认值在 [`docs/design.md` §6](../design.md) —— 这里不复制。）

### 3. 写规则

- **子进程运行期间插件不改写 `config.yaml`。** 需要改端口/绑定地址时：停服务 → 读回 → 只替换目标字段 → 原子写（tmp + rename，见 [`src/util/atomic.ts`](../../src/util/atomic.ts)）→ 起服务。
- **不用模板整体覆盖**一个已经运行过的文件：那会抹掉用户的 `xiaozhi` / `vision` / `trigger` 配置。
- **子进程回写的字段以读到的值为准**：界面要显示小智端点、Vision 配置、触发规则开关时，先读文件再显示，**不"用插件的默认值纠正它"**。用户通过模型改的配置，插件无权回滚。
- **不认识的键原样保留**：包括来自更新版本、插件从没听说过的键 —— 这让我们可以先发插件、后发子进程新版本而不吃掉配置。
- **文件存在但解析不了 → 抛错**，提示"备份并删除它，插件会重新生成"，**不静默按默认值覆盖**（否则用户会从"服务起不来"变成"配置没了"）。
- **端口是单点例外**：`server.http_port` 在启动这一轮会被 `applyEffectivePort()` 改成真实绑定端口（期望端口留在 `state.json`），否则"配置说 38080、实际监听 38081"会长期误导排障。

### 4. 布局不变式（本 ADR 的第二个决定）

**`config.yaml` 放在安装根目录本身**（`<root>/config.yaml`），`data/` 是它的兄弟。子进程把所有相对路径按 `config.yaml` 所在目录展开，并把它当作设备身份与授权的锚点。把它放进 `config/` 子目录会让 `data/` 悄悄变成 `config/data/`、并挪走 `license.json` —— 用户升级一次插件就会被云端当成新设备、重新领一份免费试用。见 [`src/paths.ts`](../../src/paths.ts) 的文件头注释与 [ADR-0002](0002-install-directory.md)。

### 5. 不按平台填 `license.product`

`license.server_url` 与 `license.product` **不由插件生成**（它们不在 `MANAGED_FIELDS` 里）：许可证服务与产品线的取值属于子进程自己的契约，插件只呈现和转发授权状态（`license/status`、`license/set`）。插件猜错产品线会把请求归到错误的线上。

## Consequences

**得到：**

- 两个写者有明确的边界与顺序（插件只在子进程停下时写），不会再出现"我改了端口，重启后又被改回去"。
- 用户通过模型改的 Vision / 触发规则 / 小智端点在插件重启后**不会丢失**。
- 界面显示的配置来自真实文件，不是插件的记忆。

**付出：**

- 每次改一个字段都要一次"停服务 → 写 → 起服务"，因此端口/绑定地址之类的改动天然是"保存并重启服务"（界面文案已经这么写）。
- 文件的注释会在子进程第一次回写后消失，所以不能靠"文件里有注释"来传达信息 —— 信息必须在界面与文档里。
- 需要实现一遍 YAML 读回合并逻辑，且要处理"文件被手改坏"的情形（读不动时：不写、报错、给"恢复默认配置"的显式动作，而不是静默覆盖）。

## Alternatives

### 让子进程自己管全部配置，插件只读

插件完全不动 `config.yaml`，只在首次安装时拷一份上游模板。

- **否掉的原因**：子进程没有任何"配置管理 API"（MCP 工具里只有 `config/get_vision` / `config/set_vision` / `config/get_trigger` / `config/set_trigger` 四个，且只管业务配置）。http 端口、绑定地址、各 token 路径这些"托管必需"的字段没有工具可改 → 插件只能靠写文件。**必须写**，所以问题只是"怎么写"，本文就是答案。

### 插件写一份自己的配置，用 `--config` 指过去

看起来能完全避开双写者。

- **否掉的原因**：`config.yaml` 的位置就是身份（[ADR-0002](0002-install-directory.md)）。另起一份配置 = 子进程在新目录下生成新的 `device_id` 与新的免费试用，用户看到的是"授权没了"。**直接违反不变式。**

### 在插件与子进程之间加一个配置守护（watch + 冲突检测 + 重放）

监听文件变化，检测到子进程回写就把插件拥有的字段"重放"回去。

- **否掉的原因**：复杂度高而收益为零 —— 子进程从不修改插件拥有的字段（它只改 `xiaozhi` / `vision` / `trigger`），所以不存在真正的冲突需要守护。"停服务再写"这一条就够，且更可预测。**不为不存在的问题引入守护进程。**

## 已拍板：`data/` 的位置（取 ②）

起草时这里是一个未决项：`license.json` / `device_id.txt` / `token_usage.json` 被硬编码锚定在 `dirname(config.yaml)/data`，而 `memory.data_dir` / `skill.user_dir` / `trigger.rules_file` 这类可配置路径若写成 `data/...` 也会落到同一个地方 —— 那么"不可移动的目录"到底是谁？

三个候选：

| 方案 | 做法 | 代价 |
|---|---|---|
| ① 承认锚点 | 把"不可移动目录"定义为 `<root>/config/`（含其下 `data/`） | 与 `paths.ts` 的声明不符，且排障时"身份目录"藏在子目录里 |
| **② 上移配置（采用）** | `config.yaml` 放在 `<root>/config.yaml`，`data/` 正好是它旁边的目录 | 需要改 `paths.ts`（已改）；不再有 `config/` 子目录 |
| ③ 写相对路径 | 生成物里把可配置路径写成 `../data/...` | **不能覆盖**三个硬编码路径，仍会有两个 data 目录 |

**决定：②**，理由是它需要**零个字段级特例**（③ 需要三个不可能的特例，① 需要改注释并接受一个反直觉的身份路径），且与 `paths.ts` 的文件头注释（"`config.yaml` 坐在根目录，这不是风格选择"）一致。已实现。
