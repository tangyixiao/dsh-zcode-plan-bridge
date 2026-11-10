# Contributing / 参与贡献

Use [Issues](https://github.com/tangyixiao/dsh-zcode-plan-bridge/issues) for reproducible defects or agreed work and [Discussions](https://github.com/tangyixiao/dsh-zcode-plan-bridge/discussions) for questions and ideas. English and Chinese contributions are welcome. Follow the account [code of conduct](https://github.com/tangyixiao/.github/blob/main/CODE_OF_CONDUCT.md) and [AI accountability policy](https://github.com/tangyixiao/.github/blob/main/AI_POLICY.md).

## Check a change

```sh
npm ci --ignore-scripts
npm run test:offline
npm run typecheck
node tools/check-repository.mjs
```

Work from the repository root. Reuse dependencies when compatible; a fresh dependency installation is not required for every documentation change. Describe the concrete behavior, compatibility and evidence in a scoped PR. An AI-generated change still needs human accountability and meaningful review. Never submit credentials, full private logs, account files or proprietary conversation content.

Keep useful technical guidance in docs, English/Chinese README entry pages aligned, and the existing software/upstream/artwork licenses intact. See [maintenance](docs/maintenance.md) and [AGENTS.md](AGENTS.md) for resource budgets and cleanup.

## Dependency updates and co-authorship / 依赖更新与联合署名

Keep Dependabot as the source of its dependency update PR. Record the maintainer's actual review, validation and any fixes in the PR, and attribute authorship to actual contributions.

1. Check the exact PR head, dependency changes, compatibility and required CI before an authorized merge. A co-author trailer does not replace review or checks.
2. Verify each contributor's preferred GitHub-linked commit email from account or existing commit evidence. Use their GitHub noreply address when appropriate; do not guess an email or publish a private address.
3. When squashing a jointly authored update, inspect the final commit author and message before merging. Preserve valid existing `Co-authored-by: NAME <ACCOUNT_EMAIL>` trailers and include the participating maintainer and Dependabot as author or co-author as appropriate, without duplicating the primary author or an existing trailer.
4. After merging, read back the commit on the default branch and verify its SHA, author and co-author trailers. Report the actual merge and attribution separately from CI and contribution-graph visibility.
5. Commit credit depends on GitHub's account-email, repository and branch criteria. Do not promise a Pair Extraordinaire achievement for collaboration with a bot.

This is a review and merge procedure. It does not enable automatic merging, authorize unrelated dependency updates, or change existing commit history. Dependabot's configuration has no co-author option.

依赖更新保留 Dependabot 的来源和已有有效署名；维护者的审阅、验证及修正应有实际记录。联合完成的更新在 Squash 合并前核对作者与共同作者，使用已核实、关联账号的邮箱，避免重复署名；合并后回读默认分支上的 Commit，确认 SHA、作者和 `Co-authored-by`。贡献图与成就单独核验，不承诺机器人联合署名必定获得“豌豆荚”。本规则不启用自动合并，也不改写历史提交。

References: [GitHub co-authored commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors) · [Contribution criteria](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference#contribution-criteria-for-commits) · [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#commit-message)


Offline validation: `npm run test:offline`. `npm run test:native` retains the real CLI/Desktop kernel suites and requires the corresponding installed hosts; `npm run test:all` runs full discovery.
