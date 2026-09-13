# 白板与评论对齐验收 · 2026-09-12

本轮用获准的专用飞书测试文档和隔离本地副本验证。主稿内容、业务文档和历史评论未被测试覆盖；原始云回执和截图放在忽略 Git 的 `.local/board-comments-20260912/`。

## 已完成的行为

| 场景 | 结果与边界 |
| --- | --- |
| 新 Demo | 旧假 token 白板改为真实 inline SVG 三节点两连线，以及 Mermaid 四节点流程图；无需登录即可渲染。已在内置浏览器实看。 |
| 本地组件评论 | 编辑模式选 SVG 节点、只读模式选 Mermaid 节点，分别写入 JSON 中精确 board/id。两张图中的同名“本地初稿”未串位置。 |
| 评论闭环 | 真实页面添加、回复、解决、重新打开；刷新后评论恢复，点击引用只高亮目标组件。正文 XML 与评论前逐字节一致。 |
| 云端 SVG 缓存 | 真实飞书导出 SVG 的原节点 ID 保留；本地点击“本地修订稿”保存相应画板 token 和原始节点 ID，刷新后在只读模式仍可定位。 |
| 浏览器里的飞书原生组件评论 | Chrome 中进入实际画板，使用评论工具点击具体形状发送。页面显示节点黄色定位框和独立评论。 |
| CLI 新增评论 | 兼容 CLI 官方兼容 `drive +add-comment`，以 Wiki 链接解析到 Docx，在明确的白板 block_id 创建块级评论；云页面与分页 API 确认。 |
| CLI 回复组件评论 | `+add-reply` 沿用浏览器创建的原生组件 comment_id，原评论下真实出现机器人回复；列表回读包含两条回复项。 |
| CLI 状态修改 | `+resolve-comment` 后分页回读 is_solved=true，`+restore-comment` 后回读 false；没有新建重复线程。 |

界面操作与磁盘、SVG 节点、保存记录分别交叉核验；代码和集成测试不替代真实浏览器验收。

## 本轮修掉的交互问题

- 组件事件使用当前编辑器实例，避免首次渲染捕获空 editor 导致无法提交组件目标。
- 组件选择不触发整板选区的图源侧栏，评论期间保留已有图源草稿。
- 跨白板点击时清除旧组件选中框；普通正文选择也清除旧框。
- 已评论组件在异步 SVG 加载和刷新后恢复高亮；解决评论去除其高亮。
- 定位限制在原 ProseMirror 白板节点及唯一的 board/id，缺失或重复时显示明确提示，不按文字猜测。

## 仍有差距

本地尚没有飞书原生白板的自由拖拽、任意组件创建、多人协作、画布坐标评论或完整评论富文本编辑器。云端 JPG/PNG 快照没有节点结构，仍仅支持整块评论。Mermaid 本地可定位显式 flowchart 节点，其他图类型不推测内部锚点。

公开评论接口能返回画板内评论正文、回复、parent_type=WHITEBOARD_BLOCK、所属画板 token 与 Docx 块；本次 relation 的画板 positionInfo 为空，原生节点列表也未包含评论到组件的关联。不能据此宣称公开协议提供了内部组件 ID，更不能按 quote 相似度自动挂接。

官方 CLI 创建评论当前支持文档或 Docx block_id；本轮 兼容 CLI 对齐这一范围。浏览器能创建内部组件评论，CLI 可以沿用该 comment_id 回复与修改状态，**本地组件评论到云端内部锚点的自动同步尚未实现**。原生 `doc comment get` 接口只读全文评论，本次局部评论用分页 `list` 才完成回读；单条 get 的 not exist 没有被当作评论丢失。

参考：[官方评论定位说明](https://github.com/larksuite/cli/blob/main/skills/lark-drive/references/lark-drive-comment-location.md)、[官方创建实现](https://github.com/larksuite/cli/blob/main/shortcuts/drive/drive_add_comment.go)、[官方回复实现](https://github.com/larksuite/cli/blob/main/shortcuts/drive/drive_add_reply.go)。这些协议事实与上面的浏览器实测分别记录。

## 证据位置

- `demo-e2e/`：实际本地评论 XML/JSON、原始哈希、页面截图、独立磁盘核验。
- `cloud-e2e/`：真实云稿副本、SVG 节点定位截图与独立磁盘核验。
- `comments-after-read-scope.json`、`native-nodes-after-comment.json`：原生组件评论和画板节点的公开接口回读。
- `cloud-add-block-comment.json`、`cloud-reply-component.json`：两次写入的独立回执。
- `cloud-resolved-list.json`、`cloud-restored-list.json`：完整分页终态与回复回读。
- `cloud-component-comment.png`、`cloud-component-reply.png`：Chrome 实际组件评论与 CLI 回复。
- `tests-final.log`、`build-final.log`：最终检查。测试用回环临时服务，未访问飞书。

最终检查：编辑器 `npm run typecheck`、219 项测试和生产构建通过；CLI 完整 Go 测试、构建、help 与四条离线 dry-run 通过。本机旧 Go 链接使用 `-ldflags=-linkmode=external`。
