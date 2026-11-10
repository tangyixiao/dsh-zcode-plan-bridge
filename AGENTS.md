# Repository work

Preserve unrelated dirty files, credentials, local accounts and preview installations. Inspect current branch, HEAD and diff before editing or committing. Stage only intended paths. This repository's license and upstream notices remain authoritative.

## Resource use and cleanup

- Reuse the existing checkout, runtime and dependency cache before creating copies or installing tools.
- Keep task scratch in one task-owned `work/` namespace and useful deliverables in their project locations. Record owned paths and processes once, and reconcile them after interruption.
- Before large downloads, extraction, backups or builds, inspect the target volume and peak copies. Retain 10 GiB free. Review ordinary temporary growth at 1 GiB and limit optional expansion to 2 GiB unless the authorized task has a reasoned budget.
- Run one heavy local build, test, media or compression job at a time. Keep ordinary diagnostic logs below 20 MiB. Stop unneeded task-owned servers and child processes at completion.
- Before deleting scratch, verify its resolved boundary, reparse points, active consumers and recovery needs. Never purge unrelated caches, directories, credentials or releases, and never use reset/clean/force-push to hide unrelated work.

## Validation and delivery

Run `node tools/check-repository.mjs` plus the relevant commands in CONTRIBUTING.md. Keep source, local checks, CI, merge, registry publication, deployment and actual runtime use separate. A green catalog or a local account file does not prove live inference. Do not create empty releases or fake progress, stars or compatibility claims.

Keep English/Chinese README entry pages consistent. Readme feature cards are descriptive diagrams, not application screenshots. Preserve artwork attribution and separate artwork terms from software licenses. For a new website or substantial redesign, inspect real references, present a visual overview and obtain explicit selection before implementation; routine fixes within an approved direction continue directly.

## Dependency update attribution

Follow [the dependency update and co-authorship procedure](CONTRIBUTING.md#dependency-updates-and-co-authorship--依赖更新与联合署名) for Dependabot PRs. Record actual maintainer participation, verify GitHub-linked contributor emails, preserve valid author/co-author credit in the final squash message, and read back the merged commit on the default branch. Keep checks, merge, attribution, contribution-graph visibility and achievements distinct. This procedure does not authorize automatic merging or history rewrites.
