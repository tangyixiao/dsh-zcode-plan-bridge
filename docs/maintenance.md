# Maintenance, releases and resources

[ZCode Plan Bridge](../README.md) adopts the [Tangyixiao Open Source Standard](https://github.com/tangyixiao/.github/blob/main/docs/standard.md) with project-specific choices in [.github/toss.json](../.github/toss.json).

## Maintenance path

- Weekly Dependabot updates are grouped for compatible minor/patch changes and limited to two open PRs per ecosystem. Major updates remain reviewable; no automatic merge or inactivity-based issue closure is configured.
- PR triage reads metadata and changed paths through the GitHub API. It does not check out PR code, run package scripts or access release credentials.
- Existing runtime checks remain separate from the repository/documentation checker. Action references are pinned, test jobs have timeouts and stale checks can cancel. Market deployment retains serialized publication.
- Labels, Discussions, private reporting, topics, security settings and branch rules are platform state. Their source files alone do not prove they are enabled or that a bot has run.

## Release and distribution

The actual delivery type is **npm**. Keep stable and preview versions distinct. Before publishing, verify the exact source, tests, package file list, runtime entries, version, license and notices. Then independently verify the registry/Release artifact, hashes, installation and activation where applicable. Do not publish an empty GitHub Package, container or application just to fill a feature.

Use existing release credentials and processes; this baseline does not provision new registry credentials or trusted-publisher access. Generated release-note categories are in [release.yml](../.github/release.yml). Describe upgrade, uninstall and recovery limits in the detailed guide. Restoring source or a version does not necessarily restore account/configuration state.

## Storage and cleanup

Reuse checkouts, dependencies and caches. Keep one task-owned scratch namespace, at least 10 GiB free, a 1 GiB growth review point, a 2 GiB ordinary optional-growth budget, one heavy local job and logs below 20 MiB. Explain a legitimate larger task budget before expansion. These are working agreements, not OS quotas.

Stop task-owned servers/watchers at completion. Check ownership, resolved paths, links, active consumers, ignored needed files and unique commits before removal. Do not delete unrelated work or shared caches. Bound CI diagnostic artifacts (normally 7 days); repository Actions retention is intended to be 14 days. Releases are durable deliverables and are not deleted by that policy.

## Documentation, privacy and project identity

The README is the user entry point; detailed guides preserve operational and compatibility detail. Feature cards describe real workflows and are not screenshots or progress measurements. Stars and Star History are external service-generated data and may be cached or unavailable; ordinary repository links remain usable.

Versioned documentation is authoritative; existing Wiki material is preserved rather than duplicated. Open issues and actual releases are the roadmap/status evidence. Do not create invented percentages, deadlines, sponsor destinations, product endorsements or security certifications. Asset licenses and attribution are separate from the original software license.
