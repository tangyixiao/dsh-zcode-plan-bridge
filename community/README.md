# ZCode Community Retry（非官方）

独立的 ZCode 社区无限重试扩展，包含普通插件和配套 Agent 加载器。默认无限重试，固定间隔可调。插件提供配置、状态查询；加载器处理模型请求。仅安装或在市场打开插件开关，不代表原生聊天已启用自动重试。

需要 Windows、Node.js 22+ 和兼容 ZCode。已用本机 ZCode 3.16.x 的桌面 CLI、zcode-app-cli 3.16.3-39 连接隔离模拟上游验证。其他版本先运行兼容测试。原生桌面窗口的完整操作验收状态见交付报告。

## 安装插件

解压独立安装包后，在 ZCode 插件市场添加该目录作为本地市场，安装并启用 `zcode-community-retry@tangyixiao-zcode-community`。该目录同时包含 marketplace.json 和 .zcode-plugin/plugin.json。本仓库源码的插件根目录为 community/。

GitHub 分支中仓库根目录也提供 marketplace.json，指向 community/。在该分支合并前，使用分支的本地克隆或交付安装包；默认分支尚未包含新功能，直接添加默认分支不能安装本版本。

新会话中使用 `/retry-status`，或让 Agent 调用 `retry_status`。工具返回插件实际的 `dataDirectory` 和 `launcher`。`retry_configure` 支持 mode、intervalMs、maxRetries 等配置；配置在下一次 Agent 启动时生效。例如让工具设置以下参数，即无限重试、每 10 秒一次：

```json
{"mode":"unlimited","intervalMs":10000}
```

`mode: unlimited` 是默认模式，没有重试次数和累计恢复时长上限。`intervalMs` 单位为毫秒，默认 5000（5 秒），采用固定间隔，不做指数退避或随机抖动；更长的服务端 Retry-After 仍会被遵守。`mode: bounded` 可使用很大的 maxRetries（如 1000000），并遵守 budgetMs 和原退避选项。旧配置未指定 mode 时也使用新的默认无限模式；若需要保留旧版有限行为，请显式设置 bounded。

## 启用桌面端

先结束当前任务并完全退出 ZCode。使用上一步工具返回的 launcher 和 dataDirectory，在 PowerShell 执行：

```powershell
node '插件绝对目录\bin\launch-desktop.mjs' --exe 'D:\ZCode\ZCode.exe' --data-dir 'retry_status 返回的数据目录'
```

可以用 `--cli` 指定原始 zcode.cjs。启动器发现已有 ZCode 实例会拒绝启动，避免旧实例接管窗口导致显示已开启、实际未加载。它只为这次启动设置自定义 Agent 命令，不覆盖程序文件或系统环境变量。

打开新任务后再次查询 `/retry-status`：`currentAgentPid` 应匹配一个 live runtime。`active` 只表示有存活且持续更新状态的加载器；只有实际请求测试能证明重试生效。其他 Agent 进程可能使用相同数据目录，应核对 PID 和 owner。

恢复原行为：退出配套实例，使用原来的 ZCode 快捷方式启动。无需卸载或修改原程序。首次关闭时请自行确认任务已经结束。

直接启动 CLI：

```powershell
node '插件绝对目录\bin\agent.cjs' --cli '原始 zcode.cjs 的绝对路径' app-server --stdio
```

直接 CLI 默认使用 `~/.zcode/community-retry`；可以通过 `ZCODE_COMMUNITY_RETRY_DATA` 和 `ZCODE_COMMUNITY_RETRY_CONFIG_FILE` 指定独立数据与配置。插件安装的数据目录通常不同，因此桌面启动命令应明确传入工具返回的 `--data-dir`。

## 重试边界

默认以固定 5 秒间隔持续重试可恢复错误，直到成功、取消或返回终止型错误；可通过 intervalMs 调整。无限模式忽略 maxRetries、budgetMs、backoffFactor 和 jitter，不再受到旧版 6 次、10 分钟限制。取消、显式禁止重试、认证失败、1113、套餐权限和长期额度错误仍直接返回。有限模式仍支持次数、累计时长和指数退避配置。

仅在尚未交付文本、推理或工具调用时重试。流已经开始产生有效输出后断开，保留原错误。模块不重新提交整个会话，也不重复执行工具。

默认管理 zcode.z.ai、api.z.ai 和 open.bigmodel.cn 的 POST messages、chat/completions、responses 请求；自定义模型服务须在 allowedOrigins 显式添加 HTTPS origin 或 HTTP loopback origin。受管理请求拒绝重定向，避免重试流向未批准目的地。其他网络请求使用原传输。

请求体复制上限 16 MiB，SSE 探测上限 256 KiB，探测超时 30 秒。无法安全复制或无法识别的流直接交回原流程。原生模型重试在加载器内设为 0，社区模块拥有唯一预算。运行时状态保存安全元数据，不保存令牌、提示词或响应正文。

## DSH 可选接入

新版 dsh-zcode-plan-bridge 中启用以下配置。桥接包内含同版本模块，不需要另装本插件即可启动；独立 ZCode 插件仍可单独使用。

```yaml
communityRetry:
  enabled: true
  mode: unlimited
  intervalMs: 10000
```

无限模式同时取消桥接自己的 15 分钟回合超时，关闭原生与 DSH 外层模型重试，由社区模块统一处理。调用方取消仍被遵守。关闭开关时恢复桥接原行为。

## 验证与源码

从仓库根运行 `node --test test/community-*.test.mjs`。真实 CLI 测试只使用本地模拟服务与隔离配置，不需要真实账号；本机没有 CLI 时设置 `ZCODE_TEST_CLI`。桌面 UI、真实账号和模拟故障是不同证据，不能相互替代。

源代码与问题反馈：https://github.com/tangyixiao/dsh-zcode-plan-bridge 。AGPL-3.0 许可证。此组件与 ZCode 官方没有从属关系，不保证重试后服务端一定释放并发额度。
