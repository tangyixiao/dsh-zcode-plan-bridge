# Changelog

## 0.6.8

- Continue the current DSH task by default after confirmed quota exhaustion when independent account rotation is enabled. The bridge waits for native background work to drain and starts a new request with a checkpoint on the next eligible account.
- Keep explicit `resumeOnQuotaExhaustion: false`, shared-mode next-request rotation, cancellation and the unchanged-input replay guard.

## 0.6.7

- Qualify the provider and toolkit on DSH 0.2.2-rc.5 and include the exact host release in the DSH engine and model peer ranges.

## 0.6.6

- Recognize the observed Start Plan quota error `1005` / `exceed quota limit` when native attribution identifies `account:zai-start-plan`, so the next new request can rotate to another saved account after quota exhaustion.
- Preserve structured `1113` support, ordered account selection, restart persistence and failed-request replay protection. Other `1005` messages/routes, cancellation, context overflow and ordinary HTTP limits do not trigger rotation.

## 0.6.5

- Generate actual session summaries in disposable native sessions instead of returning a fabricated 24-character prompt-prefix result.
- Preserve the main conversation session and close auxiliary native sessions on settlement.
- Retain the full 0.6.4 toolkit host/owner admission protections.

## 0.6.4

- Explicitly apply the host's synchronous `connection.requestRejection(req)` contract before toolkit owner admission, request-body reads, state reads or account/runtime actions. Only `undefined` passes; `401` / `403` reject, and missing, throwing or invalid checks fail closed. Promise/thenable results are denied and their rejections consumed.
- Preserve owner authorization, method and same-origin checks, bounded JSON, the process control key, scope/revision protection and authenticated Desktop forwarding without Origin.
- Reject malformed or asynchronous owner admissions and throwing identity access before body reads or toolkit work; consume rejected async admissions.
- Add registration-level rejection/order/lifecycle regressions and keep the HTTP and existing toolkit protection tests.

工具箱先执行宿主公共准入检查；只有同步返回 `undefined` 才继续。缺少检查、异常和无效返回均拒绝，保留现有主人身份、同源、密钥、scope/revision 与 Desktop 转发保护。
