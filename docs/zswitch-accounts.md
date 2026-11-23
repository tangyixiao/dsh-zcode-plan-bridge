# 多账号 / Multiple accounts

Version `0.6.3` extends the existing toolkit rather than introducing another desktop account manager.

## 从 0.6.x 升级和首次登录

打开 DSH 的 ZCode 工具箱，在「账号管理 · Z·SWITCH」中展开所选账号的登录说明。在运行 DSH 的电脑上执行命令，选择与该账号匹配的 Z.ai 或智谱 BigModel 登录页面。每个独立账号首次使用都需要这个步骤。账号顺序、主选账号和自动换号设置沿用原有记录。

```sh
npx --yes dsh-zcode-plan-bridge@0.7.0 login --account ACCOUNT_ID --provider zai
```

若 DSH 使用自定义 `DSH_HOME`，请在登录终端设置相同的目录。使用自定义安装路径时，可通过 `--cli-path` 和 `--zswitch-path` 指定与 DSH 相同的 ZCode 桌面内核与 Z·SWITCH。

把 `ACCOUNT_ID` 换为工具箱账号卡片中显示的 ID；国内智谱账号使用 `--provider bigmodel`。登录页由 ZCode 打开。请核对浏览器中的账号，再完成授权。少数旧账号缺少可核对身份的元数据，命令会要求确认；只有在你已核对该账号后才使用 `--bind-unverified`。工具箱里的“查额度”查询 Z·SWITCH 中对应账号的额度。

选择「独立」后，DSH 使用所选账号自己的 ZCode 数据目录。「共同」模式下，换号会通过 Z·SWITCH 更改桌面当前登录。勾选参与账号、调整先后顺序，再开启自动换号。已确认耗尽的账号可以在核对额度后手动恢复参与。

## 自动换号的准确含义

- 识别原生错误归因中、实际账号套餐路由的 `providerErrorCode: 1113`；另识别 Start Plan 路由 `account:zai-start-plan` 返回的结构化 `1005`，且原生错误消息必须为 `exceed quota limit`。仅有消息文本、其他路由或其他含义的 `1005` 均不足以触发轮换。普通 429、并发限制、网络错误、登录失效、权益不足和 ESA HTML/405 不会触发轮换。
- 共同模式或关闭自动续跑时，当前回合报出失败，下一条新请求选择下一个可用账号。状态刷新、查额度、模型目录查询和本地会话标题不会消耗待切换动作。
- 开启轮换时关闭 DSH 外层自动重试，并以不可逆摘要拦截原样重试。手动续跑时，可以在原对话发一条新消息，要求先检查进度再做剩余部分。
- 下一账号必须支持所选模型与套餐通道。不能满足时明确停止，不悄悄替换模型或走另一计费通道。请求、目录查询或账号操作未结束时，其他账号变更会提示忙碌。

## 自动续跑

启用独立模式的账号轮换后，自动续跑默认开启。确认额度耗尽后，插件查询原会话及同一内核的其他会话，等正在执行的工具、后台任务和后续回合结束。随后用下一个可用账号发起带进度摘要的新请求，保留原对话、工作区和模型，先让 agent 核对实际进度再继续。设为 `resumeOnQuotaExhaustion: false` 可关闭自动续跑。

每次最多等约三分钟。等待时可以取消。并发请求、无法核实原生状态、账号配置变更或轮换池用尽时，当前回合会结束并显示失败。续跑依赖当前宿主进程，重启后仍可用新消息触发普通换号。工具和待办的摘要能帮助 agent 判断进度，涉及外部效果的操作仍需核实。

## 独立运行与诊断

登录和会话使用同一账号的独立目录，由 ZCode 保存、刷新和使用授权。旧版本的工作目录保留在原位。工具箱的 Start Plan 刷新显示当前原生会话公布的模型；登录文件存在、目录列出模型、真实生成成功分别表示不同的状态。

## English quick guide

Open the ZCode toolkit in DSH, expand an account under Z·SWITCH, and run its sign-in command on the same computer as DSH. Authorize each independent profile once in ZCode. Use `--provider zai` for Z.ai or `--provider bigmodel` for the corresponding BigModel account. When older account metadata cannot identify the owner, the CLI requires explicit confirmation with `--bind-unverified`. Verify the account in the browser before confirming the binding.

In custom installations, use the same `DSH_HOME` in your terminal as the running DSH host. Supply `--cli-path` and `--zswitch-path` for custom executable locations.

Existing account order and rotation policy carry forward. Use independent mode to keep each DSH account separate from the desktop. Shared mode delegates the desktop account change to Z·SWITCH. A catalog refresh shows the models advertised by the native session. Use the account card to check quota, and a real chat during the effective allowance period to confirm generation.
