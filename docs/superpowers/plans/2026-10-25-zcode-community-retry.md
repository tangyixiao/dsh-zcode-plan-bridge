# ZCode Community Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an independent ZCode community retry plugin and optional use from the existing DSH bridge.

**Architecture:** A dependency-free package under community/ contains the retry transport, a CLI bootstrap, plugin configuration/status tools, and a Windows desktop launcher. The bridge imports the same package's configuration and launches its bootstrap only when enabled. The original CLI continues to own sessions and tools.

**Tech Stack:** Node.js 22+, JavaScript ESM/CJS, node:test, Web Streams, PowerShell.

**Spec:** ../specs/2026-10-25-zcode-community-retry-design.md

## Global Constraints

- Independent identity: zcode-community-retry; Windows local support first; explicitly unofficial.
- Default extra retries 6; base delay 5000 ms; factor 2; local cap 60000 ms; jitter; budget 600000 ms.
- Request copy cap 16 MiB; SSE probe cap 256 KiB; provider wait cap 300000 ms.
- Terminal business failures override HTTP status; cancellation always stops; no retry after output commitment.
- No program package edits, global environment writes, credential persistence, npm publication or PR merge.
- Preserve active desktop tasks. Actual desktop restart needs an idle application or a user-managed restart.

## Review Focus

- Redirects and arbitrary network URLs must not expand which requests the transport retries.
- SDK retry loops and outer bridge retries must not multiply the request budget.
- UTF-8 and SSE chunk boundaries must preserve the exact returned bytes.
- Cancellation during probe or backoff must close streams and never trigger a later request.
- Plugin installation, a launcher existing, and a running Agent loading it are distinct states.

### Task 1: Retry transport and real-CLI feasibility

**Files:** community/runtime/{config,policy,probe,retry-fetch}.mjs; community/bin/agent.cjs; test/community-retry.test.mjs; test/community-cli.test.mjs.

**Interfaces:** resolveConfig(raw) returns validated defaults; createRetryFetch(fetch, config, options) returns a fetch-compatible function; agent.cjs --cli <bundle> <original arguments> installs the transport and executes the original bundle.

- [ ] Write failing tests for failed-failed-success, exact exhaustion, terminal business errors, header precedence, cancellation, streamed error before output, output followed by error, byte preservation, buffer limits, unsupported bodies and URL scoping.
- [ ] Run node --test test/community-retry.test.mjs and observe missing-module failure.
- [ ] Implement config/policy/probe/transport with injected clocks or zero-delay fixtures, bounded cleanup and metadata-only status.
- [ ] Run the suite; expected all passing, including seven physical calls at exhaustion.
- [ ] Write and run a failing real-CLI fixture using an isolated config and a local mock model endpoint. Implement bootstrap and capability checks; expected real CLI returns the fixture reply after three requests, with native retry disabled.
- [ ] Verify both desktop and npm CLI capability independently; fail explicitly for unsupported builds. Commit tested files.

### Task 2: Standalone plugin and desktop launcher

**Files:** community/package.json; community/.zcode-plugin/plugin.json; community/.mcp.json; community/commands/retry-status.md; community/bin/{tools,launch-desktop}.mjs; community/runtime/state.mjs; community/README.md; community/marketplace.json; test/community-plugin.test.mjs.

**Interfaces:** tools.mjs serves MCP initialize/tools/list/tools/call on stdio; status reports installed/configured/live runtime states; configure accepts validated policy fields only. launch-desktop.mjs constructs ZCODE_AGENT_SERVER_COMMAND and ZCODE_AGENT_SERVER_ARGS_JSON for a single launched process and rejects an existing desktop instance.

- [ ] Write failing MCP tests for validated configuration, atomic writes, status freshness and stdout protocol isolation; launcher tests assert existing-instance refusal and argv quoting.
- [ ] Run node --test test/community-plugin.test.mjs; implement package, tools, commands and launcher; rerun until passing.
- [ ] Validate manifest through actual ZCode plugins validate, package with npm pack and inspect included files. Commit.

### Task 3: DSH opt-in

**Files:** lib/index.js; lib/app-server.js; lib/community-retry.js; lib/diagnostics.js; package.json; README.md; test/community-bridge.test.mjs.

**Interfaces:** resolveCommunityRetry(raw) provides defaults and validation; communityLaunch(options) provides argv/env for bootstrap; providerRetryPolicy disables outer retries only for an active community-managed child.

- [ ] Write failing tests asserting off-by-default, explicit enabled launch, rejection of invalid config, no outer retries, and turn-safe configuration snapshots.
- [ ] Run node --test test/community-bridge.test.mjs; implement schema and integration; rerun until passing.
- [ ] Run npm test, npm run typecheck, git diff --check. Commit feature files and documentation.

### Task 4: Delivery and final review

**Files:** outputs contain standalone and bridge tarballs, SHA256SUMS, installation instructions and an evidence report. Source progress is recorded in docs/superpowers/plans/2026-10-25-zcode-community-retry-progress.md.

- [ ] Run full tests once after final source changes and record runtime fixture results separately from actual account tests.
- [ ] Review the full change independently; address correctness findings with reproducing tests.
- [ ] Package both components, verify clean-install module resolution and original-entry recovery. Validate real bridge off/on without interrupting an active desktop task.
- [ ] Upload scoped commits to the existing authorized GitHub feature branch; update its draft PR and attach it. Never upload account state or diagnostic credentials.
- [ ] Copy user-facing artifacts to the session outputs directory. Mark unperformed desktop restart/UI checks explicitly; do not claim desktop activation from static checks.
