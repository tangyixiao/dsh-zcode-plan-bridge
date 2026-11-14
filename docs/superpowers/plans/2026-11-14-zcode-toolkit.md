# ZCode Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved native ZCode management toolkit, diagnostics and local candidate installation.

**Architecture:** Preserve the app-server provider. An account-scoped settings store and bounded observations feed adapter controls, an authenticated host route and an additive DSH configuration panel. CLI shares the diagnostic projections and preference store; no second provider or credential migration.

**Tech Stack:** Node >=22, JavaScript ESM/checkJs, existing Cordis/DSH 0.2.2-rc.1 contracts, host React client loader, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-14-zcode-toolkit-design.md`

## Global Constraints

- Keep `zcode-cli`, existing permission defaults and community preview installations.
- Omit prompts, responses, credentials, raw upstream bodies and native session IDs from toolkit records.
- No invented model capabilities, billing values or live-inference claims.
- Reject stale account/revision writes and active-stream cache resets.
- Reuse checkout/dependencies; scratch lives in `D:/dsh-plugins/work/zcode-toolkit-20261114/`.
- User approved continuous execution; implement inline, then dispatch one fresh branch reviewer. Public publication and merge remain separate.

## Review Focus

- Credential rotation and channel changes must never reuse another account's sessions or preferences.
- Concurrent refresh/settings/cache operations must reject conflicting work rather than race an active generation.
- Missing upstream usage remains unknown; zero remains a legitimate observed value.
- Spoofed browser mutations, unauthenticated peers and oversized payloads must fail closed.
- A changed reasoning default must affect a reused native session; explicit request effort must win.

### Task 1: Scoped state and diagnostic projections

**Files:** Create `lib/toolkit-state.js`, `lib/toolkit-diagnostics.js`, `test/toolkit-state.test.mjs`; modify `lib/start-plan.js`.

**Interfaces:** `ToolkitSettingsStore(file).read(scope)` and `.update(scope, revision, patch)` provide atomic validated preferences; `accountScope(options)` returns an opaque credential-generation/channel key; `ObservationLog.record(scope, result)` and `.read(scope)` bound retention; `localStatus(options)` and `shareableStatus(status)` provide explicit allowlists. `fetchStartPlanStatus(builtin, dir, fetchImpl)` returns sanitized balance observations.

- [ ] Write/run failing tests: invalid settings, stale/concurrent revisions, channel/token isolation, bounded retention, absent/zero usage, error classification and credential/path redaction.
- [ ] Implement state and projections, keeping raw errors and identities private.
- [ ] Run `node --test test/toolkit-state.test.mjs`; expect all pass. Commit only task files.

### Task 2: Adapter controls and real request behavior

**Files:** Modify `lib/app-server.js`, `lib/index.js`; create `lib/toolkit-runtime.js`, `test/toolkit-adapter.test.mjs`.

**Interfaces:** Runtime provides `state()`, `action(action)` and `preferences()`; adapter provides `toolkitStatus()`, `refreshCatalog()` and `clearIdleCaches()`. Wrap real streaming for per-request observations. `resolveRoute(model, effort)` validates explicit/default efforts; visibility applies after pins/catalog selection.

- [ ] Write/run failing tests for pin/visibility precedence, all-hidden rejection, explicit/default effort on reused sessions, idle reset, queued streams and account transitions.
- [ ] Integrate preferences with the adapter and runtime lifecycle; use current options with recorded launch identity; never switch a live child under an active request.
- [ ] Run focused adapter tests and existing catalog/stream/session/abort suites; expect pass. Commit task files.

### Task 3: Authenticated host route and CLI

**Files:** Create `lib/toolkit-route.js`, `test/toolkit-route.test.mjs`, `test/toolkit-cli.test.mjs`; modify `lib/index.js`, `lib/diagnostics.js`.

**Interfaces:** `registerToolkitRoute(ctx, runtime)` registers only with webServer/connection services. GET returns sanitized state and process control key. POST requires owner admission, exact same origin, JSON, <=16 KiB, closed actions and current scope/revision. CLI adds status/capabilities/doctor --share without starting generation.

- [ ] Write/run failing tests covering missing/non-owner admission, malicious Origin, key, body limits, invalid actions, JSON-only CLI output and report redaction.
- [ ] Implement route and CLI dispatch; retain existing commands and optional host degradation.
- [ ] Run focused route/CLI plus existing host/diagnostic tests; expect pass. Commit task files.

### Task 4: Additive DSH client panel

**Files:** Create `client/toolkit.js`, `tools/build-client.mjs`, `test/toolkit-client.test.mjs`; generate `lib/client.js`; modify `package.json`, `tsconfig.json` if necessary.

**Interfaces:** Host `window.__ModuleLoader__.load` registers the package's client factory; `apply(ctx)` injects the existing `plugins.bundle.config` slot. React panel consumes Task 3 state and action route; no Node or private service import in browser bundle.

- [ ] Write/run failing tests for loader/slot registration, Chinese/English controls, missing state/service failure, model/retry action construction and safe text rendering.
- [ ] Implement native-theme responsive panel: status/plans, models, Retry, idle caches, observations, diagnostics and existing permission policy. Show refresh/pending/error states with accessible labels.
- [ ] Build with `node tools/build-client.mjs`; run client tests, typecheck and package-list inspection; expect pass. Commit task files.

### Task 5: Qualification, installation and reviewable delivery

**Files:** Update both READMEs, both guides, package version/lock and toolkit acceptance record; retain source spec/plan.

- [ ] Run offline suite, typecheck and repository check; inspect the exact package list and candidate hash.
- [ ] Dispatch a fresh reviewer over the complete branch/spec/plan and fix material findings with focused regressions.
- [ ] Inspect intended local installations and runtime, prepare plugin-scoped rollback, install candidate without overwriting community preview or unrelated files; verify package bytes and actual loaded version independently.
- [ ] Inspect actual panel at desktop/narrow widths and both locales where host/browser access allows. Record unavailable evidence precisely.
- [ ] Create scoped commits and PR; attach PR. Record CI separately. Clean disposable task scratch/processes after checking ownership; retain only artifact/rollback/evidence needed for review or recovery.

## Self-review and execution record

Tasks 2–4 consume the scoped settings and sanitized state defined in Task 1; Task 3 owns action validation; Task 4 uses only those actions. Task 5 validates their integrated package. Native generation, account migration and unverified media/check-in protocols are excluded by the approved spec. Progress, rulings, commands and owned resources are tracked in the task's scratch `progress.md`.
