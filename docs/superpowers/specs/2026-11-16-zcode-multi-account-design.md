# ZCode accounts with Z·SWITCH

Status: approved design, implemented in version 0.6.3.
Date: 2026-11-16

## Purpose

Provide saved-account controls and quota-exhaustion switching inside the existing DSH ZCode toolkit. Prioritize DSH execution: independent mode is the default; shared Desktop login remains an explicit alternative. Keep the existing zcode-cli model provider, streaming, images, retry controls and native tool policy.

Reuse the installed MIT-licensed pjpv/zcode-switch account library and CLI instead of another account manager, OAuth flow, export format or activity-claim implementation. Reference source commit: f34225686dfef05d84c256a56f868719248f15ff, particularly src-tauri/src/{cli,store,quota,probe,zcrypto}.rs.

## Approaches and selected design

- A second independent account vault would duplicate account storage, identity and login work. Do not build it.
- Only using Z·SWITCH's shared switch is simpler but changes Desktop login and does not prioritize DSH tasks. Offer it as shared mode.
- Reuse the same library for both modes, with separate native working profiles only where DSH isolation requires them. This is the selected implementation.

The account library remains authoritative for membership and explicit capture/update/rename/delete. DSH's native profiles are writable execution caches, with persistent native token refresh, rather than a second account manager. Source snapshots, original native keyring entries and Desktop login files stay untouched in independent mode.

## Existing contracts

The toolkit extends the current configuration panel and authenticated management route. Owner admission, same-origin checks, process control key, bounded JSON and setting/account revisions remain mandatory.

The current npm ZCode CLI supports private credentials and settings paths. The inspected Desktop bundle lacks those CLI overrides, so independent mode selects a verified compatible npm kernel rather than silently falling back to Desktop or shared switching.

Native v2 OS credential encryption binds its keyring identity to the original credential-file path. Decode a manager snapshot through the existing v1/v2 reader at that original path, then encrypt the separate native working profile. Do not copy ciphertext to a new path and assume it remains usable.

Native personal configuration and settings are writable. Isolate those files as well as the credential/data paths; reuse a compatible builtin release as a read input. No full installation copies or new runtime dependencies are needed.

## Modes and account operations

Independent mode changes only DSH's selected account. A dedicated plugin OS keyring entry protects native-compatible encrypted working credentials. The child receives its secret through a private environment, never command arguments, browser state, logs or a plaintext key file. Conflicting inherited path/secret/auth-mode variables are removed case-insensitively before applying the profile.

Shared mode delegates the existing Z·SWITCH switch command with --no-restart --hot true. Never pass --force, invoke kill, or force-close/restart ZCode. Confirm the manager and plugin refer to the same native credential root before a shared mutation.

Both modes reuse capture, rename, update, delete and quota commands. Capture explicitly saves the current ZCode login. New OAuth accounts are added through Z·SWITCH. Deleting the account currently used by DSH or Desktop is blocked, and deletion requires a UI confirmation. Changing modes pauses rotation and clears the current explicit selection; select an account again in the destination mode.

Persist only bounded policy metadata: mode, selection, member order, exhaustion, failed-request digests, revisions and fixed switch history. Browser actions use opaque IDs and labels, not tokens or arbitrary paths. CLI commands use execFile with no shell, hidden windows, bounded output and timeouts. IDs cannot start with a dash and labels cannot begin with two dashes, preventing the upstream CLI parser from interpreting account data as flags.

## Request admission and switching

Block account mutations while requests or catalog operations are active. Reserve account management while loading snapshots or switching; public catalog entrypoints cannot race a pending mutation. Newly admitted requests bind to their original account generation.

After a confirmed selection change, dispose the owned old native client and clear its session/catalog caches. Preserve DSH conversation history and create a fresh native session for the next request. Do not reuse native session IDs across accounts.

Hydrate persisted independent selection before status, catalog and plan access after restart. If hydration fails, keep follow/update/selection recovery controls readable while marking the account unavailable. A shared-login change during runtime-header retrieval stops the owned old agent before it can fall back to the new account's credential file. Native refresh inside a fixed private profile does not change its ownership.

Validate the selected account's real catalog and exact requested route before generation. If that account cannot serve the model or subscription channel, stop clearly instead of selecting another model or a paid route.

## Quota exhaustion policy

The optional ordered rotation policy defaults off. It requires an identifiable current saved account and explicit participant order. Independent remains the default switch scope.

Only structured providerErrorCode 1113 from a supported native Z.AI/BigModel account-plan route can mark exhaustion. Start Plan requires the Start Plan route. Preserve provider/model attribution internally. Arbitrary message text, custom/API routes, HTTP 429 alone, concurrency limits, login expiry, entitlement denial, timeouts, cancellation, transport errors and ESA HTML/405 never trigger rotation.

Finish the failed native-agent turn with its real result. After existing admission drains, the next independent request may select the next non-exhausted account. Status, quota, catalog and local title reads do not consume a pending rotation.

Never automatically replay session/send on another account: file writes or commands may already have happened before the quota failure. Disable DSH outer automatic retry while rotation is enabled, and persist only irreversible failed-request digests to reject an unchanged cross-account replay. New user input or an explicit account/reset action can proceed.

Remember confirmed exhaustion across restart. All participants exhausted produces a clear stop, not a loop; elapsed local time alone does not establish replenishment. Restore participation only through an explicit reset. Source-generation changes invalidate stale pending decisions. Validate enablement against the destination mode when changing scope.

## Storage boundaries and failure recovery

Bound account library state to 100 summaries and policy metadata to 64 KiB, including at most 32 blocked digests and 20 history entries. Use exclusive locks, atomic replacement and revision checks for policy writes.

Bound snapshot/working credential documents and preserve the consistent full native credential record. Native refresh can update the working copy; validate it can still be decrypted under the recovered protected key before reuse. Unknown/malformed encryption, corrupt token values or a changed/unavailable key fail closed. Never treat an inaccessible keyring read as a missing entry to overwrite.

Reject source-library links and all existing writable-profile symlink/junction ancestors and destinations before creating or replacing account material. Native source credential keys stay read-only. Shared commands can partially succeed before returning an error: reread actual manager state and invalidate stale DSH native state rather than assuming rollback.

## Interface

Extend the existing theme and Chinese/English panel with:

- Switch scope: Independent (default) or Shared.
- DSH serving account, primary account and current ZCode Desktop login.
- Save current ZCode login, select/follow, rename, update, delete and manual quota refresh.
- Ordered participation, optional automatic switching, pending state, confirmed exhaustion/reset and recent switch history.
- Explicit explanation that failed agent tasks are not automatically replayed.

No new website or substantial visual redesign is involved. Existing diagnostics remain local projections; shareable output excludes account IDs/labels, paths, credentials, conversation content and arbitrary manager/upstream errors. Existing Z·SWITCH CLI remains available for command-line account operations.

## Validation and evidence

Focused fixtures cover redaction, closed actions, CLI flags, modes, source/policy revisions, no replay, draining and cancellation, unknown current account, restart hydration, exhaustion persistence, model mismatch, native encryption/key failure and destination junctions.

The native compatibility probe uses only synthetic credentials, denies all network and sends no generation. It must create and close a real native session without changing protected Desktop files. Do not infer real-account refresh, inference or live failover from that probe.

Verify Chinese typography and wrapping at desktop and narrow widths using synthetic component state. Static preview evidence does not establish live host interaction. Run the offline suite, type checks, deterministic client build and repository checks; review the final diff and packaged file list.

Keep this change in a scoped branch/PR stacked on the existing toolkit while that PR remains open. Package, local installation, actual host loading, CI, merge, public release and real-account use are separate evidence. Use the Desktop application's manager for its exclusive profile; preserve its existing installation when that manager is unavailable.
