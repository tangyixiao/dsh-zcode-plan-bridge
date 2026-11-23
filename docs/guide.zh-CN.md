# ZCode Plan Bridge 使用指南

DSH 通过 ZCode 的 app-server 使用原生会话。ZCode 负责登录、模型目录和模型请求；DSH 显示流式回复、推理、已确认的任务清单和子任务。

## 安装和升级

在 DSH Desktop 的插件管理中安装发行页的 `.tgz`。Web 可运行 `dsh plugin --profile web add dsh-zcode-plan-bridge@0.7.0`。升级前先让正在执行的任务结束。

独立模式从 0.6.x 升级后，为每个参与轮换的账号重新授权一次。账号顺序和自动换号设置沿用原记录。工具箱的账号卡片给出登录命令。ZCode 打开浏览器时，请核对账号和提供商后再授权。[账号登录与轮换](zswitch-accounts.md)

## 选择 Start Plan

在 Bridge 设置中选择 `accountMode: start-plan`，刷新原生模型目录，并在 DSH 的 ZCode CLI 模型组中选择模型。目录来自当前 ZCode 会话。额度有生效时间时，在生效后发送一条短消息验证真实生成。

## 工具与会话

原生工具权限默认使用 `deny`。根据需要选择原生工作目录，并在任务结束后清理空闲会话。DSH 会把同一会话的请求串行处理。进行账号切换、修改模型设置或清理缓存前，请先等工具和后台任务结束。

## 诊断

`dsh-zcode-plan-bridge status` 查看本机状态，`models` 查询原生模型目录。分享问题时使用 `doctor --share`。遇到登录提示，先确认运行 DSH 的电脑和登录账号。模型目录、会话建立与模型实际回答是三个可分别验证的步骤。

[工具箱](toolkit.md) · [维护说明](maintenance.md) · [许可证](../LICENSE)
