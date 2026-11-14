# dsh-zcode-plan-bridge 0.6.2

## 简体中文

- 适配 DeepSeek Harness 0.2.2-rc.3，保留原有宿主版本的兼容声明。
- 使用 rc.3 的实际宿主与客户端接口检查，并执行现有离线测试和发布包检查。
- 本次兼容性更新不等同于真实上游模型推理验收。稳定与预览渠道分别发布，预览功能不自动进入稳定渠道。

## English

- Qualify DeepSeek Harness 0.2.2-rc.3 while preserving previously declared host compatibility.
- Check against rc.3 host/client interfaces, existing offline suites, and the packaged release.
- Compatibility qualification does not establish successful upstream model generation. Stable and preview channels remain separate.

- 错误分类迁移为 rc.3 的 INVALID_CONFIG、INVALID_RESPONSE 和 UNKNOWN；配置或权限确认失败时保持停止，原有限流重试行为不变。
- Migrate errors to rc.3 canonical INVALID_CONFIG, INVALID_RESPONSE and UNKNOWN codes; configuration/permission failures stop before generation and rate-limit retry behavior is retained.
