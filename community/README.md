<p><img src="assets/logo.webp" width="96" height="96" alt="ZCode Community Retry logo"></p>

# ZCode Community Retry 0.3.5（非官方）

在 ZCode 内安装、启用的主聊天无限重试插件。默认每 5 秒重试，可在插件设置调整间隔；持续重试可恢复错误，直到成功、手动停止或收到终止错误。使用原来的 ZCode 快捷方式打开应用。

## 安装与使用

1. 在 ZCode 的「插件市场 → 添加」中选择仓库根目录对应的市场；该市场包含 Retry 和可选的 Keeper 两个插件。
2. 安装或更新 `zcode-community-retry@tangyixiao-zcode-community` 至 **0.3.5** 并在**用户范围**启用。如需自动强制启用，还需安装并启用 `zcode-retry-keeper@tangyixiao-zcode-community` **0.1.1**。Desktop 与 CLI 配置独立，需分别启用 Keeper。 Keeper 的宿主设置绑定及撤销边界见仓库 `keeper/README.md`。
3. 打开插件详情或配置，设置 **重试间隔（秒）**，例如 `10` 表示每 10 秒一次。保存后，下一轮重试读取新值；已经开始的等待会先完成。默认 5，范围 0–86400，允许小数。更长的服务端 `Retry-After` 仍会遵守。
4. 打开新聊天，正常提交任务。遇到受支持的暂时失败，插件会保持当前请求并重试。点击 ZCode 的停止按钮可取消等待。
5. 如需检查，在新聊天使用 `/retry-status`，让 Agent 调用 `retry_status`。核对 `desktopIntegration.active: true`、版本及 `currentAgentPid`。顶层 `active` 可能包括其他 Agent，不单独作为当前聊天已接入的依据。

原生接入针对 **Windows ZCode Desktop 与 npm CLI**，MCP 辅助进程需要可用的 Node.js 22+。本次离线协议使用 Desktop **3.17.1**，3.16.3 为原有验证版本；未来版本仍须核对内部接口。当前只支持用户范围安装和配置；项目范围的开关/间隔尚不支持。更新后已有 Agent 可能保留旧模块，先新建聊天；如果插件仍显示旧版本，待任务结束后正常重开应用。

0.3.1 增加运行时配置路径核验：原生接入调用已验证父 Agent 的纯函数 `getDefaultConfigPath()`，跟随该运行时实际使用的用户设置。Desktop 3.17.1 仍使用 `config.json`，npm CLI 3.17.1 使用独立的 `setting.json`；两者开关分别保留，不会按文件是否存在来切换、迁移文件或同步开关。CLI 停用并不表示 Desktop 停用。新 MCP helper 始终重新核对父 Agent 身份，不把旧状态文件中的活 PID 当成接入证明。无法唯一确定设置路径时，原生接入明确失败。

GitHub 仓库根目录的 `marketplace.json` 包含 `community/` 和 `keeper/`。独立仓库是此插件的源码和反馈入口；原 Bridge 仓库仍保留已发布版本以兼容旧安装。

旧版配套桌面启动器已撤回。请使用 ZCode 内的插件管理；不要运行旧的 `Start-ZCode-Retry.ps1`、CMD 或 `launch-desktop.mjs`。

## 配置与状态

界面中明确保存的「重试间隔（秒）」优先。没有界面配置时，也可让 `retry_configure` 设置 `{"mode":"unlimited","intervalMs":10000}`。该工具拒绝覆盖已经存在的界面间隔，并提示去插件设置修改。原生插件只提供无限模式；显式 CLI/DSH 加载器另外支持 bounded 模式。

Desktop 启用 Retry 后，普通 MCP 组件会在其**直接父 ZCode Desktop Agent**的内存中接入模型传输；Keeper 另外负责自身 Hook 所属的 Desktop 或官方 npm CLI 进程。身份和接口校验通过后，临时本机调试连接会关闭。此方式依赖 ZCode 内部接口，未来升级可能需要适配；已有调试端口被占用时会等待重试，不关闭其他调试器。Hook 在提交提示词前检查当前 Agent 是否已接入；接入失败会明确阻止本次提交，避免静默显示已启用但没有重试。

未启用 Keeper 时，禁用 Retry 会中止社区模块正在等待的请求并撤销内存包装；卸载也会撤销。启用 Keeper 后，仅关闭 Retry 会被恢复；要撤销强制启用，请先关闭或卸载 Keeper。Keeper 仅修改 Retry 的用户范围开关，不启用其他插件；全局插件总开关关闭时不会强行打开。无需修改 ZCode 程序文件、系统环境变量或应用启动命令。MCP 发现进程正常退出不代表插件被禁用，已注册且启用的插件继续工作。

## 重试范围

- 无限模式没有重试次数和累计恢复时间上限。3008 并发限制、临时网络失败、限流和服务端暂时错误会继续重试。
- 1113 余额不足、认证失败、长期额度或模型权限错误直接返回。重试不能增加账号余额或套餐额度。
- 只在尚未交付文本、推理或工具调用时重试；已输出内容后的中断不重放请求，也不会重新提交整个会话或重复执行工具。等待重试不受原生流空闲计时器截断；交付后的模型事件仍有空闲保护，SSE 心跳不会延长它。
- 默认管理 `zcode.z.ai`、`api.z.ai` 和 `open.bigmodel.cn` 的 POST messages、chat/completions、responses 请求；自定义服务须在 `allowedOrigins` 明确添加 HTTPS origin 或 HTTP loopback origin。受管理请求拒绝重定向；其他网络请求使用原传输。
- 请求体复制上限 16 MiB，SSE 探测上限 256 KiB、超时 30 秒。无法安全复制或无法识别的流交回原流程；只有已识别的可恢复错误受无限保证。运行状态只保存安全元数据，不保存令牌、提示词或响应正文。

## DSH 可选接入

桥接包自带同版模块，开关默认关闭。选择启用：

```yaml
communityRetry:
  enabled: true
  mode: unlimited
  intervalMs: 10000
```

无限模式关闭桥接自己的 15 分钟回合超时，由社区模块统一处理物理请求。调用方取消仍被遵守，`session/stop` 使用有响应的请求确认取消。配置在新建桥接子进程时生效，已有子进程需要正常结束后重建。独立 ZCode 插件与 DSH 开关分别控制。

## 验证与源码

从仓库根运行 `npm test`。真实 CLI/桌面 Agent 协议测试使用隔离配置与本地模拟上游，不需要真实账号：覆盖普通插件发现、主聊天连续 25 次失败后第 26 次成功、已有模型传输晚接入、界面配置协议、禁用/启用、终止错误和手动停止。协议验收不代表已经完成用户桌面界面点击或真实账号上游验收。

源码与反馈：[tangyixiao/zcode-community-retry](https://github.com/tangyixiao/zcode-community-retry)。AGPL-3.0。此插件与 ZCode 官方没有从属关系。
