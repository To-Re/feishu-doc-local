# 本地飞书文档 · Obsidian 完整插件

在 Obsidian 内编辑 DocxXML、查看排版和写评论，让 AI 直接读取本地文件继续改稿。复用网页端的编辑器和渲染组件，无需安装 Node、启动服务或登录飞书。

## 能力

- 编辑、只读、源码三种模式；标题、富文本、代码、表格、分栏、图片、公式及部分白板呈现。
- 选文评论、回复、解决与定位；正文和评论分别保存到 XML 与相邻 JSON。
- 可收起的文件导航、文章目录和评论面板；目录按实际 `h1–h9` 层级跳转。
- 支持修改已有公式及内联图源，未保存的源码、评论和图源可恢复。
- 外部文件更新自动回读；有未保存输入时提示冲突并保留草稿。

## 安装

需要桌面 Obsidian **1.8.0+**。从[发布页](https://github.com/To-Re/feishu-doc-local/releases)下载完整插件 ZIP，功能以对应版本说明为准。

1. 将包中的 `feishu-doc-local/` 放入库的 `.obsidian/plugins/`，保留许可证文件。
2. 重新加载 Obsidian，在第三方插件设置中启用“本地飞书文档”。目前需手动安装。
3. 将 XML、相邻 `.review.json` 和引用资源一起放入库中，保持相对路径。
4. 在文件列表中点击 XML。符合 DocxXML 的内容自动进入文档编辑器；普通 XML 以只读原文展示，不创建评论文件或启用飞书同步。也可执行“本地飞书文档：打开飞书 XML 文档”，或右键选择“用本地飞书文档打开”。

插件注册 XML 入口，让文件可在目录中显示；打开时只读取当前选中文件并判断格式，不扫描全库内容。若已有其他插件注册 XML，会保留其关联，可用本插件命令打开飞书文档。命令面板还提供“新建本地文档”和“恢复未保存草稿”。DocxXML 是可交换格式，校验只判断结构，不证明文档来自飞书；仅含 `<p>` 等共有标签的片段也可能是有效 DocxXML。普通 XML 可通过 Obsidian 页签菜单使用系统默认应用打开。

## 保存与恢复

正文和已提交评论自动保存；看到“已保存到本地”后，AI 即可读取正式文件。无效源码、未发送评论及未应用图源保存在插件 `data.json`，重新打开时可选择恢复，也可恢复为新文档。这个文件可能含私人全文，**不要公开 `.obsidian` 或 `data.json`**。

重命名 XML 时会复制旁置评论并保留旧文件；目标已存在则停止迁移。跨目录移动单篇 XML 不会自动移动素材，应同时保留相对引用的资源。突然断电或强制退出前最后的输入仍可能来不及落盘。

## 可选飞书同步

同步能力已包含在同一个插件内。未配置 CLI 时，本地阅读、编辑、评论、源码和缺失资源提示均可用；点击“配置 CLI（可选）”再填写路径。保存设置不会运行 CLI，也不会自动登录或下载。导入、正文及评论同步沿用原有预览、确认和恢复机制，详见[同步配置与操作](../obsidian-sync-plugin/README.md)。

## 从双插件升级

1. 等待文档显示“已保存到本地”，先处理未发送评论、无效源码或图源草稿；正常关闭 Obsidian。
2. 备份两个插件目录和 `community-plugins.json`。用新包更新 `feishu-doc-local/`，保留原 `data.json` 和已有 `cli-settings.json`。
3. 停用“本地飞书文档 · 飞书同步”（`feishu-doc-local-sync`），只启用“本地飞书文档”。旧目录保留以便恢复，不必删除。
4. 重启后，完整插件优先使用自己的 `cli-settings.json`。首次发现旧扩展 `data.json` 时，先在完整插件目录的 `migration-*` 子目录备份旧配置及草稿文件，再迁入 CLI 配置；旧文件不改动。

草稿继续使用完整插件原来的 `data.json`，同步配置单独存放，项目索引路径、固定参数和关联历史保持原值。已有新配置优先，重复启动不会再次覆盖。配置损坏或备份失败时保留原数据并提示，本地编辑不受同步配置影响。

旧扩展仍启用时，完整插件不注册第二套同步命令和工具栏；停用旧扩展后重启完整插件即可。旧命令 ID `feishu-doc-local-sync:open-sync`、`:open-projects`、`:open-cli-settings`、`:import-cloud-document` 对应新的 `feishu-doc-local:` 同名后缀。自定义快捷键需在 Obsidian 中重新绑定；升级不自动覆盖用户快捷键。

不需要安装两个插件。源码中的 `obsidian-sync-plugin/` 保留同步模块及回归测试，不再作为独立运行包发布。

## 限制

- 不支持移动端和独立弹出窗口；部分宿主行为仍需更多实际应用验收。
- 没有原生白板拖拽、电子表格内部编辑；未下载的云资源不会自动加载。[格式范围](../docs/style-coverage.md)列出具体差异。
- XML 小于 5 MB，额外文本或 SVG 预览不超过 2 MB。资源限定在稿件目录内，不执行活动内容。
- 保存使用版本比较和恢复记录，不能锁住所有外部编辑器；发生冲突时先核对内容。

## 构建

开发者在仓库根目录执行：

```sh
npm ci
npm ci --prefix obsidian-plugin
npm run typecheck --prefix obsidian-plugin
npm test --prefix obsidian-plugin
npm run build --prefix obsidian-plugin
```

输出为 `obsidian-plugin/dist/`。构建需要 Node，安装已构建插件不需要开发依赖。插件使用官方 [Obsidian API](https://github.com/obsidianmd/obsidian-api)，Obsidian 应用不随包提供。

项目代码采用 MIT；分发时保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `licenses/`，第三方组件遵循各自许可证。
