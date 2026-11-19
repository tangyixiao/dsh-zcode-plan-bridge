# ZCode Plan Bridge 0.6.7

ZCode 提供方和账户工具箱可以在 DSH 0.2.2-rc.5 中加载。

- 在宿主与模型依赖声明中加入 rc.5，保留原有工具箱及配额错误处理。
- DSH 兼容范围为 `>=0.1.5 <0.3.0-0 || ^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1 || 0.2.2-rc.1 || 0.2.2-rc.3 || 0.2.2-rc.5`。
- 在 DSH rc.5 Web 宿主检查了发布包的安装和只读入口。真实模型调用需要相应客户端账号和可用的上游服务。

[发行版本与安装方式](https://github.com/tangyixiao/dsh-zcode-plan-bridge/releases/tag/v0.6.7)
