# 本地文档与反馈协议 v1

正文 `article.xml` 是 UTF-8 DocxXML。完整文件由多个顶层块组成，通常以唯一的 `<title>` 开头；不是 `<document>` 包裹的 HTML。公开交换约定遵循 [官方语法](https://github.com/larksuite/cli/blob/main/skills/lark-doc/references/lark-doc-xml.md)。本地解析保留未知结构，不意味着这些结构已经通过飞书服务端验证。

反馈 `article.review.json` 是旁置文件：

```json
{
  "format": "lark-review",
  "version": 1,
  "document": {
    "name": "article.xml",
    "baselineXML": "<title>初稿</title><p>最初的内容</p>",
    "xml": "<title>初稿</title><p>人修改后的内容</p>",
    "updatedAt": "2026-09-12T00:00:00.000Z"
  },
  "comments": [],
  "operations": []
}
```

`baselineXML` 保存开始评审时的正文，`document.xml` 是反馈对应的正文快照。当前真源仍是 XML 文件。外部仅修改 XML 后，快照与真源暂时不同是可识别状态，页面会保留评论并将位置标记为待确认。

评论包含 `id, author, body, createdAt, status, anchor, replies`。`status` 是 `open` 或 `resolved`；`anchor` 包含原引用 `quote`、ProseMirror 文档偏移 `from/to` 和 `state`。**偏移不是 XML 字符下标**。表格和结构节点也占位置，文本按 UTF-16 计数。浏览器使用真实编辑事务迁移这些偏移；不存在全篇选一句相同文本就直接重挂的逻辑。

`state` 为 `attached`（位置有效）、`deleted`（原选区被删除）、`unverified`（外部稿件变动后待确认）。原 `quote` 留作反馈语境，不随改字改写。

操作记录用于简短说明发生了什么，不能冒充逐键历史。正文完整改动通过 `baselineXML` 与当前 XML 比较。评论和回复始终使用稳定的 `id`。

## 项目登记与正文同步

一个项目登记一份规范化的本地 XML 绝对路径，并可关联一份实际 Docx 文档 ID 与 URL。同一索引内项目 ID、本地路径、云文档 ID 各自唯一；Wiki 链接先经 CLI 回读解析为实际 Docx 身份。项目索引不保存正文、评论、CLI 参数或凭证，也不移动源文件。

本地服务版全新安装默认使用 `~/.lark-review/projects.json`，已有设置或旧实例索引保持原位置，`--projects-file` 可显式指定。界面通过“项目配置路径 → 修改 → 保存”切换目录，合并项目登记；重复绑定或冲突不会静默覆盖。旧共享开关 API 保留兼容，界面不再展示。`project-settings.json` 和同步快照目录仍在实例索引旁。Obsidian 同步扩展复用相同索引；静态浏览器版与 Obsidian 基础插件不读取此索引。索引 v1 的字段、路径规则与客户端接入约束见 [项目与同步指南](projects-and-sync.md)。

`--cli-config <JSON>` 接受可信本机的 `command,args`，目标由项目登记选择。旧 `--cloud-config` 同时指定 `command,args,documentId,url` 并要求 `--file`；二者互斥。服务器不从浏览器、XML 或反馈 JSON 接受可执行程序、参数或新的目标身份。页面新建项目时允许明确选择已有飞书 URL 或新建标题；真正的绑定由 CLI 回读与服务端索引建立。

正文准备接收本地双文件 `revision` 与 `pull/push`，回读云端完整 XML、版本和可选 `reference_map`，返回两端源码、警告、状态与五分钟有效的预览 ID。客户端只提供先预览再确认的正文同步流程：用户点击「预览同步」后保存本地、准备并校验；`ready` 和 `conflict` 都展示差异并等待明确确认，`equal` 无执行动作。切换方向立即失效旧预览，关闭预览不执行同步。

执行 API 接受 `previewId` 与可选布尔值 `adoptPublished`，绑定原项目、本地版本、云回读与素材摘要；预览过期、两端变化或素材变化要求重新准备。当前网页与 Obsidian 同步入口启用 `adoptPublished:true`，同步服务调用对应的 `ContentApplyOptions`；旧调用方省略参数时保留分开采用回读的兼容行为。

`pull` 采用飞书 XML 并缓存可支持资源；`push` 根据结构与真实块 ID 选择块替换、追加或整体替换，并在每步后完整回读。发布用的 XML 去掉文档层 `id/comment-refs`，保留白板内部 ID；回读的官方 `reference_map` 与本地 `resources` 分别处理。素材变化可能要求整体替换。块重建、内容改变及白板缓存刷新时，无法可靠迁移的评论标为 `unverified`，不按相同文字重挂。

可选 `review.contentSync` 为版本 1，字段为 `documentId,localXML,cloudXML,cloudRevision,syncedAt`，可带 `localAssets`（相对路径到 SHA-256）及 `pending`。它记录最近已确认的双方基线；不替代评审开始时的 `baselineXML`。`pending` 含 `id,direction,startedAt,sourceXML,cloudRevision?`，direction 为 `create/pull/push`；当前云创建和发布在调用前写入该标记，完整确认后才清除。

当前界面的推送及新建飞书文档成功后，会采用经确认的云端正文、真实块 ID 和资源更新本地。更新前将 `local.xml`、`local.review.json`、包含云正文的 `cloud.json` 和完整回执存档，操作记录写明备份目录；不删除旧稿。云端结果不确定、资源读取失败、最终云版本不一致或本地出现新修改时，停止覆盖并保留恢复记录，不自动重发。无法确认的评论引用标为待确认，文本与回复保留。

兼容旧调用方时，成功发布可保留本地原稿与两端基线；两端及素材尚未再修改时，准备结果返回 `action:refresh-local`，显式采用只更新本地，不重新发布。当前推送预览遇到此状态明确显示「推送已完成 · 更新本地副本」，确认只完成本地更新。快照位于实例的 `sync-history`；Obsidian 使用稿件旁的 `.review-sync-history`，均不写进项目索引。

本地版本比较、云端写前重读和 CLI 的 `--revision-id` 共同减少误覆盖，但不能构成跨本地文件、CLI 与飞书的原子比较更新（CAS）。其他客户端可能在检查后修改云稿，分步发布也可能只完成部分。服务用 `.review.json.sync.lock` 防止遵守本协议的进程同时同步同稿；任意外部进程不受此锁约束。存在正文或评论 `pending` 时，正文预览与执行会停止，不自动重试云写。先核对回执、云端完整状态与本地快照，再恢复映射或基线，不能仅删除 pending 再发布。

## 本地快照恢复

新同步快照的 `manifest.json` 记录 `documentPath`、`createdAt`、XML/JSON 哈希和显式本地资源哈希。资源文件保留在原位置；缺失资源记录为 `null`，不能用该快照直接恢复。历史快照仅从当前旁置操作记录中的明确备份路径定位，拒绝跨历史根目录、其他文件身份、软链接及损坏内容。 网页同时认可稿件旁的 `.review-sync-history`；Obsidian 同时认可当前项目配置目录下的 `sync-history`。两端共用项目配置时，可识别对方的上一快照；不在这些可信目录中的历史记录需要先切回对应配置。

网页 `POST /api/projects/:id/restore-preview` 接受当前 `revision`，返回本地前后 XML、快照位置/时间、必要提示及五分钟有效的预览 ID；`POST /api/projects/:id/restore` 只接受该 ID。Obsidian 的 `prepareRestore/applyRestore` 复用相同核心，无需官方 CLI。确认时重查本地版本、快照和资源，先存档当前版本，再通过双文件版本校验写入。预览 ID 一次使用，项目与本地路径必须匹配。

恢复正文和评论内容，同时保留当前云端同步基线、绑定与已发送评论映射，已发送状态不回退，恢复的附着引用标为待确认。未确认的云操作会阻止恢复；不会清除 pending 后重发。恢复操作引用它新保存的当前版本快照，因此可再次预览并撤回。备份失败、资源失效、版本变化或预览过期时不覆盖当前稿。

## 显式飞书评论同步

评论使用上述项目关联，也兼容 `--cloud-config` 启动的固定文件关联。目标与当前本地规范路径精确匹配，直接打开未登记文件不继承同步权限。会话只暴露目标路径/链接，不暴露 CLI 参数或配置内容。正文同步和评论同步分别由用户发起。

`POST /api/cloud-sync?id=<会话ID>` 只接收 `{ "revision": "当前双文件版本" }`，沿用同源与 CSRF 验证。返回 `{snapshot,report}`。同步期间拒绝同稿保存、重复同步；外部进程仍能改文件，回执保存前重新回读并用 CAS 保留新内容，检测到外部修改就停止剩余发送。

CLI 协议使用官方 `docs +fetch`、`drive +list-comments/+list-replies/+add-comment/+add-reply/+resolve-comment/+restore-comment`。拉取评论的四种状态/范围组合与各线程回复均完整分页，不把缺权限、缺页当成空结果。文档用 `full` XML 回读并核查实际文档 ID；两端只按唯一块 ID 与白板引用关联，不依赖文字匹配。已有映射每次也检查引用身份，换板后旧意见变为位置待确认。

旁置 JSON 的可选 `cloudSync` 为版本 1，含 `documentId,url,links,lastSyncedAt,pending`。`links` 保存本地评论 ID、云 comment_id、双方正文基线、状态、回复 ID 映射和原始云回读。只有双方正文基线未冲突时才吸收云端改写；本地改写已同步正文、删除线程或删除回复不会自动覆盖/删除云内容。没有新建身份映射就不会假称某条本地意见已经同步。

每次写云前先持久化 `pending`（操作 ID、类型、时间、目标和负载），确认回执后才建立映射并清除它。结果不确定时禁止自动重发；磁盘 `.review.json.sync.lock` 防止两个进程同时写云。进程异常退出时不自动抢占旧锁。

恢复应先备份 XML/JSON，确认没有活跃同步进程，再根据 `pending` 和云端完整列表核对操作。已确认成功的创建/回复必须补入对应 ID 映射；已明确确认未执行才可清除待定操作重试；有歧义则保留暂停状态。确认无活跃同步并处理完 pending 后才移除遗留 `.sync.lock`。当前没有自动恢复按钮，也没有服务端幂等键，不承诺跨任意外部写入的 exactly-once。

节点评论的云端创建降为整图，并在正文中保留 `针对图中「标签」`；本地 `anchor.target` 继续保留。云原生组件评论回读到父画板，不猜节点 ID。全文评论、仍已解决的评论不接受回复；本地明确重新打开时先恢复云状态再发回复。其他不能发送的内容保留在 JSON 并由 report.issues 说明。

## 白板组件评论

`anchor.target` 是可选的本地扩展，不改变旧文本/整块评论。示例：

```json
{"kind":"whiteboard-component","board":"id:demo-collaboration-svg","id":"local-draft","label":"本地初稿"}
```

`from/to` 跟随白板所在的 ProseMirror 原子节点；`target` 指向该白板内部组件。board 按原始 whiteboard 的 token、src、id、path 优先取第一个非空引用，格式为 `属性名:原始值`；没有引用时采用原始 XML 的 SHA-256。组件 id 来自云导出 SVG 的真实分组 ID、内联 SVG 明确 ID，或 Mermaid flowchart 解析器确认的节点名。渲染时生成的 DOM ID、顺序、显示文案都不能代替组件身份。

页面在编辑和只读模式都允许点击组件，再点“评论选中组件”；引用定位同时核对原白板位置、board 和 id。评论高亮不改变图形原配色。图源改字保留显式 board/id 时可继续定位；删除节点、来源改变、重复 ID 或预览未就绪会明确提示，保留意见并且不按同名文字重挂。外部 XML 修改仍遵循既有 unverified 规则。没有组件结构的 JPG/PNG 缓存和空白画板仍只能评论整块。

本地目标不是飞书云评论协议。公开评论接口实测可回读画板内部意见及回复、所属画板和 Docx 块；本次返回的 relation 没有内部节点 ID。不能把 quote 猜成 node_id，或把 `anchor.block_id` 误当内部组件锚点。关联文件后可显式同步评论；外部 CLI 也可以按云 comment_id 回复、解决和恢复原生组件评论。具体证据见 [白板评论验收](whiteboard-comments-2026-09-12.md)。

## AI 读取与修订

1. 读当前 XML 和相邻 JSON。没有 JSON 表示尚无已保存反馈；不要因此虚构评论。
2. 比较当前 XML 与 `baselineXML`，读取未解决评论和回复，同时检查 `anchor.state`。引用删除或位置待确认时，先结合上下文判断，不按旧偏移写文件。
3. 基于最新文件修改 XML，保留无法处理的节点、属性、token 和资源文件。保存前重新核对文件版本；也可调用本地服务的 PUT，使用共同 `revision` 获得冲突检测。
4. 只有完成对应修改后，才将相应评论置为 `resolved`，追加有明确作者的回复；外部改稿后旧位置应设 `unverified`，不要复制旧偏移并声明已精准映射。
5. 可选写入 `result: {author, summary, appliedAt}` 供页面展示本次处理记录。未解决的意见继续保留。

直接分别写两个文件时，页面可能读到过渡状态；想同时提交正文、反馈与回执，优先使用下面的本地保存 API。不要把这个本地 JSON 发给官方 CLI 当作云评论。

## 已下载资源映射

反馈 JSON 可带可选的 `resources`。它将 XML 中的真实媒体引用对应到本地文件，仅影响显示，不改写正文 token，也不发起下载：

```json
{
  "resources": {
    "version": 1,
    "items": [
      {
        "tag": "img",
        "attribute": "src",
        "value": "<从当前 XML 原样读取的图片引用>",
        "path": "resources/image-original.png",
        "representation": "original"
      },
      {
        "tag": "whiteboard",
        "attribute": "token",
        "value": "<从当前 XML 原样读取的白板引用>",
        "path": "resources/board-preview.jpg",
        "representation": "preview"
      },
      {
        "tag": "source",
        "attribute": "token",
        "value": "<从当前 source 节点原样读取的附件引用>",
        "path": "resources/attachment-original.png",
        "representation": "original"
      }
    ]
  }
}
```

`items` 的选择条件是 `tag + attribute + value` 精确匹配；`img` 的 `attribute` 接受 `src/token`，`whiteboard` 接受 `src/token/path`，`source` 只接受 `token`。`img` 与 `source` 必须为 `original`，`whiteboard` 必须为 `preview`。白板用 `attribute=path` 时，`value` 保留 XML 属性完整原值（如 `@./assets/review-sequence.puml`）；映射自身的 `path` 则指向已下载的预览（如 `resources/plantuml-export.svg`）。重复或模糊匹配不加载，不根据名字、顺序或相似 token 猜测。示例的 `value` 是填写说明，实际使用时必须取自当前 XML。

`path` 相对 XML 所在目录；`img` 原图只允许 PNG、JPEG、GIF、WebP、AVIF 等栅格图，`whiteboard` 预览允许这些栅格图或 SVG，`source` 附件可映射其他本地文件。拒绝绝对路径、父目录跳转、反斜杠及远程 URL，图片服务检查真实路径不能越界。图片按 XML 尺寸与 `scale` 呈现；云白板预览是静态快照，不代表可编辑原生节点。找不到映射或文件时显示未缓存或预览错误，原始资源引用继续保留。

正文白板的 SVG 缓存通过 `GET /api/resource` 取得受限文本，再清理脚本、事件、外部资源和越界样式，仅将安全图形放入白板容器，保留导出文件的真实 `viewBox`，不根据标签重新估算画布。带真实内联 SVG 子元素时优先预览本地正在编辑的 SVG；其他符合条件的白板可使用精确映射的云端 SVG 缓存。资源树点击同一 SVG 仍显示只读源码，不走图形渲染。这些是不同展示入口，均不执行 SVG 中的活动内容。

附件按 XML 的展示方式呈现：行内 `source` 显示文件名；`figure view-type="Card"` 显示名称、类型及合法的字节大小；`figure view-type="Preview"` 和独立 `source` 可显示本地栅格原图。支持的 `figure` 必须只有一个直接 `source` 子节点，没有其他正文，映射读取该子节点的 `token`，不按 figure ID 查找资源。原稿中的安全 `source path="@./assets/file.png"` 也可直接预览。

所有附件仍是不可编辑内部的保护节点，新增卡片和图片 DOM 不改变 XML 或评论偏移。`source` 指定非栅格 MIME 时不加载图片；PDF 等附件不展开，复杂或未知 figure 继续保留占位。资源树可将明确引用的 HTML 等受支持文本作为只读源码展示，不作为网页执行。缓存更新只刷新显示，不生成正文修改，不重置选区、评论或撤销记录。

这是本项目的本地缓存清单，**独立于官方 `reference_map`**。它记录媒体与附件文件的本地路径，不把文件内容嵌入 JSON；也不承载云端评论、HTML5 内容或原生白板节点，不能作为 `--reference-map` 参数发布。完整 fetch 响应、官方 `reference_map`（若返回）、白板节点和其他下载材料应另行保存。

## 图源编辑与资源树

正文内已有 `type=mermaid/svg` 且不含 `src/token/path` 的白板可以编辑源码。应用动作只替换该白板内部图源，保留外层原属性，通过正常编辑事务保存 XML 和反馈并支持撤销；整块评论仍可用，组件评论按下文的目标身份定位。Mermaid 作为字符内容保存，SVG 必须保留为真实 `<svg>` 子元素，不能改成 CDATA 后冒充官方可写结构。Mermaid 最多 50,000 字符，SVG 最多 1,900,000 字符，必须预览成功才允许应用。源码草稿未应用时不写正文，并阻止自动载入外部稿件。SVG 的本地显示会清理活动内容与外部引用；正文源码原样保留，这一显示约束不是对云端发布能力的保证。PlantUML、blank、文件图源与既有云 token 不提供此源码编辑入口，也没有拖拽原生节点的编辑模型。

资源树由当前打开的正文、相邻反馈，以及 XML 的 `img/source/whiteboard path="@…"` 和 `review.resources.items[].path` 生成，不递归扫描目录。反馈预览显示当前页面内的 JSON 状态；正文仍是 XML 真源，其他文件只读。树的选择与展开不修改源稿或反馈。

文本资源必须属于上述显式引用，位于文章目录内，扩展名为 `txt/md/markdown/csv/tsv/json/xml/svg/mmd/mermaid/puml/plantuml/dot/log/yaml/yml/go/js/ts/css/html`，为独立普通文件且最多 2,000,000 字节。服务拒绝软链接、硬链接、特殊文件、非 UTF-8、二进制控制字符及读取期间发生变化的文件；HTML/SVG/代码作为文字显示，不执行、不嵌入浏览器页面。引用文件不存在或类型不支持时显示错误，不猜测替代路径。

## 本地 HTTP

服务只监听 `127.0.0.1`。

- `GET /api/session`：当前打开文档路径、会话 ID、CSRF 值、本机 `homeDirectory`，可选 `project` 及已配置评论连接的 `cloud`。主目录仅用于把页面输入的 `~/` 展开为可见保存路径，不携带凭据。
- `GET /api/document?id=...`：`{xml, review, revision, recovery?}`。
- `PUT /api/document?id=...`：请求 `{xml,review,revision}`；设置 `Content-Type: application/json` 和 `X-CSRF-Token`。返回最新 Snapshot。
- `POST /api/open`：正文 `{path:绝对路径}`，返回文档句柄；不复制、不导出。
- `POST /api/pick`：macOS 系统选择文件，取消返回 `null`。
- `GET /api/asset?id=...&path=...`：读取当前已打开文档目录内的安全本地图片，供直接路径及资源映射预览。
- `GET /api/resource?id=...&path=...`：读取当前稿件显式引用且符合上述规则的文本文件，返回 `{path,text}`；没有资源写接口。
- `GET /api/projects`：`{projects,activeProjectId?,cloudAvailable}`。
- `POST /api/projects`：`{name,local,cloud,defaultDirection}`，返回 `{session,snapshot,projects,warning?}`；具体创建组合见 [指南](projects-and-sync.md)。
- `POST /api/projects/:id/open`：正文 `{}`，返回该项目的会话、稿件和列表。
- `POST /api/projects/:id/bind`：`{revision,cloud:{kind:"existing",url}|{kind:"new",title,parentToken?},defaultDirection}`，返回 `{session,snapshot,projects,warning?}`。只对未关联的当前项目增加飞书关联，保留原项目 ID 与路径；已有文档只建立关联，新文档明确创建并发布当前稿。重复绑定、冲突及待定操作会拒绝。
- `POST /api/projects/:id/preview`：`{revision,direction}`，返回 `{id,projectId,direction,status,localXML,cloudXML,warnings,summary,expiresAt}`。
- `POST /api/projects/:id/sync`：`{previewId}`，返回 `{snapshot,project,summary,warnings}`；预览 ID 执行一次即消耗。
- `GET /api/project-settings`：`{shared,path,sharedPath,hasSharedPath,defaultSharedPath}`；`path` 是实际索引，`sharedPath` 是共享候选，`hasSharedPath` 标明候选是否已由服务端持久化。
- `POST /api/project-settings`：`{shared,path?}`，`path` 为共享 JSON 绝对路径；返回 `{session,snapshot,projects,settings}`。UI 将输入目录转为其中的 `projects.json`。
- `POST /api/cloud-sync?id=...`：`{revision}`，只交换评论、回复与解决状态，返回 `{snapshot,report}`。

项目与设置接口仅在服务器启用项目管理时提供。所有写接口沿用同源验证、`Content-Type: application/json` 和 `X-CSRF-Token`，不会接收浏览器提供的 CLI 命令。会话 ID 是本次服务打开文件的句柄，不是项目 ID 或云文档 ID。

`revision` 覆盖 XML 和 JSON 的精确内容，两个浏览器修改同一份反馈也会冲突。失败返回 `{error,code}`；`409` 时不能盲目重试覆盖，先读取最新状态并合并或保留双方稿件。

正文变化的保存过程先写带 `pendingWrite` 的反馈，再原子替换 XML，最后提交反馈。若 AI 发现 `pendingWrite`，停止直接改写，先让本地服务读取并完成恢复。服务只在磁盘仍符合保存前/后的版本时恢复，第三种内容会报冲突。响应丢失不等于未保存，先回读确认。

## 独立性与限制

本地应用不管理飞书登录凭据，不发起登录或访问 Keychain。默认纯本地；服务器配置 CLI 后，仅明确的新建/关联飞书项目、正文预览与执行、评论同步会调用 CLI。刷新页面、切换项目、共享列表与自动保存不会自动写云。bot 创建成功不代表浏览器中的用户获得访问权，阅稿器不会额外替用户申请权限；可指定已授权的飞书文件夹或选用已授权文档。

项目同步层消费 CLI 完整 fetch 响应；本地文件入口仍只打开 XML，不接受整份 fetch JSON，也不把本地缓存清单当作官方引用映射。保留 XML 不等于所有复杂格式均可发布或与飞书像素一致，既有格式限制继续适用。

独立 CLI 的开发验收已在专用测试稿完成真实 XML 发布、完整回读及资源下载，并在 revision 31 确认行内附件尾文修复。公式样例已完成本地评论、编辑落盘、兼容 CLI 写回、云端回读和恢复；附件字节、Card/Preview、原生三栏比例与 S14 本地资源上传也分别有实测回执。S15 四种 typed 白板在 revision 56→57 完成云写、原生节点和官方独立回读；Mermaid 实际浏览器改源、落盘、撤销重做、兼容 CLI 局部更新及官方回读在 revision 58→59 通过。SVG 实际改源保留真实子元素、CLI dry-run 和撤销通过，未把该次 SVG 改字写云端。三种非空白板的云端页面与本地预览均已检查，SVG 缓存保留服务端 viewBox；Mermaid 连接标签与飞书页面的白底遮罩仍有差异，不声明像素一致。主稿已用 CAS 同步 revision 59，18 项资源映射、两条原评论保留。Sheets CLI 只有离线与 mock 通过，真实读取受应用 scope 阻塞，没有云端单元格写回及本地表格渲染验收。逐项范围及未完成项见 [样式覆盖矩阵](style-coverage.md)。
