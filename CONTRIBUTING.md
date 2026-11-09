# Contributing / 参与贡献

Use [Issues](https://github.com/tangyixiao/dsh-zcode-plan-bridge/issues) for reproducible defects or agreed work and [Discussions](https://github.com/tangyixiao/dsh-zcode-plan-bridge/discussions) for questions and ideas. English and Chinese contributions are welcome. Follow the account [code of conduct](https://github.com/tangyixiao/.github/blob/main/CODE_OF_CONDUCT.md) and [AI accountability policy](https://github.com/tangyixiao/.github/blob/main/AI_POLICY.md).

## Check a change

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
node tools/check-repository.mjs
```

Work from the repository root. Reuse dependencies when compatible; a fresh dependency installation is not required for every documentation change. Describe the concrete behavior, compatibility and evidence in a scoped PR. An AI-generated change still needs human accountability and meaningful review. Never submit credentials, full private logs, account files or proprietary conversation content.

Keep useful technical guidance in docs, English/Chinese README entry pages aligned, and the existing software/upstream/artwork licenses intact. See [maintenance](docs/maintenance.md) and [AGENTS.md](AGENTS.md) for resource budgets and cleanup.
