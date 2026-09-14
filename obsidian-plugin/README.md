# 本地飞书文档 · Obsidian 基础插件

在 Obsidian 内编辑 DocxXML、查看排版和写评论，让 AI 直接读取本地文件继续改稿。复用网页端的编辑器和渲染组件，无需安装 Node、启动服务或登录飞书。

## 能力

- 编辑、只读、源码三种模式；标题、富文本、代码、表格、分栏、图片、公式及部分白板呈现。
- 选文评论、回复、解决与定位；正文和评论分别保存到 XML 与相邻 JSON。
- 可收起的文件导航、文章目录和评论面板；目录按实际 `h1–h9` 层级跳转。
- 支持修改已有公式及内联图源，未保存的源码、评论和图源可恢复。
- 外部文件更新自动回读；有未保存输入时提示冲突并保留草稿。

## 安装

需要桌面 Obsidian **1.8.0+**。从[发布页](https://github.com/To-Re/feishu-doc-local/releases)下载基础插件 ZIP，功能以对应版本说明为准。

1. 将包中的 `feishu-doc-local/` 放入库的 `.obsidian/plugins/`，保留许可证文件。
2. 重新加载 Obsidian，在第三方插件设置中启用“本地飞书文档”。目前需手动安装。
3. 将 XML、相邻 `.review.json` 和引用资源一起放入库中，保持相对路径。
4. 点击 XML，或执行命令“本地飞书文档：打开 XML 文档”。也可右键选择“用本地飞书文档打开”。

文件树不显示 XML 时，可开启 Obsidian 的“检测所有文件扩展名”；其他插件接管 XML 时，用本插件命令打开。命令面板还提供“新建本地文档”和“恢复未保存草稿”。

## 保存与恢复

正文和已提交评论自动保存；看到“已保存到本地”后，AI 即可读取正式文件。无效源码、未发送评论及未应用图源保存在插件 `data.json`，重新打开时可选择恢复，也可恢复为新文档。这个文件可能含私人全文，**不要公开 `.obsidian` 或 `data.json`**。

重命名 XML 时会复制旁置评论并保留旧文件；目标已存在则停止迁移。跨目录移动单篇 XML 不会自动移动素材，应同时保留相对引用的资源。突然断电或强制退出前最后的输入仍可能来不及落盘。

## 可选飞书同步

安装[飞书同步扩展](../obsidian-sync-plugin/README.md)后，可导入或关联飞书，并在顶部预览正文同步、同步评论。正文始终先预览再确认；推送成功后回读更新本地，旧稿存档。两种插件都不需要另开网页服务，基础插件本身不调用 CLI。

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
