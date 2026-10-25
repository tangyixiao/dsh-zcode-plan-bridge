---
description: 查看社区自动重试的配置、当前 Agent 和原生插件接入状态
---

调用 community-retry MCP 的 retry_status 工具，报告版本、config、currentAgentPid 和 desktopIntegration。只有 desktopIntegration.active 为 true 才说明当前核验的桌面 Agent 已接入；顶层 active 可能属于其他 Agent。当前原生插件支持 Windows ZCode 3.16.x 的用户范围安装和无限重试。间隔优先在插件设置「重试间隔（秒）」修改；不要建议已撤回的外部启动器。如果未接入，准确报告 reason，提示检查版本、启用状态或待现有任务结束后正常重开应用，不得把安装成功当成运行成功。
