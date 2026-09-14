# 写稿协议：官方 DocxXML 与本地文件

给 AI 或其他自动化工具的稳定入口：把文章正文写入 UTF-8 `.xml` 文件，使用下列官方 DocxXML 语法；评论、操作和同步记录由本项目保存在相邻 `.review.json`。只写本地文章不需要飞书账号、CLI 或 Node 服务。本文说明文件格式，不规定文章文风，也不授予发布权限。

## 格式依据与适用范围

本页核对的是官方 `larksuite/cli` 的 **`b8b21da3a57b5634b0dc6f5074d479f1e751e658`**（2026-09-11）源码和参考文件；这是固定版本依据，不是“始终跟随最新版本”的声明：

- [常用 DocxXML 语法](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-xml.md)
- [扩展块、HTML5 与 OKR](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-xml-extended-blocks.md)
- [白板图源与 SVG 限制](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-whiteboard.md)
- [创建参数与 reference_map](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-create.md)

DocxXML 是 CLI 接受的文档交换格式，采用类似 HTML 的标签，但不是任意 HTML、Markdown、Word `.docx` 或飞书编辑器的内部数据。官方列出了某个标签，表示该版本提供对应写入入口；实际创建仍受资源身份、权限、文档类型和服务端约束。本地 XML 校验通过不等于发布通过，更不代表视觉和内容无损往返。当前实测差异见[格式支持与限制](style-coverage.md)。

## 文件各自保存什么

| 文件或字段 | 内容与处理方式 |
| --- | --- |
| `article.xml` | 当前正文真源。Agent 直接改这一份，不把整个 CLI JSON 回执写进去。 |
| `article.review.json` | 本地评论、引用、操作、评审基线和同步状态。它不是官方正文格式，不作为 `--reference-map` 输入。已有文件应保留，字段契约见[本地协议](protocol.md)。 |
| 官方 `document.reference_map` | 完整回读中与正文配套的结构化引用，例如 `html5-block` 的实际 HTML。保存为独立 JSON 时，文件内容是这个对象本身，而不是整个回执。重放含 `data-ref` 的正文须保留匹配的映射和所引用文件。 |
| `assets/` 等相对目录 | 图片、附件、图源及下载的预览。正文引用和文件需要一起移动或交付；只有 XML 不能保证资源可用。 |
| 本地 `review.resources` | 云 token 与本地缓存的精确映射，供本地显示。它与官方 `reference_map` 不同，不能互相替代。 |

典型目录如下；新写本地稿件只需创建 XML 和它实际引用的素材，不必预造 JSON 或飞书 ID：

```text
article.xml
article.review.json          # 首次保存评论等操作时由应用维护
assets/
  diagram.svg
  photo.png
  report.pdf
reference-map.json           # 仅在保留官方结构化引用时需要
```

读反馈时同时读当前 XML 和旁置 JSON。`document.baselineXML` 是评审起点，JSON 内的 `document.xml` 是反馈对应快照，不应反过来覆盖当前 XML。评论的 `anchor.from/to` 是编辑器文档位置，不是 XML 字符下标；不要按字符串匹配猜新位置。外部改稿后允许应用将旧评论标为待确认，保留评论 ID、引用原文和回复；不要为了“修复状态”删掉 `pending`、同步映射或未知字段。

## 正文结构、嵌套与转义

1. 完整文章由连续顶层块组成，以一个 `<title>` 开头。不要加自创的 `<document>`、`<html>`、`<body>` 外壳；单独修改块时才使用不含标题的片段。
2. 正文层级使用 `<h1>` 到 `<h9>`，按官方规则连续下降。标题 `seq="auto"` 表示自动编号。标题不是 `<title>`，正文目录可索引各级标题。
3. 属性写引号，例如 `align="center"`。标签闭合完整，空元素可写 `<hr/>`。正文文件不含 `DOCTYPE` 或实体声明；本地解析会拒绝它们。
4. 段落、标题中写文本和行内标签；表格、分栏、代码块、白板作为块放置，不塞入 `<p>`。子列表放在父 `<li>` 内，`<li>` 的父级必须是 `<ol>` 或 `<ul>`。
5. 只转义内容，不转义标签。文本中的 `&`、`<`、`>` 分别写为 `&amp;`、`&lt;`、`&gt;`；双引号属性中的 `"` 写为 `&quot;`。URL 查询串中的 `&` 同样转义。
6. 段内硬换行写 `<br/>`。顶层块之间的排版换行不等于一个空段落；要空段落须显式 `<p></p>`。代码和 Mermaid 等图源保留其语法需要的换行，不把代码的每个换行当成新段落。

```xml
<p>A &amp; B：1 &lt; 2。<br/>第二行含 <b>粗体</b> 和 <a href="https://example.com/?a=1&amp;b=2">链接</a>。</p>
<pre lang="python" caption="转义示例"><code>if a &lt; b:
    print("A &amp; B")</code></pre>
```

普通 XML 文本可使用 CDATA，但不能把需要结构解析的标签变成纯文本。尤其内联 SVG 应是 `<whiteboard>` 内的真实 `<svg>` 子树，而不是 `&lt;svg...` 或整段 CDATA。

## 常用标签矩阵

下表“本地”说明网页及 Obsidian 共用编辑器的能力。**可编辑**不代表每个属性都有工具栏；没有专用控件时通过源码修改。**保护**表示保留原 XML、仅展示卡片/占位或支持的预览，不能直接编辑内部业务结构。

| 格式 | 官方写法、主要属性与嵌套 | 本地 |
| --- | --- | --- |
| 标题、正文 | `title`、`h1`–`h9`、`p`；`align="left\|center\|right"`；标题可用 `seq="auto"` | 文本编辑、目录、评论；编号和对齐呈现 |
| 富文本 | `b`、`em`、`u`、`del`、`code`；可嵌套行内样式 | 编辑与评论；代码块另用 `pre/code` |
| 行内颜色 | `span text-color="blue" background-color="light-yellow"` | 颜色呈现，源码可改 |
| 链接 | `a href="https://…"`；可加 `type="url-preview"` | 链接呈现；不保证还原飞书的完整预览卡片 |
| 换行、分隔线 | 段内 `br`；块级 `hr` | 呈现并保留 |
| 列表 | `ol/ul` 下为 `li`；编号写在项上，例如 `<li seq="3">`，后续项可 `seq="auto"`；子列表在 `li` 内 | 列表编辑、嵌套、编号与评论 |
| 待办 | `<checkbox done="false">内容</checkbox>`，状态为 `true/false`，可加 `align` | 可编辑文字与勾选 |
| 引用 | `<blockquote><p>引用文字</p></blockquote>` | 可编辑 |
| 代码块 | `<pre lang="go" caption="示例"><code>代码</code></pre>`；代码不能直接放在 `pre` 下 | 可编辑、高亮；未知语言按普通代码显示 |
| 公式 | `<latex>E = mc^2</latex>`；居中显示可放入 `<p align="center">` | KaTeX 呈现；已有公式可选中改源码，不支持全部 TeX 宏 |
| 表格 | `table` → 可选 `colgroup`、`thead/tbody` → `tr` → `th/td` → `p` 等单元格内容 | 单元格编辑；呈现合并、列宽和背景，无合并/调宽工具栏 |
| 分栏 | `grid` 直接包含 `column width-ratio="0.5"`，所有比例之和为 1；栏内写块 | 按比例呈现，正文可编辑 |
| 高亮块 | `callout` 可有 `emoji`、`background-color`、`border-color`、`text-color` | 可编辑支持的子块；颜色与图标呈现 |
| 图片 | `img` 的 `path`、`href`、`src` 三选一；可带 `width,height,caption,name` | 本地图片或已缓存资源可显示、整体评论；不自动加载远程图片 |
| 附件 | `source path="@./report.pdf" name="报告.pdf"`，或 `token` 复制；可独立、段内、或包在 `figure view-type="Card\|Preview"` 中 | 保护；附件卡片/支持的预览和整体评论 |
| 白板 | `whiteboard type="blank\|mermaid\|plantuml\|svg"`；有图源时可用 `path`；或 `src` 复制 | 按下节区分图源编辑、预览和保护 |

列表项 `seq` 的归属还核对了该版本的[列表解析](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/doc/internal/docxparse/profile.go#L219-L239)，不要把起始编号放到自创属性上。

表格的 `colgroup` 紧跟 `table`，其 `col` 支持 `width` 和重复列数 `span`。`th/td` 支持 `background-color`、`vertical-align="top|middle|bottom"`、`colspan`、`rowspan`；合并覆盖的位置不再额外写单元格。表格不是电子表格，不能往普通 `td` 中添加自创公式属性来模拟云表格计算。

`callout` 的子块限 `p`、`ol`、`ul`、`checkbox` 及行内内容。不要在高亮块中嵌套表格、图片、代码块、分隔线、分栏、白板或其他资源块；本地暂时保留这种结构不代表官方接受。

颜色采用官方名字：基础色相为 `red, orange, yellow, green, blue, purple, gray`。`text-color`、`border-color` 用基础色相；`span/th/td/button` 背景还支持 `light-{色相}`、`medium-gray`；`callout` 背景支持 `gray`、`light-{色相}`、`medium-{色相}`。这里列出合法取值，不规定文章怎样配色。云回读可能返回规范化颜色值，应保留已回读属性，不能因为格式变化就判为内容丢失。

## 图片、附件与图源

本地稿件优先引用随稿提供的文件，例如 `path="@./assets/photo.png"`。本应用按 XML 所在目录解析受支持的资源，路径不跨出目录、不使用绝对路径、`..`、反斜杠或远程 URL；资源必须是实际可读取的普通文件。静态浏览器版还需要用户授予相应目录权限。

直接运行官方 CLI 时，把当前工作目录设为稿件目录，避免解析到另一份同名文件。所固定版本的[资源解析源码](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/doc/doc_resource_path.go)优先查询工作目录，仅在相对资源不存在时才尝试正文文件所在目录。本项目发布正文时显式以文章目录执行 CLI；不要假定其他宿主和 CLI 版本也自动这样处理。

| 输入 | 官方行为 | 本地和交付要求 |
| --- | --- | --- |
| `img path="@./assets/photo.png"` | 上传本地图片 | 附带图片文件；正文里只有路径不包含图片字节 |
| `img href="https://…"` | 下载公开 HTTP(S) 图片后上传，格式为 PNG/JPEG/GIF/WebP，单图不超过 20 MiB | 本应用不自动下载该地址；离线稿件请先取得可分发文件并改用 `path` |
| `img src="真实 token"` | 复制已有图片 | 必须真实且有权限；离线显示另需本地缓存映射 |
| `source path="@./assets/report.pdf"` | 上传附件 | 文件名、内容与后续文字都应回读核对；附件预览能力取决于类型 |
| `source token="真实 token"` | 复制已有附件 | token 不是文件路径，也不是文档 ID |
| `whiteboard type="mermaid\|plantuml\|svg" path="@./assets/图源文件"` | CLI 读取图源并创建画板 | 附带原文件；本地支持的预览与云端转换结果需分开核对 |

Mermaid 可直接内联。下面的 `&gt;` 是 XML 转义，解码后仍是 Mermaid 箭头：

```xml
<whiteboard type="mermaid">flowchart LR
  A[本地稿件] --&gt; B[阅读与评论]
  B --&gt; C[修改稿件]
</whiteboard>
```

内联 SVG 应自包含，使用真实节点和 `viewBox`，不要引用脚本、外部图片或远程字体：

```xml
<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100">
  <rect id="draft-box" x="20" y="20" width="280" height="60" rx="8" fill="#eef2ff" stroke="#4f6cd5"/>
  <text x="160" y="57" text-anchor="middle" font-size="20" fill="#24292f">本地稿件</text>
</svg></whiteboard>
```

本地 Mermaid/SVG 内联白板没有 `src/token/path` 时可在侧栏编辑图源；文件图源和已有云 token 不等于可直接编辑的原图源。SVG 预览会移除活动内容和越界引用，原 XML 保留；这不是官方画板节点转换器。飞书会重新布局或转换 SVG，部分效果不支持，不能承诺逐像素相同。固定官方版本明确限制 `pattern`、`clipPath`、`mask` 和非阴影用途的 `filter`；细节按上方白板来源核对。

`type="blank"` 表示创建真正的空白画板，不能代替尚未实现的复杂图。PlantUML 不在本地编译，需已有缓存才有实际预览。仅回读到画板 token 时，下载的预览也不能逆推出原 Mermaid、SVG 或全部飞书内部节点。复制已有画板使用官方输入 `src`；保留原回读 `token` 不代表可以凭空生成新画板身份。

## 扩展标签与保护内容

下列语法来自固定版本的官方扩展说明。本地编辑器目前将这些业务结构保留为保护内容；不执行 HTML，不提供完整云卡片或电子表格内部编辑器。需要写入时必须先满足对应真实身份和官方权限，表中的占位词不是可发布 ID。

| 标签 | 官方主要输入与约束 |
| --- | --- |
| `cite type="user"` | `user-id` 必须是实际用户 `open_id`，不是显示名称 |
| `cite type="doc"` | `doc-id` 为实际文档 token |
| `cite type="citation"` | 只包含 `a href="…" url-type="…"`；`5` 为网页且必须有标题；`1/6/12/13` 分别为 Docx/Minutes/Base/Sheet，可留空标题 |
| `bookmark` | `name`、`href` |
| `button` | `action="OpenLink\|DuplicatePage\|FollowPage"`，可选 `src`、`background-color`，标签内为文字 |
| `time` | `expire-time`、`notify-time` 为毫秒时间戳；`should-notify="true\|false"` |
| `sheet` | `type="blank"` 新建空表；或同时使用实际 `sheet-id` 与 `token` 复制已有表，不含本地任意单元格 JSON |
| `task` | `task-id` 为实际任务 GUID |
| `chat_card` | `chat-id` 为实际聊天身份 |
| `sub-page-list` | 仅 Wiki 文档可插入 |
| `html5-block` | 新写使用 `path="@./widget.html"`；回放 `data-ref` 需要原 `reference_map` 与实际 HTML |
| `okr` | 创建时仅 `<okr cycle-id="实际周期 ID"/>`，不自行构造 O/KR 子树 |

HTML5 的正文占位与内容要配套保留：例如 `<html5-block data-ref="html5_1"/>` 对应 `document.reference_map["html5-block"]["html5_1"]`，其 `data` 保存 HTML，或由 `path` 指向文件。普通写稿优先用明确的 `path`；重放已有引用时使用官方 `--reference-map` 参数。本项目创建接口目前不单独接收 `reference_map`，不能承诺将任意回读包直接新建到另一篇文档。

官方 HTML5 文件是独立的完整单文件 HTML，长度上限 500 KB，`head` 显式包含 `use-iframe=true`、`html-box-height-mode=auto|viewport` 和 `description` 元信息。它不是正文里任意内联的 `<div>`，本地也不会执行其中交互代码；不要为了预览把 HTML 直接塞入本地页面。

OKR 回读可含 `okr-objective`、`okr-key-result`、`okr-progress`。业务 ID 和描述不是随意可改的正文：官方说明仅允许相应进展和状态字段更新，`percent/score` 范围 0–100，`status` 为 `unset/normal/risk/extended`。需要更新 OKR 时查固定扩展来源及其业务接口，不把回读树当作新建模板。

未列出的标签、属性或本地未识别结构应保留原文并说明未验证；不要添加私有标签模拟一个“可发布”能力。特别是本地 `anchor.target`、`resources`、`contentSync` 等属于 JSON 协议，不应写成云正文标签。

## ID、发布与回读

新稿不需要文档 ID、块 ID 或评论 ID。若从已有稿件继续改，保留回读得到的身份；不要复制到另一文档后仍声称它们属于新文档。本地项目 ID、云文档 ID、正文块 ID、资源 token、白板内部节点 ID、评论 ID 分别服务于不同对象，不能互换。

本项目准备创建或替换的交换正文时，去掉文档层的 `id`、`comment-refs`，保留白板内部 ID，例如上述 SVG 的 `draft-box`。不要全局搜索删除所有 `id`，否则 SVG 引用可能断开。真实云 ID 由发布后的完整回读取得，无法可靠迁移的评论引用标为待确认。

网页服务版和 Obsidian 同步扩展提供“预览同步 → 选择方向 → 确认拉取/推送”；基础插件和静态浏览器版只处理本地。发布后核对正文、资源、真实 ID 和版本，再采用云回读，更新前保存正文与评论快照。资源或结果不完整、发生并发改稿时不把旧稿直接覆盖。恢复快照也先预览，只恢复本地。具体流程和备份边界见[项目与同步](projects-and-sync.md)。

## 最小文章与本地校验

可直接复制[最小文章文件](../examples/writing-minimal.xml)，用任一版本打开后编辑、评论。它不含云 ID、私有路径或外部资源依赖：

```xml
<title>本地写稿示例</title>
<p>先在本地阅读、评论和修改，再决定是否关联飞书。</p>
<h1>本次改动</h1>
<p>保留 <b>正文</b> 和 <em>反馈</em> 的边界：1 &lt; 2，A &amp; B。</p>
<ul><li>编辑正文</li><li>留下评论</li></ul>
<h2>核对结果</h2>
<table><colgroup><col width="180"/><col width="280"/></colgroup>
<thead><tr><th><p>项目</p></th><th><p>结果</p></th></tr></thead>
<tbody><tr><td><p>本地文件</p></td><td><p>等待核对</p></td></tr></tbody></table>
<checkbox done="false">确认内容后再发布</checkbox>
```

更多结构见[综合样稿](../examples/compatibility.xml)、[本地资源](../examples/local-resources.xml)、[白板图源](../examples/whiteboards.xml)。样稿用于格式覆盖，其中的说明文字、示意身份不应原样当作用户文章发布。

上游更新时，先比较上述固定版本的语法参考、解析器与资源行为，再核对本地适配和样例，最后修改本页采用的 commit。未经验证的变化不能通过更新外链静默进入当前契约；旧版本验收留在 `docs/archive/`。

维护此协议时运行：

```sh
npm test -- tests/writing-protocol.test.ts tests/docxml.test.ts
```

检查覆盖本页 XML 片段与最小样稿的本地解析、原文保留、交换格式再解析，以及真实编辑器中的样稿编辑。它不会调用 CLI、登录或写云，也不验证服务端支持或飞书视觉一致性。新增标签若只有本地测试，能力矩阵应仍写“未完成云端验收”；实际发布后还需对照本地显示、磁盘文件和同一飞书文档。
