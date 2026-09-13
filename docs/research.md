# 本地飞书格式编辑器：现有项目调查

调查日期：2026-09-12。核对公开仓库、格式规范与关键源码；没有安装或运行这些候选产品。以下是文档及源码核查，不代表交互实测。

目标是浏览器直接编辑真实本地文件、选文评论自动落盘、外部 AI 读文件修订，正文采用官方 CLI 的 DocxXML 交换格式，满意后再发布到飞书。

| 项目 | 已有能力 | 与本项目的差距 |
| --- | --- | --- |
| [Margent](https://github.com/Brehove/margent) | 本地 Markdown 编辑与评论；旁置 `.mdreview/` JSON；CLI/MCP、修订提案；`margent serve` 提供浏览器界面 | 当前明确以 Markdown 为正文。项目自述处于早期；没有核实到 DocxXML 导入导出 |
| [Human Review](https://github.com/petergyang/human-review) | 浏览器修改 HTML/Markdown、选文评论、向外部 AI 交接反馈 | 没有核实到 DocxXML；Markdown 修改由 Agent 写回，不能直接等同于所有格式自动写回原稿 |
| [Roughdraft](https://github.com/Lex-Inc/roughdraft) | 本地 Markdown 评审、评论与建议；CLI 服务支持文件工作流 | 反馈使用正文中的 CriticMarkup 和 YAML endmatter；与正文/评论分文件的要求不同 |
| [青简 QingAgent](https://github.com/void2anything/qingagent) | 富文本、逐条审改；外部 `qa` CLI 可以提交 proposal、读文档及订阅事件 | 自有 QingML/ProseMirror 模型、本机 libSQL；并非保留原 DocxXML 的文件编辑器 |
| [Knote](https://github.com/1661169091kiwi/Knote) | 本地 Markdown、类飞书所见即所得、AI 差异审阅 | Markdown 为真源；类飞书体验不等于官方格式兼容 |
| [LarkFS](https://github.com/IchenDEV/larkfs) | 通过官方 CLI 将飞书资源映射为 FUSE/WebDAV 文件 | 面向云端资源，需要飞书身份；文档以 Markdown 投影，不是离线评审编辑器 |
| [feishu-preview](https://github.com/andyliu/feishu-preview) | 本地 Markdown 预览、白板图转换、CLI 发布 | 主要是预览/发布工具，没有核实到浏览器直接修改原稿与旁置评论闭环 |

这些项目说明人机共用文档界面已经有可用探索。本轮未核实到同时满足上述条件、原生支持官方 DocxXML 的成品；这不是对所有项目的穷尽证明。

## 可以借鉴什么

Margent 的 [sidecar 规范](https://github.com/Brehove/margent/blob/main/docs/mdreview-spec.md) 将正文、评论、修订提案、事件和读取进度分开。我们先保留正文加一份反馈 JSON，记录评论、基准正文和操作，不引入完整工作台。

青简的 [QingML 规范](https://github.com/void2anything/qingagent/blob/main/docs/model-notes/qingml-spec.md) 将 HTML 子集编译成自己的模型；其 [飞书连接器](https://github.com/void2anything/qingagent/blob/main/packages/core/src/connectors/feishuConnector.ts) 不能证明已有 DocxXML 往返适配。可参考提案审阅交互，不将其 DOCX（Word）导出误认为飞书 DocxXML。

[am-editor](https://github.com/red-axe/am-editor) 提供富文本和范围标记插件，但其值是自有 HTML/schema；未核实官方 DocxXML 能力。[BlockNote 评论](https://www.blocknotejs.org/docs/features/collaboration/comments) 提供线程 UI 和 ThreadStore，当前文档要求启用协作，通常与 Yjs 集成；仍需 XML 和本地文件适配。[Tiptap 官方评论](https://tiptap.dev/docs/comments/getting-started/overview) 是付费扩展，需要 Document server，不能当作免费编辑内核自带能力。

## 本轮选择

用户在调查后确认：参考 Human Review 的思路做飞书版本。浏览器是人和现有 AI 共用的评审界面，不内置另一个聊天助手。保留本任务明确要求的自动落盘和旁置反馈；不照搬其 Markdown 由 AI 写回、集中存储反馈或额外点击 Send 的全部机制。

使用 Tiptap/ProseMirror 免费编辑内核，在独立 `lark-review` 仓库实现 DocxXML 适配和简单评论层。不整套 fork 上述产品，避免引入数据库、内置模型调用和另一套正文格式后再做迁移。

官方 [DocxXML 规范](https://github.com/larksuite/cli/blob/main/skills/lark-doc/references/lark-doc-xml.md) 是交换边界。能处理的内容进入编辑器；复杂或未知内容完整保留，明确呈现受保护占位。无操作保存与相邻块修改都不能删除未知 XML、附件或其后正文。不要用浏览器 HTML 解析器直接读写整个 XML。

验证优先级：格式往返保留 → 本地正文/反馈自动保存 → 评论随编辑事务迁移 → 多浏览器与 AI 外部改文件的并发保护。云端发布与完整官方 skills 兼容是后续单独验收，不纳入这次离线开发。
