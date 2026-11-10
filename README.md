<p align="center"><img src="assets/logo.webp" width="192" height="192" alt="ZCode Plan Bridge logo"></p>

<h1 align="center">ZCode Plan Bridge</h1>

<p align="center">把 DSH 的模型请求交给本机已登录的 ZCode CLI，提供真实流式、图片和按账号读取的模型目录。</p>

<p align="center"><a href="https://github.com/tangyixiao/dsh-zcode-plan-bridge"><img src="docs/assets/banner-zh-CN.svg" width="100%" alt="ZCode Plan Bridge — 查看项目与使用说明"></a></p>

<p align="center"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

[![Stars](https://img.shields.io/github/stars/tangyixiao/dsh-zcode-plan-bridge?style=flat)](https://github.com/tangyixiao/dsh-zcode-plan-bridge/stargazers) [![CI](https://img.shields.io/github/actions/workflow/status/tangyixiao/dsh-zcode-plan-bridge/check.yml?branch=main)](https://github.com/tangyixiao/dsh-zcode-plan-bridge/actions/workflows/check.yml) [![License](https://img.shields.io/github/license/tangyixiao/dsh-zcode-plan-bridge)](LICENSE) [![npm](https://img.shields.io/npm/v/dsh-zcode-plan-bridge)](https://www.npmjs.com/package/dsh-zcode-plan-bridge)

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-1-zh-CN-dark.svg"><img src="docs/assets/feature-1-zh-CN-light.svg" width="260" alt="原生账号通道: 区分 Coding Plan 与 Start Plan"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-2-zh-CN-dark.svg"><img src="docs/assets/feature-2-zh-CN-light.svg" width="260" alt="流式与图片: 常驻 app-server 与会话复用"></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/feature-3-zh-CN-dark.svg"><img src="docs/assets/feature-3-zh-CN-light.svg" width="260" alt="动态模型目录: 按 CLI 与账号授权读取能力"></picture>
</p>

## 开始使用

Desktop：从发行页下载 `.tgz`，在“扩展 → 插件管理 → 添加插件”中安装。命令行示例用于你明确控制的 Web profile：

```sh
dsh plugin --profile web add dsh-zcode-plan-bridge@0.6.0
```

先在 ZCode CLI 完成登录；在 DSH 中选择 `ZCode CLI` 模型组。需要 Start Plan 时显式设置 `accountMode: start-plan`，不要把余额错误直接当成需要充值。

## 当前状态与兼容性

| 项目 | 当前依据 |
| --- | --- |
| 源码版本 | `0.6.0` · 以 [package.json](package.json) 为准 |
| 分发方式 | `npm` · [Releases](https://github.com/tangyixiao/dsh-zcode-plan-bridge/releases) |
| DSH | `>=0.1.5 <0.3.0-0 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.1 \|\| 0.2.2-rc.1` |
| Node.js | `>=22` |
| 开发状态 | [Open issues](https://github.com/tangyixiao/dsh-zcode-plan-bridge/issues?q=is%3Aissue+is%3Aopen) · [CI](https://github.com/tangyixiao/dsh-zcode-plan-bridge/actions) |

模型目录可读、插件加载成功和真实生成成功是不同证据。保留现有 `0.6.0-community.*` 预览安装；不要用稳定渠道覆盖它。

[详细使用、配置与故障排查](docs/guide.zh-CN.md) · [原生 Retry 说明](community/README.md)

## 开发与参与

```sh
npm ci --ignore-scripts
npm run test:offline
npm run typecheck
node tools/check-repository.mjs
```

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Questions](https://github.com/tangyixiao/dsh-zcode-plan-bridge/discussions) · [Report a bug](https://github.com/tangyixiao/dsh-zcode-plan-bridge/issues/new/choose) · [Security](SECURITY.md) · [Maintenance](docs/maintenance.md)

## Star History

<picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=tangyixiao/dsh-zcode-plan-bridge&amp;type=date&amp;theme=dark&amp;legend=top-left"><img src="https://api.star-history.com/chart?repos=tangyixiao/dsh-zcode-plan-bridge&amp;type=date&amp;legend=top-left" width="900" alt="ZCode Plan Bridge Star History"></picture>

[Interactive chart](https://www.star-history.com/?repos=tangyixiao%2Fdsh-zcode-plan-bridge&type=date) · [GitHub Stars](https://github.com/tangyixiao/dsh-zcode-plan-bridge/stargazers)

图表由外部服务按真实星标数据生成，可能缓存或暂时不可用；未填造开发百分比。

## 来源与许可

[Software license](LICENSE) · [Logo artwork and attribution](assets/NOTICE.md)

软件保持原许可证；鲸鱼娘衍生美术单独采用 CC BY-NC-SA 4.0，并保留上善、ZipZipPipe、Small-tailqwq 的署名链。

Derived from [kyle123740/dsh-zcode-cli-proxy](https://github.com/kyle123740/dsh-zcode-cli-proxy), under AGPL-3.0.

离线检查：`npm run test:offline`。`npm run test:native` 保留真实 CLI / Desktop 内核验收，需要对应本机安装；`npm run test:all` 运行完整发现集。
