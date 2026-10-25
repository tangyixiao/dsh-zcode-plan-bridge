---
description: 查看社区自动重试的配置、当前 Agent 和加载状态
---

调用 community-retry MCP 的 retry_status 工具，向用户报告配置、当前 Agent PID 和仍在运行的加载器。已安装不能等同于已启用，存在已加载进程不能等同于本次对话已接入。需要启动时，使用结果中的 launcher 路径并把 dataDirectory 传给 --data-dir；先让用户结束任务并退出 ZCode，禁止自动关闭应用。用户要求修改重试次数或等待时间时，调用 retry_configure；说明配置在下次创建 Agent 时生效。不要发送“继续”来模拟自动重试。
