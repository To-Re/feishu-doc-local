# 贡献者与 AI 开发说明

本地飞书文档是一个由人类提出需求、AI 编写代码的开源项目。本项目自身代码由 OpenAI Codex 生成并迭代。

| 贡献者 | 贡献 |
| --- | --- |
| [@To-Re](https://github.com/To-Re) | 项目发起、需求与设计决策、人工体验验收和维护 |
| [OpenAI Codex](https://github.com/openai/codex) | 代码实现、重构、测试、文档，以及多个 AI agent 之间的交叉评审 |

AI 生成代码仍需通过测试和人工验收。各端的实际验证范围和已知限制见 [验证记录](docs/validation-2026-09-13-plugins.md)。

相关 Git 提交保留维护者的公开提交身份，并使用 [Codex 官方默认的共同作者标记](https://github.com/openai/codex/blob/e4a3612f11ba68ac82111ea986801a3337554083/codex-rs/core/src/commit_attribution.rs#L1) 记录 AI 参与：

```text
Co-authored-by: Codex <noreply@openai.com>
```

该标记用于记录贡献来源。GitHub 的头像、共同作者与贡献者列表由平台根据邮箱关联和提交记录展示。

本说明中的 AI 开发归属适用于本项目自身代码。所使用的第三方代码、字体、图标和其他依赖保留各自的作者与许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [资源归属](docs/assets-and-attribution.md)。
