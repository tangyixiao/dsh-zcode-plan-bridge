# Execution ledger — plan: 2026-10-25-zcode-community-retry.md

Spec approved by user: 按文档实施, 2026-10-25.

Execution: inline in the existing clean feature checkout fix/start-plan-routing; base d3f6ac2. The user directly authorized execution. Continue without another plan permission prompt.

Pre-flight: Task 1 exports configuration/transport/bootstrap consumed by Task 2 and Task 3; both use the same package under community/. Task 4 packages both and checks dependency resolution. No interface conflict found.

Ruling: Keep standalone code in a separately packable community/ package in the bridge repository — shares tested source without a new public repository or duplicate implementation — cost if wrong: package boundaries need adjustment, covered by clean-install tests.

Task 1: complete. Transport tests 18/18; real CLI fixtures 4/4 (npm success/exhaustion/1113 and desktop success), 22/22 combined. Observed exactly 3, 7, 1 and 3 physical requests respectively. No account credentials used. Fixed caller cancellation after response return with a reproducing RED→GREEN test.

Task 2: complete. MCP/config/launcher/bootstrap-state tests 4/4; ZCode plugins validate returned ok=true and no diagnostics. Desktop currently has running instances, so launcher must refuse rather than restart them.

Task 3: complete (093eff4). Bridge tests passed 3/3; full suite 67/67 and typecheck passed before final review.

Task 4: in progress. Independently reviewed by final_retry_review. Important findings: terminal code/type masking and valid unknown SSE shapes losing bytes. Regraded body-type preservation as Important because it changes a supported request on its first attempt. All findings reproduced RED before one fix pass.

Ruling: Preserve URLSearchParams type in the review fix pass — changing Content-Type can break a supported custom endpoint on the first request, so this is a correctness blocker rather than optional polish — cost if wrong: unnecessary small compatibility fix, covered by implicit/explicit header tests.

Live evidence: source bridge default-off catalog works; enabled loader and outer retries=0 verified, but real HTTP429 {code:3008,msg:user concurrency limit exceeded} was initially not retried because msg was ignored. A zero-retry diagnostic captured only safe shape fields; added exact-shape regression before correcting extraction. Never claim recovery from the first live result.

Final review rulings: managed redirects deliberately fail; runtime active is global to its data directory and current PID/owner must be checked; existing session lock recovery remains separate. Capability substrings are a preflight check, not a guarantee for untested releases. Desktop UI restart deferred while existing tasks run. Costs: redirected model endpoints require direct configuration; users must check current PID; unsupported releases need explicit verification; desktop activation remains unverified.

Final: fixed terminal signal precedence, unknown SSE shape passthrough, form Content-Type preservation, actual code3008/msg classification and prototype-key validation — regression tests observed RED→GREEN; affected transport suite 26/26, full suite 75/75, typecheck passed. No deferred minor findings remain after regrading form-body preservation as correctness.

Live follow-up: real Start Plan Flash short prompt returned OK on attempt 3 with maxAttempts 3, enabled loader=true and DSH outerRetries=0. Default-off catalog also passed. This verifies one actual failed-then-recovered short request, not long-task or desktop UI acceptance.

Installed DSH preflight: activeStreams=0 on existing zcode-cli adapter; old bridge still loaded before package delivery. Inspector closed and diagnostic globals removed immediately after this check.

Task 4: development/package delivery checks complete. Standalone plugin registered, installed and enabled through ZCode CLI; DSH tarball installed through Desktop-owned CLI. Existing dependency declarations other than this bridge stayed unchanged. Standalone source/archive validates with zero diagnostics; root marketplace registers successfully in an isolated profile. Fresh-process installed-package off/on catalog checks pass, with enabled loader=true and outerRetries=0. Actual DSH Desktop still caches old module despite a scoped idle reload; require normal restart. Actual ZCode Desktop launcher refuses existing instances as intended. Full UI restart/recovery acceptance is explicitly deferred, not counted as passed. Inspector closed (zero listeners).

User artifacts: independent TGZ and ZIP/local marketplace, bridge TGZ, SHA256SUMS, actual live/installed verification JSON, local desktop launcher, Chinese usage/acceptance report. Runtime artifacts built from 4223d54; later source changes are marketplace metadata and documentation only. No npm publish or PR merge.

## User correction: unlimited retries and configurable interval

User explicitly rejected the finite default. New binding scope: default unlimited mode, adjustable fixed interval, optional large bounded counts. No additional design approval needed for this direct correction.

Follow-up plan: RED regression tests for >500 attempts ignoring finite budgets, cancellation after 150 attempts, configurable exact interval, server-delay precedence and no hidden bridge deadline; implement mode/interval settings in shared module/MCP/DSH, update versions/docs, run real CLI local fixture with 25 failures then success, independently review, package/install and push the existing PR.

Progress: observed RED for missing mode/interval/deadline support, then 34/34 affected tests GREEN and typecheck pass. Full suite with additional real-CLI unlimited fixture in progress. Unlimited mode never starts a cumulative budget timer; DSH captures the running child mode before bypassing its turn deadline.

Independent focused review found the old five-minute Retry-After ceiling conflicted with unlimited mode. Reproduced with a ten-minute provider wait, plus an oversized platform timer test (both RED), then parameterized the ceiling and split long waits into cancellable safe timer chunks. Unlimited mode honors long provider waits; bounded mode retains its prior parser bound. No other blocking findings; no deferred minor findings.

Follow-up complete: full suite 83/83 GREEN; typecheck and native plugin/archive validation pass. Real npm CLI local fixture recovered on attempt 26 after 25 failures. Unit tests recovered on attempt 501 and manually cancelled after attempt150; no real-account load generation. Packaged standalone0.2.0 and bridge0.6.0-community.1, updated both local installations, saved standalone config mode=unlimited intervalMs=5000. Existing desktop tasks retained; new Agent/restart required for loaded code/config. User deliverables under outputs/zcode-community-retry-unlimited. Existing draft PR is updated; no merge/npm publication.
