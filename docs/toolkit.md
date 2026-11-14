# ZCode toolkit / ZCode 工具箱

Source candidate: **0.6.2-toolkit.3**. This is separate from published stable **0.6.1**, community previews, package installation, runtime activation and successful generation. / 本轮工具箱候选与稳定版、社区预览、安装、实际加载和真实生成分别记录。

## 使用

在 DSH 中进入「扩展管理 → 插件管理 → ZCode Plan Bridge → 配置」。新面板使用宿主现有布局与主题，支持中文、英文及窄屏；缺少配置插槽时继续使用原有 schema 设置与 CLI。工具箱控制需要提供 `webServer` 和 `connection.admit` 的宿主，依据 DSH **0.2.2-rc.1** 合同接入；不因此扩大宿主兼容声明。

1. **状态与套餐**：查看版本、运行状态、通道和本地凭证可读性。「刷新 Start Plan 套餐」手动请求现有 balance 接口，只展示实际返回的名称、单位、额度与观察时间。可读凭证不证明远端认证或生成成功；不同单位不合并、不换算费用。
2. **模型**：「刷新模型目录」通过原生 app-server 读取目录，不发送生成请求。配置中的 `cliModels` 优先提供展示条目，随后应用隐藏设置；不能把所有当前模型隐藏。上游目录变化导致已显示模型全部消失时，恢复当前列表以便继续选择。
3. **推理**：仅选择目录实际声明的档位。优先级为单次请求的 `reasoningEffort` → 工具箱为该账号/模型保存的默认值 → CLI 声明默认值。模型别名通过 `cliModelId` 读取能力。复用会话也同步档位；同步失败则结束请求，不能悄悄使用旧档位生成。
4. **会话与 Retry**：显示活跃、排队/处理中和缓存数量。清理空闲桥接缓存会关闭对应原生会话并清空目录，不删除 DSH 对话。有活跃、排队、初始化或目录探测时拒绝冲突操作。Retry 设置覆盖 schema 中相应字段，恢复按钮移除此覆盖；保存后在下一次请求前重建空闲原生进程，保留取消能力。
5. **工具权限**：管理既有 `deny` / `allow-all`，或沿用插件配置。`allow-all` 自动批准无人值守工具执行；默认仍为 `deny`。本轮没有逐工具宿主审批、账号轮换、签到、图片生成、视频生成或上下文压缩入口。
6. **观测与诊断**：最多保留 50 条、24 小时以内的本次运行内存观测。只记录模型、结果类别、时间和实际上报的 token，不记录提示词、回答、图片路径或原生会话 ID。缺失字段显示未知，真实 0 保留 0。取消即使没有后续流读取，也会在原生清理后释放计数并记录一次取消。

## 设置保存和账号变化

设置存放在 `$DSH_HOME/dsh-zcode-plan-bridge/toolkit.json`，未设置 `DSH_HOME` 时使用 `~/.dsh/dsh-zcode-plan-bridge/toolkit.json`。使用原子替换、排他锁和 revision 比较，不写 ZCode 的共享登录文件。工具箱覆盖的 Retry/权限与模型偏好由宿主、适配器和 CLI 读取同一份文件。

隔离键包含数据根目录、套餐通道及本地凭证版本的不可逆摘要。不信任未验证 JWT 中的用户声明；凭证刷新可能建立新的偏好空间。账号或通道变化后，空闲旧子进程和缓存失效；有请求时拒绝新的冲突操作。旧界面的 scope/revision 不能覆盖新状态。文件损坏、锁占用或超出 64 个偏好空间/256 KiB 上限时明确失败，不擅自清空旧设置。

## CLI

```sh
node bin/dsh-zcode-plan-bridge.js status --json --account-mode start-plan
node bin/dsh-zcode-plan-bridge.js capabilities --json
node bin/dsh-zcode-plan-bridge.js doctor --share
```

这三种调用只读本机状态，不启动 app-server，不发生成请求。`--data-dir <dir>` 指定 ZCode 数据根目录；`--cli-path <file>` 指定内核入口。分享报告采用字段白名单，删除用户路径、账号/设备标识、凭据、任意异常正文，并明确标记 `inference: not-tested`。它不连接运行宿主，不能证明运行中实际加载的版本。

普通 `doctor`、`models`、`protocol` 会启动真实 app-server 并可能进行目录网络读取；`turn`、`image` 发送真实生成请求、消耗对应账号额度。不得把它们统称为离线检查。工具箱的套餐刷新和目录刷新均手动触发，不自动轮询生成。

## English

Open **Extensions → Plugins → ZCode Plan Bridge → Configure**. The additive native-theme panel provides local/kernel/channel status, manual Start Plan balance facts, model visibility and declared reasoning defaults, idle session/cache controls, Retry preferences, the existing native-tool policy, bounded usage/failure observations and an allowlisted shareable diagnostic report.

Configured `cliModels` remain authoritative before visibility filtering. Never hide every current model. Explicit request effort takes precedence over the credential/channel/model default and then the CLI default; reused sessions receive changes, and failed model/effort synchronization stops the request before generation. Context/output limits and reasoning levels are never enlarged or invented.

Preferences use the same atomic, revisioned, credential-generation/channel-scoped store for host, adapter and CLI. The default location is `$DSH_HOME/dsh-zcode-plan-bridge/toolkit.json`, otherwise `~/.dsh/dsh-zcode-plan-bridge/toolkit.json`. A token refresh may start a fresh preference bucket. No desktop credentials are rewritten. Corruption, held locks and storage limits fail explicitly. Active or queued work prevents conflicting mutations or cache clearing. A retired account/channel invalidates idle native state.

The native policy remains `deny` by default; `allow-all` permits unattended tool execution. Granular host approval, account rotation, check-in, media generation and compaction are outside this candidate. Existing image input is preserved and differs from image generation.

Observations retain at most 50 entries from the last 24 hours in memory, with no prompts, responses, image paths, credentials or native session IDs. Missing usage stays unknown and a reported zero stays zero. No credits or money are inferred from tokens. HTTP 405/HTML edge failures are channel failures, not proof of an exhausted plan. Aborted paused consumers release admission only after native cleanup and record cancellation once.

`status`, `capabilities`, and `doctor --share` stay local and send no generation turn. Ordinary `doctor`, `models`, and `protocol` start the real app-server and may perform discovery network requests; `turn` and `image` consume quota. Local reports cannot prove the active host's loaded version. The owner-authenticated management route requires current scope/revision, a process control key, bounded JSON and exact matching of any supplied Origin; official authenticated Desktop forwarding may omit Origin.

Use the separate [acceptance record](toolkit-acceptance.md) for what actually passed. Public publication/merge and paid generation are separate operations.
