# ZCode toolkit design / ZCode 工具箱设计

Status: approved by the human on 2026-11-14: “对 开始做吧”. Implementation proceeds on `feat/zcode-toolkit`.

## Intent and current evidence

The user asked to add more features to the ZCode DSH plugin, comparable to the WorkBuddy plugin. On 2026-11-14 the existing ZCode checkout is clean at `e063abc` (0.6.1), equal to fetched `origin/main`. The WorkBuddy reference is the local `feat/workbuddy-complete-toolkit` source at `99488cc` (0.1.19 candidate), which is not evidence of a published or fully accepted toolkit.

ZCode already implements account-backed app-server streaming, image input, per-session reuse, CLI-reported model capabilities, Start Plan entitlement filtering, cancellation and optional community Retry. Its UI currently consists of schema configuration; it has no WorkBuddy-style client entry. Existing diagnostics include doctor, models, protocol, turn and image. Existing balance code reads Start Plan authorization but only returns eligible model IDs. Existing stream events expose token usage and upstream failure attribution.

## Approaches

1. **Recommended: native ZCode toolkit.** Keep the existing app-server adapter and provider ID; add a host-backed management panel, settings and sanitized observations around it. Reuse the host integration patterns from WorkBuddy while implementing independent ZCode account and protocol logic. This preserves current sessions and avoids a second provider stack.
2. **Diagnostics-only expansion.** Add CLI commands and reports without a client panel. This has fewer host dependencies but leaves everyday controls outside DSH and only partly meets the WorkBuddy comparison.
3. **Full WorkBuddy feature parity.** Port saved accounts, automatic rotation, check-in, media generation and compaction immediately. The inspected ZCode source does not establish the required protocol or host contracts for every feature. Do not select this approach without an evidence-backed follow-on design.

Approach 1 was recommended by the builder and selected by the human's approval.

## Proposed functionality

| Group | User-visible behavior | Source and acceptance boundary |
| --- | --- | --- |
| Status and plans | Show plugin/kernel version, runtime state, current configured subscription channel, local credential readability, and available capabilities. A manual Start Plan refresh shows only fields actually returned by the existing balance endpoint, with observation time. | Credential readability is distinct from remote authentication and inference. Missing values stay unknown. Coding Plan and Start Plan remain separate. No raw tokens, device IDs, account files or unrestricted upstream bodies reach the browser. |
| Model controls | Refresh the CLI catalog; show image support, context/output limits and declared reasoning levels; allow model visibility and a validated default reasoning preference per account/channel and model. | Existing `cliModels` pins remain the source of advertised entries when configured; otherwise use the discovered catalog. Apply visibility afterward to either source, and reject mutations leaving no selectable models. Explicit request choices win. Do not invent reasoning levels or enlarge declared context/output limits. Inspect the host model-options contract before wiring new overrides. Catalog refresh sends no generation request. |
| Sessions and Retry | Show bounded aggregate active/cached session counts and Retry settings/status; allow applying validated Retry settings and clearing idle bridge session/catalog caches. | Never expose conversation text or native session identifiers. Refuse destructive cache operations while streams or queued requests exist. Do not dispose the whole adapter as a shortcut. Changing account/channel or runtime options must invalidate stale account-bound state safely. |
| Usage and failures | Show bounded per-request token observations and recent classified failures, including authentication, entitlement/quota, throttling, edge/channel, timeout and cancellation. | Unknown usage is not zero observed consumption. Report credit only if an authoritative field is actually available; never infer money from tokens. HTTP 405/HTML edge failures do not imply a needed top-up. Observations have account/channel scope and bounded retention; no prompt/response content is recorded. |
| Shareable diagnostics | Add `status`, `capabilities` and `doctor --share`, with machine-readable output suitable for bug reports. Keep existing commands compatible. | Shareable reports use an allowlist and omit user paths, machine/account identifiers, secrets and arbitrary exception messages. Reports explicitly retain `inference: not-tested` unless a generation test was actually run. Correct existing documentation that calls app-server catalog inspection fully offline. |
| Native tools and extensions | Expose the existing `authorizationPolicy` choices (`deny` / `allow-all`), explain unattended tool execution beside `allow-all`, and show actual host capability availability. | Preserve the `deny` default; this phase does not add granular tool rules or host approval. Host-approval integration, saved credentials, rotation, CLI review jobs, check-in, video/image generation and compaction are separate extensions until their actual ZCode/host contracts are inspected. Image input remains supported and is distinct from image generation. Do not ship buttons that imply unavailable operations. |

## Management panel

Use the existing DSH plugin/configuration surface and native theme tokens. This is an additive plugin panel, with Chinese and English text, keyboard controls and a single-column narrow-screen arrangement. It is not a new website or a substantial website redesign.

```text
ZCode                         [refresh status]
Runtime / configured channel / credentials / observed at

Models                        [refresh catalog]
Model | image | context | reasoning | visibility/default

Sessions and Retry
Active / cached | Retry mode / limits | [clear idle cache]

Recent usage and failures
Observed tokens / result category / observation time

Diagnostics                   [copy shareable report]
```

Schema-only and CLI use continue to work when client services are absent. Disable only controls whose required host services are missing, and explain that state. Verify any plugin-card/config-page registration against installed DSH 0.2.2-rc.1 APIs; do not widen compatibility ranges without supporting evidence.

## Architecture and constraints

- Keep JavaScript ESM with checked JSDoc and the existing package/provider identities. Add optional host/client dependencies only after inspecting the required APIs and compatible local caches.
- Separate the toolkit state/settings/observations from app-server transport. Provide narrow adapter methods for status, refresh and idle-cache operations; no browser-supplied RPC method, executable path or arbitrary shell command.
- Management requests require the host's authenticated owner/session contract, same-origin mutation checks, bounded input and explicit allowlisted actions. Do not copy loopback-only trust assumptions.
- Persist only preferences that require persistence. Use atomic writes and revision checks. Scope preferences and observations to an opaque account/channel identity, and reject stale mutations after account changes. No credential backup or desktop-auth rewrite in this scope.
- Apply settings through one authoritative source shared by host, client and CLI, with documented precedence. If a setting requires the next session/process, say so in the control and defer it safely while requests are active.
- Bound observation buffers and cache retention. Dispose listeners/routes/timers with the plugin. Reports must not retain prompts, responses, image paths, credentials or full upstream bodies.

## Validation and delivery

1. Add focused tests for settings validation, account/channel isolation, stale writes, report redaction, usage/error interpretation, optional host services and active-stream cache protection. Preserve current streaming, abort, Start Plan and Retry tests.
2. Run `npm run test:offline`, `npm run typecheck`, and `node tools/check-repository.mjs`. Use the existing dependency tree before installing anything. Run native suites only when their required local hosts are available and the suite does not perform unapproved generation.
3. Check the packaged file list and artifact version/hash, then install a local candidate into the intended existing installation using a recoverable plugin-scoped rollback. Preserve unrelated settings, accounts, plugins and community preview installations. Verify the actual loaded version separately from package files.
4. Visually inspect Chinese/English desktop and narrow layouts and functional states in the actual host when browser control is available. Record missing browser/runtime access as a limitation rather than claiming acceptance.
5. Deliver a scoped reviewable PR. Commit/push/CI, local install/activation, public registry/Release/markets, merge and live generation are separate states. This request alone does not authorize public publication or merge. No new paid generation/media/check-in is part of routine validation.

## Resource record and stop conditions

Reuse `D:\dsh-plugins\dsh-zcode-plan-bridge` and its dependencies. The design is the sole task-created file so far; no new process, server, installation or temporary copy exists. Retain this design as project documentation. If scratch becomes necessary, use `work/zcode-toolkit-20261114/` under the workspace and keep one record there. The D: volume had approximately 83 GiB free at inspection; retain at least 10 GiB and stay below the ordinary 2 GiB optional-growth limit.

The builder review found the design buildable and requested explicit model-pin/visibility precedence and an enumerated native-tool control; both clarifications are included above. No product code was changed during review.

During implementation, pause only an affected feature if it requires an undocumented protocol, unsupported host contract, credential migration, paid live action, or a different visual direction/scope. Continue independent work and report the specific missing evidence.
