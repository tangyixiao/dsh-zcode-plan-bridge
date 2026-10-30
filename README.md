# dsh-zcode-plan-bridge

把 **DeepSeek Harness（DSH）** 的模型请求转交给 ZCode CLI 自带的 agent 执行的本地插件。

provider `zcode-cli` 背后是一个常驻的 `zcode app-server` 会话（stdio JSON-RPC，真流式）。
CLI 自己管着登录账号，插件只是把该账号能服务的模型清单原样转述给 DSH ——
**烧的是 ZCode 账号的额度，不需要 API Key，也不需要自建网关。**

本仓库：<https://github.com/tangyixiao/dsh-zcode-plan-bridge> ·
上游原版：<https://github.com/kyle123740/dsh-zcode-cli-proxy>（AGPL-3.0）

## 适配版本（v0.5.x，双内核跟进）

v0.5.2 修复取消后停止请求未发出、`session/stop` 通知被 CLI 忽略，以及正文 / reasoning 伪工具标签在跨 delta 和收尾批次中的泄漏。模型列表查询最多等待 15 秒，超时先显示备用清单；后台探测成功后，后续刷新使用真实清单。

v0.5.1 把 DSH 版本声明放到顶层 `engines.dsh`，供宿主和市场读取；v0.5.0 的嵌套 `dsh.engines.dsh` 不属于宿主读取的字段，实际通过 peer 依赖判断。兼容范围和模型转发行为保持不变。

这个桥同时耦合两个内核，两边都要跟：

| 内核 | 实测通过 | 声明范围 |
|---|---|---|
| **ZCode CLI**（`zcode-app-cli` / 桌面端 builtin） | **3.16.3**（npm `3.16.3-39`，2026-10-24）；通道方法 73→99 零删除、事件枚举不变、`approvalMode:"user-once"` 已适配 | 无硬性下限，但 **3.14.x 与升级后的桌面端共存会启动即崩**（桌面写出的新 builtin 老内核解不了，#207），建议 ≥ 3.15.3 |
| **DSH 宿主**（`@deepseek-ai/dsh-llm` 线） | 0.2.1-rc.3（2026-10-23，devDeps 即此版） | `engines.dsh = >=0.1.5 <0.3.0-0 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.1`；cordis `>=4.0.1 <5.0.0`（4.0.5 实测）、schemastery `>=3.18.1 <4.0.0`（3.18.5 实测） |

预发布 semver 很严：`>=0.1.5-rc.1` 对 `0.2.1-rc.3` 求值是 **false**（只有带同一
`major.minor.patch` 的比较项才接纳预发布），所以 peer 按线 caret 枚举，不写开区间。

> **与上游 0.3.x 的差异（v0.4.x 起基于实机逆向重写通道层；v0.5.x 跟进双内核升级）**
>
> 上游假定「DSH 侧注入 Start Plan 账户 + 硬编码模型清单」，实测在 npm 版 CLI
> （`zcode-app-cli`）上这两条都错：
>
> 1. **CLI 处于 standalone 模式，拒绝宿主注入**。`provider/updateAccountConfig` 直接回
>    `Error: Standalone Account 由本进程管理，不接收 Host 覆盖`。账号本来就被 CLI 自己管着，
>    注入既不可能也没必要 —— 已删除。
> 2. **同时设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
>    会让 CLI 直接起不来**，stderr 固定为 `Error: Bundled 与 Active ZCode Built-in Release 均不可用`，
>    而且不服务任何请求。桌面客户端写出的 builtin `revision` 一旦超过当前 CLI 能解的 schema，
>    就必然踩中。已彻底不再注入任何 `ZCODE_*` 环境变量。
> 3. **模型清单改为读 CLI 上报**。`session/create` 的 `settings.model.available` 是权威清单；
>    上游硬编码的 `200000 / 64000 / [FALLBACK_MODELS]` 与实机差 5 倍（真实
>    `contextWindow=1000000`、`maxOutputTokens=128000`），provider id 也不同。
> 4. **provider id 不再硬编码**。上游写死 `account:zai-start-plan`，但 standalone 下该 provider
>    不进入 registry；实机是 `account:zai-individual-coding-plan`。
>
> 通道逻辑（回合锁、自愈、事件流、图片物化）沿用上游的逆向结论并补了对应改造，版权归上游作者。

```
DSH Agent ──► provider "zcode-cli" ──► ZcodeAppServerAdapter
                                            │  spawn zcode.cjs app-server --stdio（常驻）
                                            ├─ session/create    拿 settings.model.available（模型清单）
                                            ├─ session/subscribe  desktop-continuous 事件流
                                            ├─ session/setModel   仅在目标模型与当前不同时切换
                                            ├─ session/send      发回合（真流式）
                                            └─ interaction/requestProviderRuntimeHeaders  回 OAuth 鉴权
                                                  └──► zcode.z.ai/api/v1/zcode-plan/anthropic
```

## 用法

**DSH Desktop 安装/更新**：从本仓库的 GitHub Release 下载 `.tgz`，在「扩展 → 插件管理 → 添加插件」中选取本地文件。Desktop profile 由桌面应用管理。若已装有 `0.6.0-community.*` 预览版，请保留该版本；0.5.x 稳定线不包含该预览分支的无限重试功能，不能作为其原位升级。

1. 装一份 ZCode CLI（`npm i -g zcode-app-cli`，或桌面客户端自带的 `zcode.cjs`），并登录有额度的账号。装了桌面端的注意：**保持 npm 全局包跟着桌面端一起升级**——桌面升级后会在 `~/.zcode/v2` 写入新版 builtin，老 CLI（<3.15.3）解析不了会在服务任何请求前直接退出。探测自动在多份内核里选版本最新的一份。
2. 把本插件装进 DSH profile，重启 DSH。
3. DSH 设置 → 模型（Models）→ 提供方 **ZCode CLI (account bridge)** → 选模型。

可用模型**不是插件写死的**，而是 CLI 当前账号能服务的那批。本机实测（2026-10-24，内核 3.16.3）：

| provider | model | context | max output | image |
|---|---|---|---|---|
| `zai-api` | GLM-5.3 | 1000000 | 128000 | ✓ |
| `zai-api` | GLM-5.3-Flash | 1000000 | 128000 | ✓ |
| `ccc6dfb9-…`（个人 deepseek） | deepseek-v4-flash | 1000000 | 384000 | ✓ |

3.15+ 的 builtin registry 还带了 `account:zai-highspeed-card` 等 HighSpeed 通道；清单里出现
`account:` 前缀路由时插件仍然优先它（烧计划额度），`zai-api` 路由按 CLI 自己的计费口径走。

### DSH rc.3 一直显示「正在加载模型」

DSH `0.2.1-rc.3` 在支持范围内。模型选择器正在加载，并不表示宿主拒绝了插件版本：模型列表还要等待 ZCode CLI 启动和 `session/create` 返回。v0.5.1 及以前，这条路径默认可能等待约 130 秒；v0.5.2 为界面查询增加 15 秒上限，超时记录警告并返回备用清单，后台探测继续。备用清单只用于让界面可用，具体模型是否可用仍以 CLI 账号为准。

1. 在 DSH 插件管理中核对**插件版本和安装来源**。截至 2026-10-30，GitHub Release / 市场已有 v0.5.1，官方 npm registry 的 `latest` 仍为 v0.5.0。通过 npm 更新不一定取得 GitHub 上的修复；可用 `npm view dsh-zcode-plan-bridge version --registry=https://registry.npmjs.org` 核对。Desktop 用户可从 [GitHub Releases](https://github.com/tangyixiao/dsh-zcode-plan-bridge/releases) 下载已发布的 `.tgz`，再通过插件管理添加本地文件。
2. 在实际使用的插件目录运行 `node bin/dsh-zcode-plan-bridge.js doctor --json` 和 `node bin/dsh-zcode-plan-bridge.js models --json`。这两条命令不发送生成回合。核对诊断输出中的 `zcode.cjs` 路径；显式配置的 `zcodeCliPath` 会覆盖自动探测，旧路径需要更新。账号状态和可用模型可先在 ZCode 本身确认。
3. 如果 `models` 能成功返回而 DSH 仍持续加载，记录插件、DSH、ZCode CLI 版本、加载持续时间，以及 DSH 日志中的 `zcode:`、`app-server exited`、`could not read the CLI model catalogue` 等相关信息。提交 issue 时附诊断结果即可，不需要提供凭证文件。

Issue #5 的截图没有错误信息、等待时间或诊断日志，无法据此确定报告者卡住的具体原因。这里的等待上限、探测会话清理和安装来源核对均有独立验证，不代表已在报告者环境复现。

同一 model id 出现在多个 provider 上时，插件**优先 `account:` 开头的路由**（烧计划额度），
其余按 CLI 上报顺序取第一条；想指定确切路由，就在 `cliModels` 里给条目写
`id: "zai-api/GLM-5.3"`（`providerId/modelId` 形式）。

- 真流式（text/reasoning delta 直接转发）、工具调用、图片输入（图片以本地文件随消息附上，agent 用 Read 读图）
- 多轮会话按 DSH 的 sessionId 复用 app-server 会话
- 会话标题这类辅助调用在本地生成，不消耗额度
- 前置条件：本机能跑起 ZCode CLI，且它已登录有额度的账号

## 安全须知（装之前必读）

这个「模型提供方」的真身是一个**以你当前用户权限运行、且带全套工具执行能力的 agent**。它不在 DSH 的工具权限边界内运行：DSH 的权限模式和浏览器审批界面只处理 DSH Host 自己发起的工具调用，不能确认 ZCode app-server 发起的授权请求；本插件也没有自己的交互式确认窗口。

- 两种策略都会将会话设为 ZCode 的 `build` 权限模式，确保授权请求经过插件处理；模式设置失败时本轮停止。该策略不构成操作系统沙箱，也不阻止无需额外授权的 agent 操作。
- 默认 `authorizationPolicy: deny`：插件对 `interaction/requestPermission` 回复 `deny`，不会弹确认框；需要授权的工具调用会失败。
- 3.15+ 内核的权限请求可能带 `approvalMode:"user-once"`（不允许附带持久化规则）；插件只回裸 `decision`，两种策略下都满足该模式。出现**未识别的 `approvalMode` 或权限类方法名时始终 fail-closed 拒绝**，即使启用了全自动模式；如果 ZCode 将来改变权限协议，相关调用会失败关闭。
- 只有显式设置 `authorizationPolicy: allow-all` 才会自动批准已知的 `interaction/requestPermission` 请求。该设置允许 agent 以当前用户权限执行 Bash、文件读写和联网操作，不要在不可信任务中启用。
- agent 的输入是 DSH 拍平后的整段对话（包括网页抓取、工具结果等外部内容）。提示注入仍可能诱导全自动模式执行恶意操作；默认拒绝减少了授权面，但不能消除未经过授权请求的副作用。
- 子进程环境变量按白名单透传（系统基础变量、`ZCODE_*`、`NODE_EXTRA_CA_CERTS`），不继承
  DSH 宿主的全部 env；确有需要可用配置项 `childEnvAllow` 追加变量名。
- 鉴权 token（`zcodejwttoken`）只经本机 stdio JSON-RPC 交给 agent 进程，不发往任何第三方。

## 通道原理（全部实机逆向验证）

1. spawn `zcode app-server --surface terminal --no-color` 时**不注入任何 `ZCODE_*`**。
   实测三种环境（零变量 / 只 `ZCODE_SERVICE_AUTHORITY_MODE` / 再加 `ZCODE_BASE_URL`）
   产出的模型清单**完全相同**；而注入 builtin/personal 文件路径会引入上面说的启动失败。
2. `session/create` 的返回里 `settings.model.available` 是模型清单，`session.model` 是当前模型。
   条目形状：`{ref:{providerId,modelId}, label, providerLabel, contextWindow, maxOutputTokens,
   reasoning:{levels:[{value}],defaultLevel}, properties:{inputFormat:{supportsImage}}}` ——
   **没有** `inputModalities` 字段，图片能力要看 `properties.inputFormat.supportsImage`。
3. `session/subscribe` 用 `{deliveryKind:'desktop-continuous', afterSeq:0, includeSnapshot:true}`。
4. `session/setModel` 要求对象式 `{providerId, modelId, options:{reasoningLevel}}`；
   `reasoningLevel` 取自条目上报的档位（本机是 low/high/max，默认 max）。
5. agent 发模型请求前回调 `interaction/requestProviderRuntimeHeaders` 要鉴权 —— 回共享凭证里的
   **`zcodejwttoken`**（`oauth:zai:access_token` 已过期，回它上游 401）。agent 自己算签名，能过 WAF。
6. `session/event` 的事件类型在 **params.type 顶层**（不是 payload.type），`turn.failed` 也要处理
   （错误码在 `payload.error.attribution.providerErrorCode`），`replayState` 里不能有 `undefined`
   字段（lossless JSON 校验会炸）。
7. 服务端请求必须应答，否则 `session/create` 挂起：`session/requestRuntimePreferences` 回
   `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false,
   askUserQuestionAutoResolutionEnabled:true, modelContextBudgetStrategy:'preflight-v1'}` 就够。
8. **CLI 探测按版本择优**（v0.5.x）：`ZCODE_CLI_PATH` → 桌面端默认安装位 → Windows 各盘根
   `X:\ZCode\resources\glm\zcode.cjs` → macOS/Linux 常见位 → PATH 里的 `zcode-app-cli`，
   全部存在的候选里选版本最高的一份（npm 布局读 package.json；桌面布局没有清单，
   用 `~/.zcode/v2/runtime/provider` 下最新 builtin 目录名作版本代理）。平局按此顺序取先者。
   3.16 新增的服务端请求（如 `interaction/requestOfficialMcpAuthHeaders`、`mcp/ui*`）不认识
   也必须应答，插件统一回空对象——对应功能降级，但不挂会话。

> HTTP 直连计划端点会被无痕验证拦 —— 只有 agent 二进制自己发的签名请求能过，
> 所以「反代」的形态是托管 agent 进程而不是自建 HTTP 网关。

## 回合锁与自愈

app-server **一个会话同时只允许一个在途回合**。上一轮被中止 / 超时 / 静默丢弃时它不会自己释放，
下一轮 `session/send` 就被拒成 `A prompt is already running for this session`。通道层做六件事兜底：

1. **立即请求 `session/stop`**：`AbortSignal` 触发时主动发送带请求 ID 的停止请求，即使宿主已停止拉取流也会执行。CLI 会忽略无 ID 的通知。清理和回合锁释放不依赖生成器继续运行，迟到的生成器收尾也不会停止下一轮；超时 / 发送失败 / `turn.failed` 仍由收尾路径清理；
2. **撞锁自愈**：`send` 被回「already running」时请求 stop，再新建会话重试一次；被回「session … not found」（会话被回收 / 进程重启）时同样新建。中断后的下一轮也会新建会话，按 `firstTurn` 语义重放整段对话；旧会话迟到的结束事件无法污染新一轮结果；
3. **回合串行化**：同一 DSH 会话的两轮排队跑（最多等 60s，超时放行交给 2 处理）；
4. **进程退出即作废 + 快败**：app-server 子进程退出（含 spawn 失败）时清空会话映射，
   **在途的流会立刻收到一个回合失败收尾**，不用干等回合超时；
5. **会话分叉检测**：每轮 send 都记录当时的消息列表指纹；下一轮续接前先比对前缀，
   DSH 侧编辑 / 回退过历史就重建会话、按首轮语义重放新分支；
6. **模型映射**：DSH 选的模型 id 经 catalogue 解析成 `{providerId, modelId}`；
   同一会话中途换模型时在原会话上重发 `session/setModel`，解析不出来就保留会话默认模型并记 warn。

正文和 reasoning 各持有独立的流式过滤状态。可能的伪工具标签前缀暂存到能够判断后再发出，完整标签和跨 delta 的标签都会截断对应通道；收尾队列也走相同过滤。普通词语 `function_calls`、HTML 和大小比较保持原样。正文最终块与已发送的正文保持一致，避免收尾时重新带回被拦截的内容。

## 诊断命令

插件带一个不依赖 DSH 宿主的诊断入口（只用 Node 内置模块，**插件因版本不兼容加载失败时也能用**）：

```
node bin/dsh-zcode-plan-bridge.js              # 列出子命令
node bin/dsh-zcode-plan-bridge.js doctor       # 本地前置条件体检（离线，不耗额度）
node bin/dsh-zcode-plan-bridge.js models       # 打印 CLI 上报的完整模型清单
node bin/dsh-zcode-plan-bridge.js protocol     # 起 app-server 走一遍握手，验证协议没变
node bin/dsh-zcode-plan-bridge.js turn "hi"    # 真发一个回合（消耗额度）
node bin/dsh-zcode-plan-bridge.js image <file> # 发一张图（消耗额度）
```

通用参数：`--cli-path <zcode.cjs>`、`--data-dir <~/.zcode 的上级>`、`--model <id>`、`--json`、
`--allow-tools`。

`--allow-tools` 默认**关闭**，和插件本身的 `authorizationPolicy: deny` 一致。诊断命令会真的用你的
账号起一个 app-server agent，所以不带这个 flag 时，探针会对 agent 的工具权限请求回 `deny`：
`turn` / `image` 能验证通道和用量，但 agent 跑不了 Bash、写不了文件、上不了网。确实需要让探针
执行工具时再显式加上它。名称含 `approval`/`permission` 的未知请求两种情况下都拒绝。

`doctor` 会检查 node 版本、CLI 定位、builtin release（**只读检查，不喂给 CLI**）、
凭证（只打印长度与是否 JWT，绝不打印 token 本体）、以及 CLI 上报的模型清单。

> 这五个子命令取代了上游 `scripts/probe-*.cjs` 那十个一次性脚本。那些脚本各自硬编码了作者
> 本机路径、改一次才能问另一个问题，已删除。

## 配置（设置 → 插件）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `zcodeCliPath` | 自动探测（版本择优） | `zcode.cjs` 路径；空 = 在 `ZCODE_CLI_PATH`、桌面客户端安装位（含 Windows 任意盘根 `X:\ZCode`）、`zcode-app-cli` 全局包等候选里**选版本最新**的一份。显式填写则不做择优，直接用这份 |
| `zcodeCliNode` | `node` | 运行 zcode.cjs 的 node 可执行文件 |
| `cliModels` | `[]` | **留空 = 跟随 CLI 上报的清单**（推荐）。填了就等于把清单钉死成这份，只用 `cliModelId` 决定 CLI 侧路由 |
| `authorizationPolicy` | `deny` | `deny` 会拒绝 ZCode 的权限请求且不提供交互确认；只有你明确接受无人值守工具执行时才设为 `allow-all`。未知 permission/approval 方法始终拒绝 |
| `cliCwd` | 空 | app-server 会话的工作目录；空 = 用户主目录 |
| `zcodeDataBaseDir` | 空 | ZCode 数据根目录；空 = 用户主目录（即 `~/.zcode/v2`） |
| `childEnvAllow` | `[]` | 额外透传给子进程的环境变量名 |
| `appServerTimeoutMs` | `120000` | 单次 JSON-RPC 请求超时（毫秒） |
| `zcodeCliTimeoutMs` | `900000` | 单回合超时（毫秒） |
| `maxTokens` | `128000` | 仅作兜底：CLI 未上报 `maxOutputTokens` 时使用 |
| `defaultContextWindow` | `1000000` | 仅作兜底：CLI 未上报 `contextWindow` 时使用 |

## 开发

```bash
npm test           # 纯函数单测（不 spawn CLI、不耗额度）
npm run typecheck  # tsc --checkJs 全量类型校验（零构建，装进 profile 免编译）
npm run diagnose   # 诊断命令入口
```

**改了代码怎么生效**：DSH 的 loader 只在**行 name 变化**时重新 import 插件模块，
而 Node ESM 以完整 URL（含查询串）为缓存键。仓库里的 `cordis.patch.yml` 写的是包名
（npm / link: 装配的正确形态）；本地目录式开发装配时把它换成 file:// URL 加 `?v=N`：

```yaml
- insert:
    - id: dsh-zcode-plan-bridge
      name: 'file:///D:/path/to/dsh-zcode-plan-bridge/lib/index.js?v=N'
```

改完 `lib/*.js` 后把 `?v=N` 递增，然后在插件管理里对 bundle **禁用 → 启用**（或重启 DSH）。

## 目录结构

```
lib/index.js        插件装配：Config schema、provider 注册、模型清单来源决策
lib/app-server.js   app-server 通道：JSON-RPC 客户端 + LlmAdapter（事件流/回合锁/鉴权）
lib/zcode-runtime.js CLI 发现、catalogue 归一化与路由选择（只用 Node 内置模块）
lib/messages.js     消息工具：图片物化、对话拍平、泄漏工具调用清洗
lib/credentials.js  解密 ~/.zcode/v2/credentials.json
lib/diagnostics.js  五个诊断子命令（doctor/models/protocol/turn/image）
bin/                可执行入口
test/               纯函数单测（node --test）
```

## 许可

AGPL-3.0。本仓库是 [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy)
的衍生版：app-server 通道的逆向结论（回合锁、事件流、鉴权回调）源自上游，
v0.4.x 依实机重新验证并改写了账号/模型层。历史来源致谢
[liu5269/zcode2api](https://github.com/liu5269/zcode2api)，其代码已不再随本仓库分发。
