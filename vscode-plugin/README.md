# 本地飞书文档 · VS Code 只读预览

在 VS Code 中阅读本地 DocxXML。复用 feishu-doc-local 的解析器、公式、表格和白板渲染器，不需要启动网页服务、安装飞书 CLI 或登录账号。

## 打开文档

- 新文件建议命名为 `article.feishu.xml`，点击后默认进入阅读视图。
- 已有 `article.xml` 无需改名：右键文件选择「飞书文档：只读预览当前 XML」，或从命令面板执行该命令。也可以用「重新打开编辑器的方式」选择「飞书 XML（手动只读预览）」。
- 普通 `.xml` 不被默认接管，继续使用文本编辑器或原来的 XML 插件。不需要全局 `files.associations` 或 `workbench.editorAssociations` 设置。
- 阅读视图中的「查看源码」打开 VS Code 文本编辑器；它遵循 VS Code 正常的编辑和保存行为。

## 阅读能力

支持标题目录、正文、列表、代码、表格与合并单元格、公式、本地图片、受支持的白板预览、已有评论及回复。受支持的本地音视频与文本附件沿用共享渲染器；缺失或不支持的资源显示提示。外部网络图片、远程脚本和文档外链不会自动加载或跳转。

阅读视图不会写回 XML、评论或同步数据，也不会创建反馈文件。AI 或其他编辑器修改正文、旁置评论及已引用资源后自动刷新；工具栏也提供手动刷新。目录内资源通过宿主文件 API 读取，只接受明确引用的相对路径，拒绝越界、符号链接及特殊文件。

此版不包含富文本编辑、添加评论、飞书拉取或推送。未知块保留为阅读占位，不改变文件。正文上限 5 MB、旁置评论 20 MB；图片 20 MB、音视频 25 MB、文本和 SVG 2 MB，引用资源最多 200 项、合计 80 MB。

## 文件后缀和旁置评论

`.feishu.xml` 仍是 XML，不改变 DocxXML 协议，也不影响现有编辑器、AI 或 CLI 读取。旁置文件沿用“替换最后一个 `.xml`”的规则：

| 正文 | 旁置评论 |
| --- | --- |
| `article.xml` | `article.review.json` |
| `article.feishu.xml` | `article.feishu.review.json` |

插件不会自动改名。若手动改名已有正文，需要一起改名对应评论文件，并更新项目中的路径引用；不建议只为预览批量迁移旧稿。相对素材仍放在文档目录内。

## 构建与安装

在项目根目录使用 Node.js 22.13+：

```sh
npm ci
npm ci --prefix vscode-plugin
npm run typecheck --prefix vscode-plugin
npm run vscode:test
npm run vscode:package
code --install-extension vscode-plugin/dist/feishu-doc-local-0.1.0.vsix
```

源码属于 feishu-doc-local 的同一个 Git 仓库，避免复制核心渲染器。VSIX 仅包含插件清单、说明、构建结果和完整第三方通知，不带用户文档、测试数据、CLI 或 node_modules。安装依赖仅供开发；使用插件无需另装 Node。

该插件使用工作区扩展宿主，文件读取适配 `file` 和 `vscode-remote` URI。远程主机需要在那里安装扩展；未将 SSH 远程、Windows 或 Linux 标为实际验收通过。

验收步骤与实际范围见 [0.1.0 验收记录](../docs/archive/validation-2026-11-17-vscode.md)。
