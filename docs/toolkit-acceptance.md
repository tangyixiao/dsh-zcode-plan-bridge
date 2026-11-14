# Toolkit acceptance / 工具箱验收

Candidate: **0.6.2-toolkit.3**, 2026-11-14, Windows x64. This record is updated with concrete outcomes; an unlisted or pending boundary is not accepted.

| Boundary | Evidence |
| --- | --- |
| Design | Human approved the scoped native toolkit design; retained under `docs/superpowers/specs/`. |
| Local source | Final full offline suite **245/245 passed**; host and browser typechecks, deterministic client build, repository checks and `git diff --check` passed. Independent review reproduced paused-abort accounting and rejected-effort issues; three regression tests failed before the fixes and passed afterward. Empty-plan display and settings-without-catalog regressions also reproduced RED then passed GREEN. |
| Dependencies | Existing runtime/cache reused; no new third-party runtime package or bundler installation. Client uses host React through the existing module loader. |
| Native host discovery | Actual Desktop **DSH 0.2.2-rc.1** exposes `webServer`, `connection.admit`, plugin manager and `zcode-cli`. Existing kernel reports **3.17.1**. |
| Candidate installation/activation | Official active plugin manager returned **applied**, enabled, no warnings for **0.6.2-toolkit.3**. All **14 installed lib JavaScript files** match source. Actual adapter exposes the new methods, authenticated toolkit route is registered, and the real panel reports candidate .3. |
| Exact artifact | Packaged runtime source commit `407d02620faf7ff41f373beb8344fa5d8c816cab`; SHA-256 `69ddc2336e712e351f6e7c534669dc6eec2a04fb413820d34ae347f531657ef5`; 81 package files, about 1.2 MB compressed. The later acceptance documentation commit does not change installed runtime code. |
| Preservation | Only the desktop profile's zcode dependency changed. `cordis.yml`, `cordis.patch.yml` and `pnpm-workspace.yaml` match pre-install hashes after temporary language testing. Existing Start Plan, unlimited Retry interval and tool policy remain effective. Other profiles and community previews were not modified. Original plugin/manifests retained for rollback. |
| Visual and interaction | Actual-host Chinese/English inspection at **1280×900** and **390×844**; narrow document width equals viewport, with no overflowing toolkit inputs/selects/buttons. Real Retry save and restore completed without catalog access; all test overrides were reset. Diagnostic-copy control and unavailable/refresh states inspected. The original Chinese language was restored. |
| Current account/channel | Native read-only catalog discovery is **blocked by the existing Start Plan login-family guard**: current configured channel requires a signed-in Z.AI or BigModel account. No credentials were changed or channel switched. Available-model rendering against the current live account and successful generation remain unverified; this does not invalidate the separately tested fixture model/effort behavior. |
| Native generation | Not run in this task; no new inference, media or check-in charge authorized as routine validation. |
| Wider platforms | No new macOS/Linux runtime validation in this task. |
| Public release/merge | Not authorized by this implementation request. Candidate and review PR are separate from npm/Release/market publication and merge. |

Task evidence and plugin-scoped rollback are retained under `D:/dsh-plugins/work/zcode-toolkit-20261114/`. The installed local artifact is referenced from the desktop profile, under the user's `.dsh/packages/` directory. Task-only launch-token files and superseded candidate tarballs are removed during cleanup. No task-owned server or watcher is needed after validation.
