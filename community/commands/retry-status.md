---
description: 查看社区自动重试的配置、当前 Agent 和加载状态
---

调用 community-retry MCP 的 retry_status 工具，报告 CLI/DSH 配置与运行状态。明确说明：原生 ZCode 主会话自动重试插件尚未实现；安装此工具不会接管原生会话。外部 Agent 启动方案已因存储准备不兼容撤回，不得建议外部启动器或声称仅启用插件即可自动重试。配置工具只服务已实际接入的 CLI/DSH 运行时。
