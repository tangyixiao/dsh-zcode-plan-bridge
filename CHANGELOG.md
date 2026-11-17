# Changelog

## 0.6.4

- Explicitly apply the host's synchronous `connection.requestRejection(req)` contract before toolkit owner admission, request-body reads, state reads or account/runtime actions. Only `undefined` passes; `401` / `403` reject, and missing, throwing or invalid checks fail closed. Promise/thenable results are denied and their rejections consumed.
- Preserve owner authorization, method and same-origin checks, bounded JSON, the process control key, scope/revision protection and authenticated Desktop forwarding without Origin.
- Add registration-level rejection/order/lifecycle regressions and keep the HTTP and existing toolkit protection tests.

工具箱先执行宿主公共准入检查；只有同步返回 `undefined` 才继续。缺少检查、异常和无效返回均拒绝，保留现有主人身份、同源、密钥、scope/revision 与 Desktop 转发保护。
