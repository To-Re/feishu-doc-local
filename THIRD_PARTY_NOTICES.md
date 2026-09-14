# Third-party notices

本地飞书文档（feishu-doc-local）的自有代码采用 [MIT License](LICENSE)。以下代码、图标和字体仍适用各自许可证；项目的 MIT 不替代这些条款。

## 完整清单和原文

[许可证清单](licenses/README.md) 列出锁定的运行时依赖闭包及部分构建工具；[机器可读清单](licenses/dependencies.json) 记录包版本、来源、完整性值、原始许可文件和 SHA-256。完整版权与许可文本位于 `licenses/packages/`。运行时闭包是实际打包模块的保守超集，不表示每个条目都进入最终 JS。

清单由 [本地生成器](scripts/generate-third-party-notices.mjs) 从 `package-lock.json` 和 `npm ci` 后的包生成，不用通用 MIT 模板覆盖原作者署名，不在生成时下载内容。缺失许可文件、版本不一致或实际入包依赖未覆盖时检查失败。

## 特别说明

| 组件 | 本项目中的用途 | 许可及通知 |
| --- | --- | --- |
| React、Tiptap / ProseMirror、Mermaid、KaTeX 代码等 | 编辑和渲染 | 各包的原始许可文本见完整清单；这些主要包为 MIT，不能据此推断所有传递依赖均为 MIT。 |
| Lucide React | 界面图标 | **ISC**；其 LICENSE 还列出来自 Feather 的图标及 **MIT** 文本。两部分和原始版权声明均完整保留。 |
| KaTeX 字体 | 随 CSS 构建输出的数学字体 | **SIL OFL-1.1**，与 KaTeX 代码的 MIT 分开。已保留每个 TTF 内嵌的 Design Science / Khan Academy 版权、Reserved Font Name 与完整许可，见 [字体通知](licenses/KaTeX-fonts-OFL-1.1.txt)。字体未经修改，WOFF / WOFF2 按同名字体的 TTF 元数据对应。 |
| DOMPurify | SVG 等活动内容清理 | 上游提供 **Apache-2.0 或 MPL-2.0**；本分发选择 **Apache-2.0**。保留上游完整双许可文件及原始版权标头。 |
| elkjs（Mermaid 的依赖） | 图布局，属于实际浏览器构建模块 | **EPL-2.0**；内嵌 Worker 另有 **Apache-2.0** 通知。保留 2017/2021 Kiel University 与 2020 Google LLC 的三段原始版权标头，见 [COPYRIGHT.txt](licenses/packages/elkjs-0.9.3/COPYRIGHT.txt) 与 [Apache-2.0.txt](licenses/packages/elkjs-0.9.3/Apache-2.0.txt)。不改为本项目的 MIT。上游代码未在 node_modules 中修改；其 JS 源码与构建项目在 [elkjs 0.9.3](https://github.com/kieler/elkjs/tree/0.9.3)，对应 npm 源包及完整性值也记录在清单中。其 README 说明布局内核由 [Eclipse ELK](https://github.com/eclipse-elk/elk) 的 Java 代码经 GWT 生成，构建入口及版本依赖以该 tag 的上游工程为准。 |
| lightningcss | Vite 构建过程使用的 CSS 工具 | **MPL-2.0**。构建工具和平台二进制不作为编辑器运行时代码分发；许可文本仍在工具清单中保存。 |
| saxes | XML 解析 | **ISC**。6.0.0 npm 包缺少许可文件，因此按该版本上游 tag 补入完整 LICENSE，包含 SAX 来源通知。来源与哈希见 [补充来源](licenses/upstream/README.md)。 |

EPL 组件保留其许可证和上游源码获取入口；若修改它、改变打包方式或另行分发源码 / 二进制，需要一起更新相关通知及源码说明。这里记录具体分发内容与来源，不宣称“全部 MIT”或一次检查涵盖任意后续分发。

## 外部工具与思路来源

- [官方 lark CLI](https://github.com/larksuite/cli) 是可选的独立可执行程序，采用 **MIT**。编辑器只通过公开命令和 DocxXML / JSON 边界调用它，不复制或捆绑其二进制。[写稿协议](docs/writing-protocol.md)依据官方 `b8b21da3a57b5634b0dc6f5074d479f1e751e658` 的语法参考整理；该文档沿用官方 MIT 许可归因。其 [MIT 文本快照](licenses/upstream/lark-cli-MIT.txt)保留 Lark Technologies Pte. Ltd. 版权，不表示 CLI 已包含在本项目安装包中。
- 其他兼容适配器不随本仓或发行包分发；用户需要自行取得相应程序及授权。本项目不以它们为运行前提。
- [Human Review](https://github.com/petergyang/human-review) 提供“在文章上反馈，再由 AI 接着修改”的交互参考；本仓未把它作为代码或运行时依赖。
- 原创样例与非代码素材的来源见 [素材说明](docs/assets-and-attribution.md)。真实私人文档、云端回执和截图不属于发行内容。

## 更新与分发

```sh
npm ci
node scripts/generate-third-party-notices.mjs
node scripts/generate-third-party-notices.mjs --check --verify-bundle
```

当前 `master` 分发范围为本地服务版、静态浏览器版、Obsidian 基础插件与可选飞书同步扩展，产物位置和外部运行时边界见 [素材说明](docs/assets-and-attribution.md#四种交付产物)。实际分发 JS、字体或完整构建产物时，同时保留 `LICENSE`、本文件及整个 `licenses/` 目录。`node scripts/copy-distribution-notices.mjs` 可将这些文件复制到已存在的 `dist/` 及 `dist/client/`；这是本地文件操作，不会发布站点或上传产物。不要仅摘出压缩后的脚本和字体而遗漏通知。

本清单没有将 Node.js、操作系统、完整 node_modules、所有测试工具或平台构建二进制纳入分发。若未来提供包含这些组件的桌面客户端、容器或插件包，应按该产物重新收集许可证，不能直接套用本次范围。
