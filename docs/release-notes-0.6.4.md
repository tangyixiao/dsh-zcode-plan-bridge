# dsh-zcode-plan-bridge 0.6.4

## 简体中文

- 会话标题请求不再截取提示词前 24 个字符并伪报成功，改为通过实际模型生成摘要。
- 标题使用独立临时原生会话，结束或失败后关闭，不复用主聊天会话。
- 标题输入不附加普通代理的桥接工具指令；原版标题服务继续管理输入上限、超时和旧标题重新生成。
- 标题请求现在可能使用模型额度；模型账户或原生运行时不可用时仍可能失败，不将源码/协议测试视为实际推理成功。

## English

- Replace the fabricated 24-character prompt-prefix title response with a real model request.
- Isolate title generation in a disposable native session and close it on settlement without reusing the main conversation.
- Omit ordinary agent bridge/tool instructions from title input. The original host title service retains input, timeout and regeneration policy.
- Title generation may use model quota and can fail when the account or native runtime is unavailable. Source/protocol validation does not imply successful live inference.
