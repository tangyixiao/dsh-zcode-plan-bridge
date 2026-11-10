# ZCode Retry Keeper 0.1.1（非官方）

可选的用户范围配套插件。启用后，它在新建、恢复会话和提交提示词时检查当前 Windows ZCode Desktop 或 npm CLI Agent；如果 Community Retry 已关闭，Keeper 会恢复该宿主的 Retry 用户开关并为当前 Agent 接入重试。两个宿主的开关独立，需分别启用 Keeper。插件总开关关闭时不会自动打开，Keeper 也不会启用其他插件。

从仓库根市场安装 `zcode-community-retry@tangyixiao-zcode-community` 0.3.5 与 `zcode-retry-keeper@tangyixiao-zcode-community` 0.1.1。在两个宿主各自的插件配置中，将 Keeper 的“当前宿主的设置文件绑定”配置为该宿主实际使用的绝对设置路径；然后在 Keeper 的用户数据目录 `plugins/data/zcode-retry-keeper@tangyixiao-zcode-community/` 写入 `bindings.json`，内容为：

```json
{
  "version": 1,
  "desktop": "<Desktop 实际设置文件的绝对路径>",
  "cli": "<CLI 实际设置文件的绝对路径>"
}
```

将占位符替换为真实路径，JSON 中的 Windows 反斜杠需转义。两个文件必须位于当前用户插件存储的上一级，并与各自宿主的 Keeper 配置项自指一致。Keeper 根据真实直接父进程选择对应绑定，接入后还会与该父进程实际使用的设置路径核对，不根据文件是否存在猜测。无需配置的宿主可省略，但在该宿主首次接入失败且没有运行状态时，关闭 Keeper 后当前会话中的缓存 Hook 可能无法立即确认关闭状态。

关闭或卸载 Keeper 可撤销强制策略；随后可单独关闭 Retry。手动停止请求仍然有效。若调试端口已被占用，Keeper 不会断开原有调试器；无法验证新会话的接入时会阻止提交并给出提示。更新后需要新会话加载新的插件能力；不会主动结束现有聊天。

此插件依赖 ZCode 内部接口和可用的 Node.js 22+；现有回归测试覆盖 Windows Desktop、npm CLI app-server 与 CLI `-p` 的隔离本地模拟，普通交互式 TUI 尚未进行端到端验收。HTTP 405 等终止错误不会被改为无限重试。源码及反馈：https://github.com/tangyixiao/zcode-community-retry 。
