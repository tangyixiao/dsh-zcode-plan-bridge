# ZCode Z·SWITCH Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the installed Z·SWITCH account manager for saved-account controls and add quota-only next-request rotation to DSH.

**Architecture:** A bounded, sanitized CLI adapter delegates account-library operations to Z·SWITCH. Independent mode uses OS-protected native working profiles for DSH; shared mode delegates the existing global switch. A credential-free policy controller binds admission, actions, exhaustion and no-replay decisions to the existing adapter and panel.

**Tech Stack:** Existing Node ESM, built-in child_process/fs/crypto, existing React host renderer and node:test; no new dependencies.

**Spec:** ../specs/2026-11-16-zcode-multi-account-design.md, especially the approved Z·SWITCH amendment.

## Global Constraints

- Reuse Z·SWITCH account store/CLI; no second credential vault or Rust/Tauri build.
- Independent mode is the default; shared mode also changes ZCode login. Never kill/restart Desktop or use --force.
- Only explicit structured provider error 1113 arms next-independent-request rotation.
- No automatic task replay, paid test generation, or automatic activity claiming.
- Keep source, offline/native probes, package/install/loading, CI and live use distinct.
- Scratch is D:/dsh-plugins/work/zcode-multi-account-20261116; preserve existing dirty design and toolkit branch/PR.

## Review Focus

1. CLI stdout/stderr may contain credentials or arbitrary paths: allowlist summary fields and fixed errors only.
2. Source account mutations race policy revisions: compare both the policy revision and source revision, including after awaited operations.
3. Paused/queued streams and cancellation must release admission without cross-account authentication.
4. CLI switching can partially succeed before failure: re-read actual state and invalidate old native state.
5. Outer retries must not replay identical failed input on another account; persist hashes and disable outer retry while enabled.

## Task 1: bounded Z·SWITCH adapter

Files: create lib/zswitch.js, test/zswitch.test.mjs.
Interface: `ZSwitchClient({path,run?}).state()`, `.command(action,{id?,name?})`, `.quota(id)`. Expose sanitized summaries plus private source revision/data root; no raw CLI output to browser.

- [ ] Write failing tests for summary redaction, invalid/unknown fields/IDs, failure sanitization, exact no-force/no-restart args, bounded runner, root mismatch, quota numbers/unknowns.
- [ ] Run `node --test test/zswitch.test.mjs`, verify missing feature failures.
- [ ] Implement with absolute-path discovery, execFile/no-shell, timeout/output limits and allowlisted JSON projections. Reuse upstream CLI contracts, no source copying needed.
- [ ] Run focused tests and typecheck; inspect real installed `state` only, summarize counts privately.

## Task 2: account policy and stream integration

Files: create lib/zswitch-accounts.js, lib/zswitch-profiles.js, test/zswitch-accounts.test.mjs, test/zswitch-profiles.test.mjs; modify lib/app-server.js, lib/index.js, lib/toolkit-runtime.js, lib/toolkit-route.js; extend tests. Reuse existing credential decoder/native keyring bindings and verify source/destination boundaries.
Interfaces: `ZSwitchAccounts({client,file,adapter,options}).state()`, `.action(action)`, `.prepare(request)`, `.failed(snapshot,evidence)`, `.enabled()`, `.dispose()`. `prepare` returns an account-generation snapshot; `failed` only records explicit quota evidence, never sends a request.

- [ ] Write/run failing tests for manual switch/CRUD, policy CAS/source revisions, pending/drain, 1113 allowlist, unchanged retry rejection, persistence, external switch invalidation, cancellation, exhaustion and model incompatibility.
- [ ] Implement bounded atomic metadata persistence, explicit CRUD forwarding, next-request selection, failure history and request digest blocking. Scope every decision to source account generation.
- [ ] Bind prepare/failure to `stream`, preserving cleanup/busy behavior; freeze Start Plan header scope and preserve provider attribution separately from displayed errors. Disable outer retries while rotation is enabled.
- [ ] Extend the existing owner-authenticated closed action parser and runtime state with safe account controls. Keep absent manager usable as a clear unavailable state.
- [ ] Run focused adapter/route/policy tests and typecheck.

## Task 3: existing panel and docs

Files: client/toolkit.js, generated lib/client.js, README.md, README.en.md, docs/toolkit.md, docs/zswitch-accounts.md; tests/toolkit-client.test.mjs and package version/lock.

- [ ] Add client tests for safe account actions and account state validation.
- [ ] Add existing-theme account rows, save/rename/update/delete/switch, manual quota refresh, primary/current/pending state, ordered rotation selection/reset and shared-login/no-replay copy in Chinese/English. New login uses Z·SWITCH Add flow.
- [ ] Build deterministic client; document reference commit/CLI commands, root compatibility, limitations and evidence. Bump preview version only.
- [ ] Run full offline suite, typecheck, build:client, repository check and diff check. Package once and inspect allowlisted contents.

## Task 4: review and delivery

- [ ] Request one independent whole-change review; fix actionable findings with regression tests.
- [ ] Create allowlisted commits and a scoped PR stacked on toolkit PR #22 if still open; attach the created PR.
- [ ] Install the verified candidate through the existing intended local plugin path/manager if supported, preserve unrelated files and verify actual loaded version separately. Never live-switch real accounts for testing without explicit need.
- [ ] Inspect and clean disposable task resources; retain only necessary package/reference/progress evidence and report material retained scratch.
