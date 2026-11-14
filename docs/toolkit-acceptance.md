# Toolkit acceptance / 工具箱验收

Candidate: **0.6.2-toolkit.3**, 2026-11-14, Windows x64. This record is updated with concrete outcomes; an unlisted or pending boundary is not accepted.

| Boundary | Evidence |
| --- | --- |
| Design | Human approved the scoped native toolkit design; retained under `docs/superpowers/specs/`. |
| Local source | Initial full offline suite: 240/240 passed. Independent review reproduced paused-abort accounting and rejected-effort issues; three added regression tests failed before the fixes and passed afterward. Final integrated checks follow below. |
| Dependencies | Existing runtime/cache reused; no new third-party runtime package or bundler installation. Client uses host React through the existing module loader. |
| Native host discovery | Existing Desktop host reports `webServer`, `connection.admit`, plugin manager and `zcode-cli` registration. This is pre-install evidence, not proof of candidate activation. |
| Candidate installation/activation | Pending the exact packaged artifact and loaded-version check. |
| Visual and interaction | Pending actual host Chinese/English desktop/narrow inspection. |
| Native generation | Not run in this task; no new inference, media or check-in charge authorized as routine validation. |
| Wider platforms | No new macOS/Linux runtime validation in this task. |
| Public release/merge | Not authorized by this implementation request. Candidate and review PR are separate from npm/Release/market publication and merge. |
