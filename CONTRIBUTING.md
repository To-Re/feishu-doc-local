# 参与本地飞书文档

欢迎提交最小复现、文档改进和补丁。说明用户遇到的具体问题、预期行为和实际结果；涉及排版时，可附不含私人内容的 XML 与截图。

当前贡献目标为 `master`：网页的静态本地版、本地服务与可选飞书同步，以及 Obsidian 基础插件和官方 CLI 同步扩展。

## 本地开发

使用 macOS 和 Node.js 22.13 或更新版本：

```sh
npm ci
npm run build
npm start
```

修改后运行：

```sh
npm run typecheck
npm test
npm run build
node scripts/generate-third-party-notices.mjs --check --verify-bundle
```

测试使用临时文件和 loopback 端口，不要求飞书账号。图形和编辑交互的修改还需在浏览器实际操作；说明验证了哪些流程，不把单元测试替代为视觉或云端验收。

按改动范围补充检查：静态浏览器版运行 `npm run build:browser`；两个 Obsidian 插件分别运行其目录内的类型检查、测试和构建，见 [基础插件构建](obsidian-plugin/README.md#构建) 和 [同步扩展构建](obsidian-sync-plugin/README.md#构建)。当前 CI 覆盖共享网页与 Obsidian 检查；图形界面和云端往返需另记实际操作与回读结果。

## 变更约定

- 正文 XML、相邻反馈 JSON 和资源分别保存；未知 XML 不静默丢弃。涉及保存与同步时，覆盖并发输入、失败恢复和原稿保留场景。
- 正文发布必须先预览并确认。评论发送和正文同步分别处理，不在自动保存、启动或切换项目时自动发送。
- CLI 通过可信本机配置调用官方公共命令边界；本仓不能依赖维护者机器上的相邻仓库、账号或配置。
- Obsidian 同步扩展使用用户明确配置的官方 CLI；基础插件不能引入额外 Node 或 CLI 运行依赖。涉及宿主文件接口的变更需核对未保存输入冲突、关闭回执、未发送草稿恢复与文件改名后的旧路径写入。
- XML、SVG、URL 和路径均是外部输入。保持活动内容清理、路径限制、请求校验及 CLI 无 shell 执行；不要通过静默兜底绕过校验。
- 新依赖需要解释用途，并更新锁文件和许可证清单。运行 `node scripts/generate-third-party-notices.mjs` 重新生成，再使用 `--check --verify-bundle` 检查实际构建的覆盖范围。

## 提交与 Pull Request

每个 PR 围绕一个明确问题。描述改了什么、为什么、如何验证及剩余限制；使用仓库模板即可。避免提交无关格式化、个人配置、真实文档 URL、身份标识、原始 CLI 回执和 `.local` 数据。示例使用原创或许可清楚的脱敏素材。

真实飞书测试应使用你有权操作的专用测试稿，并自行准备 CLI 身份和权限。默认 CI 不提供云凭据，也不执行云端写入。

本项目接受的贡献按 [MIT License](LICENSE) 提供。请仅贡献你有权提交的内容，并保留第三方版权及许可证说明；当前没有额外 CLA 或 DCO 签署流程。
