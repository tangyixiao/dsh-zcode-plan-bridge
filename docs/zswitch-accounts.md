# 多账号 / Multiple accounts

Version `0.6.3` extends the existing toolkit rather than introducing another desktop account manager.

## 使用

1. 安装并运行 [Z·SWITCH](https://github.com/pjpv/zcode-switch)，在其中保存已有账号或通过“添加”登录新账号。插件自动探测已有安装；找不到时，在插件配置中填写绝对路径 `zSwitchPath`。
2. 打开 DSH 插件配置中的“账号管理 · Z·SWITCH”。账号列表复用现有账号库；“保存 ZCode 当前登录”明确保存的是原客户端当前登录。
3. 默认选择**独立模式**，然后点账号行中的“使用此账号”。这只改变 DSH 原生 agent 的账号。**共同模式**则调用 Z·SWITCH 更改共享登录，DSH 和 ZCode 一起换号。切换模式后需要重新选择账号。
4. 勾选参与账号、调整先后顺序，再开启“额度耗尽后自动换号”。必须先能识别当前账号；不确定时先明确选择一个已保存账号。
5. 已确认耗尽的账号保持跳过，即使重启 DSH 也不会自动假设它恢复了。可手动查询额度，再明确点“恢复参与轮换”。

界面区分 DSH 当前账号、主选账号、ZCode 当前登录和待切换状态，并显示少量自动切换记录。新增 OAuth 登录、活动自动领取、导入导出仍由 Z·SWITCH 处理，插件不会启动活动领取任务。

账号保存、更新、改名和删除作用于 Z·SWITCH 账号库，两种模式都一样；独立的是 DSH 的运行账号。删除前会确认，当前 DSH 或 ZCode 正在使用的账号不能删除。更新登录前先在 ZCode 登录对应账号，随后“更新保存的登录”。

## 自动换号的准确含义

- 只认原生错误归因中、实际账号套餐路由的 `providerErrorCode: 1113`。普通 429、并发限制、网络错误、登录失效、权益不足和 ESA HTML/405 不会触发轮换。
- 当前失败回合按真实结果结束。所有已接收请求排空之后，下一次独立请求才选择下一个可用账号。状态刷新、查额度、模型目录查询和本地会话标题不会消耗待切换动作。
- 不跨账号自动重发 `session/send`。开启轮换时关闭 DSH 外层自动重试，并以不可逆摘要阻止原样失败请求被另一层重试带到新账号。发一条新消息，或先明确选择账号/重置状态，再重试原任务。
- 下一账号必须支持所选模型与套餐通道。不能满足时明确停止，不悄悄替换模型或走另一计费通道。请求、目录查询或账号操作未结束时，其他账号变更会提示忙碌。

## 独立运行的边界

上下文超限会使用 DSH 标准错误码 `CONTEXT_WINDOW_EXCEEDED`，关闭并丢弃超限原生会话；不会把它当作额度耗尽换号，也不会静默截断对话。如果 DSH 提供的历史本身已超过窗口，请先压缩对话或新开会话再继续。错误识别与会话清理不等于真实对话已成功压缩。

独立模式需要支持 `ZCODE_CLI_CREDENTIALS_FILE` 和 `ZCODE_CLI_SETTINGS_FILE` 的 npm ZCode 内核，以及可用的系统凭证存储。插件复用已安装的原生 keyring 模块，没有新的 npm 运行依赖。仅有不支持隔离的 Desktop 内核时明确提示不可用，不退回共同换号。

Z·SWITCH 是账号库的来源。DSH 为选定账号保留原生可写运行目录，使用独立系统密钥条目加密；原始系统密钥、登录文件和 Z·SWITCH 快照不会被移动或改写。原生刷新后的凭证留在该运行目录，后续继续使用；重新保存/更新源账号后可重新物化。丢失密钥或缓存损坏时停止并提示更新登录，不写明文密钥或静默重置源登录。

共同模式委托现有 CLI 的 `switch --no-restart --hot true`，不传 `--force`、不调用 `kill`，也不会强制关闭 ZCode。共享登录影响其他使用同一 ZCode 登录的程序；正在执行其他原生任务时应使用独立模式。

插件的账号管理接口仍要求宿主 owner 身份、同源、进程控制 key、账号库及设置版本。浏览器不接收令牌，也不能提交任意账号文件路径。可分享诊断不包含账号列表、名称、ID、路径或上游原始错误。已有诊断命令保留原语义；Z·SWITCH 自带 CLI 继续提供账号命令。

## Reference and evidence

The integration follows the existing MIT-licensed [Z·SWITCH CLI and store protocol](https://github.com/pjpv/zcode-switch/tree/f34225686dfef05d84c256a56f868719248f15ff/src-tauri/src), particularly `cli.rs`, `store.rs`, `quota.rs`, `probe.rs` and `zcrypto.rs`. Credential decoding reuses this plugin's existing native v1/v2 reader. No Rust/Tauri UI or second login/claim implementation is bundled.

Offline fixtures cover account modes, admission, attribution, no-replay behavior, persistence, source changes, cache encryption, key failure and destination junctions. A synthetic native probe completed startup and session creation with networking blocked and without generation; shared native files retained their hashes. This does not establish real-account login refresh, cross-account inference or live automatic failover. Source checks, package installation, host activation, CI, merge and public release remain separate evidence.

## English quick guide

Use the existing Z·SWITCH account library. Add logins there, refresh the DSH toolkit, choose **Independent** (the default) or **Shared**, then select an account. Independent mode gives DSH its own native working profile and preserves Desktop login; shared mode delegates the global login switch without force/restart. Account-library CRUD is shared in both modes.

Enable an ordered set of accounts for next-request rotation after a confirmed account-route quota failure. The failed task is not replayed. Status/catalog reads do not trigger rotation, and an unchanged failed input cannot silently move to another account. Exhausted accounts require an explicit reset; model/channel incompatibility stops generation rather than changing the requested route. New OAuth login and activity claiming stay in Z·SWITCH.
