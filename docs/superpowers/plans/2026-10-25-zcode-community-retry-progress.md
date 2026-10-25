# Execution ledger — plan: 2026-10-25-zcode-community-retry.md

Spec approved by user: 按文档实施, 2026-10-25.

Execution: inline in the existing clean feature checkout fix/start-plan-routing; base d3f6ac2. The user directly authorized execution. Continue without another plan permission prompt.

Pre-flight: Task 1 exports configuration/transport/bootstrap consumed by Task 2 and Task 3; both use the same package under community/. Task 4 packages both and checks dependency resolution. No interface conflict found.

Ruling: Keep standalone code in a separately packable community/ package in the bridge repository — shares tested source without a new public repository or duplicate implementation — cost if wrong: package boundaries need adjustment, covered by clean-install tests.

Task 1: complete. Transport tests 18/18; real CLI fixtures 4/4 (npm success/exhaustion/1113 and desktop success), 22/22 combined. Observed exactly 3, 7, 1 and 3 physical requests respectively. No account credentials used. Fixed caller cancellation after response return with a reproducing RED→GREEN test.

Task 2: complete. MCP/config/launcher/bootstrap-state tests 4/4; ZCode plugins validate returned ok=true and no diagnostics. Desktop currently has running instances, so launcher must refuse rather than restart them.

Task 3: in progress. Bridge tests observed missing-module failure, then passed 3/3 with default-off, enabled loader, invalid config and running-child snapshot checks. Typecheck passed.
