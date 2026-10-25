# ZCode Community Retry（非官方）

独立的 ZCode 社区自动重试扩展，包含普通插件和配套 Agent 加载器。插件提供配置、状态查询；加载器处理模型请求。仅安装或在市场打开插件开关，不代表原生聊天已启用自动重试。

需要 Windows、Node.js 22+ 和兼容 ZCode。已用本机 ZCode 3.16.x 的桌面 CLI、zcode-app-cli 3.16.3-39 连接隔离模拟上游验证。其他版本先运行兼容测试。原生桌面窗口的完整操作验收状态见交付报告。

## 安装插件

解压独立安装包后，在 ZCode 插件市场添加该目录作为本地市场，安装并启用 `zcode-community-retry@tangyixiao-zcode-community`。该目录同时包含 marketplace.json 和 .zcode-plugin/plugin.json。本仓库源码的插件根目录为 community/。

新会话中使用 `/retry-status`，或让 Agent 调用 `retry_status`。工具返回插件实际的 `dataDirectory` 和 `launcher`。`retry_configure` 支持修改 maxRetries、baseDelayMs、maxDelayMs、backoffFactor、jitter、budgetMs、probeTimeoutMs、allowedOrigins 及缓冲上限。配置在下一次 Agent 启动时生效。

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

默认最多额外重试 6 次，初始等待 5 秒，指数退避上限 60 秒并加入抖动；每个模型请求的恢复预算为 10 分钟。服务端有效等待时间最多接受 5 分钟，超出剩余预算就结束。取消、显式禁止重试、认证失败、1113、套餐权限和长期额度错误直接返回。

仅在尚未交付文本、推理或工具调用时重试。流已经开始产生有效输出后断开，保留原错误。模块不重新提交整个会话，也不重复执行工具。

默认管理 zcode.z.ai、api.z.ai 和 open.bigmodel.cn 的 POST messages、chat/completions、responses 请求；自定义模型服务须在 allowedOrigins 显式添加 HTTPS origin 或 HTTP loopback origin。受管理请求拒绝重定向，避免重试流向未批准目的地。其他网络请求使用原传输。

请求体复制上限 16 MiB，SSE 探测上限 256 KiB，探测超时 30 秒。无法安全复制或无法识别的流直接交回原流程。原生模型重试在加载器内设为 0，社区模块拥有唯一预算。运行时状态保存安全元数据，不保存令牌、提示词或响应正文。

## DSH 可选接入

新版 dsh-zcode-plan-bridge 中启用 `communityRetry.enabled: true`。桥接包内含同版本模块，不需要另装本插件即可启动；独立 ZCode 插件仍可单独使用。开启时同时关闭 DSH 的外层自动重试；关闭时恢复桥接原重试配置。

## 验证与源码

从仓库根运行 `node --test test/community-*.test.mjs`。真实 CLI 测试只使用本地模拟服务与隔离配置，不需要真实账号；本机没有 CLI 时设置 `ZCODE_TEST_CLI`。桌面 UI、真实账号和模拟故障是不同证据，不能相互替代。

源代码与问题反馈：https://github.com/tangyixiao/dsh-zcode-plan-bridge 。AGPL-3.0 许可证。此组件与 ZCode 官方没有从属关系，不保证重试后服务端一定释放并发额度。
