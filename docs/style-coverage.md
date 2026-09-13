# 飞书样式覆盖与对照测试矩阵

核查日期：2026-09-12。公开测试母稿是 [compatibility.xml](../examples/compatibility.xml)，以 `S00–S13` 编号定位，素材为 [colors.png](../examples/assets/colors.png)；增量 [local-resources.xml](../examples/local-resources.xml) 以 S14 覆盖本地图片、附件、同名文件和 CSV 上传，[whiteboards.xml](../examples/whiteboards.xml) 以 S15 覆盖四种白板，[Sheets 往返输入](../examples/sheet-roundtrip.md) 用于单元格离线校验。内容不含私有标识或伪造资源 token；可公开的测试材料不代表测试文档已开放公开访问。

本表区分原始样稿、本地回读工作副本与同一份飞书文档。**保留 XML、显示占位、云写入成功和完整三方验收是不同结果。** 已显示的属性也不表示工具栏提供对应的创建或设置入口。

## 当前验收结论

- 专用测试稿的纯 bot 读写权限已验证；本轮使用隔离测试身份。
- 原始 XML 与本地图片、附件、Mermaid 和空白白板经官方协议完整发布，revision 29 完整回读已取得。不是将 HTML 粘贴样例当作协议起点。
- revision 29 的独立结构比对发现 S10.F1 附件后 12 个字符（含前置空格）真实丢失，原生块也没有对应尾文。发布用的旧官方构建未包含已有修复；含修复的候选仅替换该段，revision 31 的完整回读已确认尾文恢复。兼容 CLI 已有同类修复，定向回归通过。
- 图片下载字节与本地原图一致；Mermaid 源码、原生节点与预览，以及空白白板预览均已取得。本地回读工作副本使用旁置 JSON 的 `resources` 映射显示这些真实资源，官方 XML 中的原引用保留。
- 四份附件已下载，各为 1532 字节，与公开 PNG 素材逐字节相同。真实回读稿已呈现一个行内附件、一个 Card 和两个 Preview，图片解码为 720×180；本地与 Chrome 截图已保存，浏览器无错误或警告。附件内部仍不可编辑，不支持 PDF/HTML 内容预览。
- 三栏已通过兼容 CLI 原生 `update-grid` 设置为 25/50/25；revision 37→38 的完整 XML 仅改变三个 `width-ratio`，所有原块 ID 和正文不变，本地实际栏宽为 86.75/173.5/86.75。官方 XML 写入服务将比例变为等宽的问题尚未修复，已验证的是补充原生命令及回读。
- S14 从本地素材经兼容 CLI 纯 bot 追加，revision 47→55，1 张图片与 6 份附件共 7 次上传和绑定完成。官方 CLI 独立 full fetch 与兼容 CLI 相同，7 份官方下载文件的 SHA-256 均与各自原始文件一致；同名 `note.txt` 121/99 字节未错绑。原 XML 是回读的完整字节前缀，165 个既有块 ID 保留。Card/Preview、图片 720×180 与 scale=.5、行内两附件前中后文的结构核对通过。本地与 Chrome 页面已实际核对：图片自然尺寸 720×180、本地显示 360×90；TXT 卡片 121/99 字节、CSV 卡片 67 字节正确，PNG Preview 成功，浏览器无错误或警告，XML/JSON 与云回读一致。窗口不同，不声明像素完全一致，TXT/CSV 只有卡片显示。
- S06 已有 Go/JavaScript 高亮和行号，未知语言显示普通代码；代码区域禁用拼写检查。实际 DOM 编辑、跨行注释、emoji 评论位移、撤销重做和只读复制回归通过，高亮与行号不进入 XML、评论位置或复制正文。本地浏览器实际输入临时字符后，XML 与 JSON 自动保存且不含高亮标记；撤销后两份正文恢复为 revision 55 云回读的完整原文。两端代码截图已核对，此次没有把临时代码写入云端。
- 警告 emoji 改变、新增空段落等差异仍未解决；本轮把 ⚠️ 去掉变体选择符后重试仍返回 💡。电子表格仍为保护占位；不能声称全样式完成或像素完全一致。
- **C1 已在公式样例通过**：本地选中公式评论、指数 2→3 自动落盘，兼容 CLI 按官方协议局部写回，revision 32 full fetch 与 Chrome 画面确认；两端已恢复为 2，revision 34 与对应本地 XML、JSON 快照逐字一致并归档。S14 轮的工作副本更新至 revision 55，与官方完整回读及旁置 JSON 正文快照一致，两条已解决评论及 10 项资源映射保留。其他格式不能据公式验收计为编辑回写通过。
- **S15 白板协议**：兼容 CLI 显式 bot 追加四种 typed 白板，revision 56→57，官方独立完整 `document` 与兼容 CLI 相同，183 个既有块 ID 和旧 XML 完整字节前缀保留。Mermaid/SVG/PlantUML/blank 分别为 9/13/8/0 个原生节点；空白响应 `nodes:null` 按空集合记录。Mermaid/PlantUML 原生图源与输入去首尾空白后逐字相同，SVG 六个文字标签完整；四份真实 JPEG 预览均为 2560×2560。三种非空白板已在 Chrome 与本地实看，SVG 三卡片六标签及配色、PlantUML 三条生命线四条消息相符；三份云 SVG 的 viewBox 与本地 DOM 精确相同。Mermaid 连接标签紧贴曲线、白底遮罩与飞书页面不完全一致，保留该差异，不声明像素一致。
- **本地入口与真实编辑**：Mermaid 浏览器改“本地初稿”为“本地修订稿”，XML/反馈一致落盘、撤销重做，兼容 CLI 在 revision 58→59 仅替换一个白板；其余正文不变，官方回读相同，原生 9 节点含新图源，正式 tenant 读取 smoke 通过。SVG 真实改源保持 `<svg>` 子元素、CLI dry-run 和撤销恢复通过，该次改字未云写。云引用、PlantUML、blank 与 `path` 源不提供内部编辑。资源树只列当前正文、反馈和引用文件；SVG 在树中只读源码，在正文白板中通过受限读取和清理后显示精确云缓存。主稿已用 CAS 同步 revision 59，18 项资源映射和两条原评论保留。
- **正文外观**：白底与默认黑灰文字已用 S03 两端截图核对，原文显式颜色保留。本轮 150 项测试、类型检查与构建通过。
- **Sheets**：兼容 CLI 的 `+cells-get/+cells-set/+sheet-info`、3 份公开写入 payload 的官方 schema 校验和 6 次离线 dry-run 通过；真实读取报 `99991672 app_scope_not_applied`，缺少 `sheets:spreadsheet:read`，写入另需 `sheets:spreadsheet:write_only`。当前没有云端单元格写入、公式计算或本地电子表格渲染验收，文档可编辑权限不能代替应用 scope。

## 依据与证据

语法依据为本次已读取的官方 checkout `b8b21da3a57b5634b0dc6f5074d479f1e751e658`：

- [DocxXML 基础语法](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-xml.md)、[扩展块](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-xml-extended-blocks.md)、[白板](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-whiteboard.md)。
- [完整 fetch](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-fetch.md)、[create](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-create.md)、[update](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/skills/lark-doc/references/lark-doc-update.md)。

附件修复另使用现有 contribution `ecfd5db`，构建候选为 clean HEAD `b059697`；它在发送前将段落内附件单独包入中性 `span`，保留后续正文与资源绑定。构建和针对性回归不代替线上验证，本轮已有对应 revision 31 回读。

本地实现依据：[XML 适配器](../src/core/docxml.ts)、[编辑器扩展](../src/ui/xml-extensions.ts)、[颜色](../src/ui/docx-color.ts)、[资源解析](../src/core/resources.ts) 和 [样式](../src/ui/styles.css)。

| 编号 | 证据与范围 | 当前结果 |
| --- | --- | --- |
| A | [docxml.test.ts](../tests/docxml.test.ts)：真实 Tiptap 初始化、格式保留、连续编辑、撤销、异常保护；包含官方回读 `pre/code/br` 及六位小数分栏 | 本地自动化回归通过 |
| B | [anchors.test.ts](../tests/anchors.test.ts)：重复文本、跨段、表格、emoji、公式、资源原子节点与删除定位 | 本地自动化回归通过；原子节点按整块评论 |
| C | [reader.test.tsx](../tests/reader.test.tsx)：外部改稿清除旧历史、粘贴事务、评论草稿和公式编辑 | 本地编辑器回归通过，不冒充浏览器视觉证据 |
| H | [code-highlighting.test.tsx](../tests/code-highlighting.test.tsx)：Go/JavaScript、真实 DOM 编辑、多行事务、emoji 评论、撤销重做和只读复制 | 6 项回归通过；文本和 HTML 复制不含标题、行号或高亮标记；代码 spellcheck=false |
| F | [compatibility.test.ts](../tests/compatibility.test.ts)：公开原始样稿初始化、未改原样输出、改 S00 与左栏后保留其他结构 | 回归通过；只覆盖该原始样稿，不代替真实云回读稿 |
| M | [resources.test.ts](../tests/resources.test.ts)：精确资源选择、图片与栅格附件原图、Card/Preview、白板预览、图片 scale、资源刷新和无损 XML | 回归通过；不自动下载、不根据 token 相似度猜测；附件缓存刷新保留选区、评论位置及撤销 |
| P | 同一源稿官方发布 revision 29、完整 fetch；S10.F1 原生块核查、修复后 revision 31 full fetch | 写入和回读已执行；逐项结构结论见下表，已知差异未掩盖 |
| D | 真实图片、四份栅格附件原字节、Mermaid 源与原生 nodes/preview、blank preview | 已下载；四附件均为 1532 字节，与素材逐字节一致；本地映射已建立，图内节点编辑未实现 |
| V | 本地内置浏览器与飞书 Chrome 截图、真实编辑及评论落盘、公式/图片/附件/白板检查 | 已有实际证据；附件预览成功解码为 720×180；窗口正文宽度不同，未做全稿同宽逐像素验收 |
| G | 兼容 CLI 原生 update-grid 25/50/25，revision 37→38 full fetch 及本地 DOM 栏宽 | 仅三处比例属性变化，原块 ID/正文保留；不计官方 XML 服务的写入修复 |
| U | S14 本地资源输入、兼容 CLI 追加 revision 47→55、官方独立 full fetch、7 项下载及 SHA-256 | 上传、绑定、结构与原文件字节核对通过；165 个既有 ID 和完整 XML 前缀保留；S14 本地与 Chrome 视觉核对通过，窗口不同，不计逐像素验收 |
| W | S15 初次创建回执、browser-mermaid-validation.json、browser-svg-validation.json、原生节点/云 SVG 导出和两端截图 | 四种创建与回读、Mermaid 实际改图后云写闭环通过；SVG 实际改源/协议 dry-run/撤销通过但该次未云写；三种非空图视觉核对通过，Mermaid 标签遮罩仍有差异 |
| S | Sheets 官方 scope 错误回执、公开输入官方 schema 检查、6 次候选 dry-run、CLI mock | 只证明离线协议与失败分类，不计 Sheets 云端读写或本地显示通过 |
| R | 早期 HTML 粘贴与飞书原生 UI 建立的独立外观样例 | 仅为历史辅助参考；当前协议证据使用同一原始 XML 的 P 链路 |
| C1 | 回读工作副本本地编辑保存 → 官方协议更新同一目标 → 再次 full fetch → 本地与云端核对 | 公式编辑、评论、落盘、兼容 CLI 更新、full fetch、两端画面与恢复通过；全样式一致性仍未通过 |

下表的“P 一致”仅指已取得的协议结构比对；除明确列出的局部操作外，不表示已在本地编辑该格式并回写成功。保护节点不能在本地编辑内部，原 XML 随周围正文保存。

## 常用排版

| 样稿位置 | 特性 | 本地呈现与编辑 | 本地依据 | 同稿云端结果与待验项 |
| --- | --- | --- | --- | --- |
| 标题、S01 | `title`、`h1–h9`、`seq="auto"` | 标题层级和自动编号可呈现、文字可改；无编号设置入口 | A、F | P 层级与文字一致；编号增加服务端 marker，间距和全链路编辑待 V/C1 |
| S02.L/C/R | 左、中、右对齐 | 已实现，可改正文；无对齐工具栏 | A | P 对齐属性保留；精确布局待 V |
| S02.F | 粗体、斜体、下划线、删除线、行内代码与组合 | 已实现；工具栏提供部分常用格式 | A、F | P 文字与基础 mark 覆盖范围一致；b/span 嵌套次序变化不视为丢失 |
| S02.B/E | 换行、空白、转义、中文与 emoji | 正文可改，按 UTF-16 定位 | A、B | P 文本一致；组合字符外观需结合 V |
| S02.A | 普通链接、`url-preview` | 普通文字链接；无飞书卡片编辑器 | A | href 和文字保留；回读省略 `type="url-preview"`，原生预览语义未通过 |
| S03 | 文字色与背景色 | 支持命名色及回读 RGB/RGBA；无颜色选择器 | A、F | P 将命名色转成数值颜色；24 个命名色按上下文映射有实证，真实 DOM 的 22 处有效颜色一致，S03 两端截图复核通过；未验证命名色不猜测 |
| S04 | 无序、有序及混合列表，起始 `seq="3"` | 项目可改、可切换无序列表 | A | P 文本、项目与层级保留，自动编号字段被规范化；细节待 V/C1 |
| S04.T1/T2/T3 | 待办状态与右对齐 | 编辑模式可勾选，只读模式保持；对齐属性保留 | A、F | P 完成态与文字保留；复选框对齐布局待 V |
| S05.Q/H | 多段引用、分隔线 | 已实现，引用正文可改 | A | P 结构与文本保留 |
| S05.C1/C2 | 高亮块、图标及列表/待办子块 | 可改正文和待办，无创建工具栏 | A | P 子块与正文保留；配色回读为 RGB/RGBA |
| S05.C3 | 高亮块警告 emoji、背景/边框/文字色 | 颜色字段保留并按上下文呈现 | A、F | **差异：⚠️ 变为 💡**；去掉 FE0F 后的 ⚠ 仍返回 💡，未修复 |
| S06 | 代码 lang/caption、空行、缩进与转义 | Go/JavaScript 高亮与行号，代码可改并评论；未知语言为普通代码，无语言/标题设置入口；支持回读 br 换行 | A、F、H | P 两段代码与语言一致；caption 多出末尾换行，代码换行转为 br，按内容规范化后相等；高亮和行号不写回 XML 或改变评论位置 |

## 表格、公式与分栏

| 样稿位置 | 特性 | 本地呈现与编辑 | 本地依据 | 同稿云端结果与待验项 |
| --- | --- | --- | --- | --- |
| S07.A/B | 两张表、单元格富文本与换行、thead/tbody | 原生表格节点，文字/格式可改并评论 | A、B、F | P 单元格文字、分组和结构一致 |
| S07.B | colspan/rowspan 合并 | 合并正文可改，无合并工具栏 | A、F | P 合并属性一致 |
| S07.A/B | colgroup、col width/span | 已映射列宽，无宽度设置入口 | A、F | P 等效宽度为 `[320,160,240]` 与 `[200,260,260]`；第二表 span=2 展开为两列，不能报成列宽丢失 |
| S07.A/B | 单元格背景与 vertical-align | 支持 RGB/RGBA 和对齐属性，内容可改 | A | P 垂直对齐一致；背景按表格角色与回读值对齐，实际 DOM 回归通过 |
| S08.A/B/C | 四个 latex：相邻正文、上下标、分式、求和及矩阵 | KaTeX；已有公式可选中后在侧栏改源码并应用；无新建入口 | A、B、C、F、V | P 四个表达式逐字一致；S08.A 已完成 C1 修改、评论、写回与恢复；其他公式只验证保留和呈现 |
| S09.A | 双栏 0.5 + 0.5 | 原生分栏，栏内可编辑 | A、F | P 比例回读为 .500000，等效一致 |
| S09.B | 三栏 0.25 + 0.5 + 0.25 | 支持本地原比例及回读六位小数；无比例调整工具栏 | A、F、G | 原始 XML 发布回读为三个 .333333 等宽栏；现用原生 update-grid 补充设为 25/50/25，revision 38 三个比例正确且 ID/正文未变，本地栏宽 86.75/173.5/86.75。官方 XML 服务问题未修 |
| 不放入云创建稿 | 非法表格、分栏或无法渲染的公式 | 不支持结构保护，公式保留源码和错误 | A 负例 | 不作为合法云样例，不声称任意复杂结构可编辑 |

## 图片、附件与白板

| 样稿位置 | 特性 | 本地呈现与编辑 | 本地依据 | 同稿云端结果与待验项 |
| --- | --- | --- | --- | --- |
| S10.I | 本地 img path 与云回读 img src | 本地原图或精确 resources 映射可显示；节点内部保护，可整体评论 | A、B、F、M、V | P 上传和回读成功；D 下载字节与原图相等 |
| S10.I | width/height/scale/caption/name | 使用尺寸、scale 与说明文字，无属性编辑入口 | F、M | 回读 720×180、scale=.5 等效 360×90；**name 从中文名称变成 colors.png**；caption 追加末尾换行 |
| S10.F1 | 行内附件与后文 | 文件名及类型图标，周围正文可改；附件内部保护 | A、M、D、V | revision 29 丢尾文；原生块确认写入丢失。已有修复候选局部替换后 revision 31 full fetch 确认恢复；最新稿行内卡片和后文均在 |
| S10.F2 | 独立 source | 本地栅格原图预览，名称、类型及大小；附件内部保护 | A、F、M、D、V | P source 转入 Preview figure；真实缓存可呈现，下载原字节与素材一致 |
| S10.F3/F4 | figure Card/Preview | Card 显示名称、类型及大小；Preview 加载本地栅格原图；内部均保护 | F、M、D、V | 本地真实稿为一个 Card、两个 Preview，预览自然尺寸 720×180；未实现任意文件预览、文件内容编辑或与云端像素一致 |
| S14.I/F/CA/CB/P/CSV | 本地图片、两枚行内附件、同名文件、Card/Preview 和 CSV | 原图及 PNG 附件可显示；文本和 CSV 显示卡片，明确引用的文件可在资源树只读查看，内容仍保护 | M、U、V | 7 项上传与下载字节核对通过，同名 121/99 字节附件未错绑；图片显示属性等效 360×90；行内前中后文保留；S14 原轮卡片与 Preview 已三方核对，新增资源树文本入口另验 |
| S11.M、S15.M | 内联 Mermaid 与真实白板 token | 内联图源可编辑并预览，应用走正常保存和撤销；云引用可显示精确 SVG 缓存 | A、F、M、V、W | 实际本地改源→落盘→兼容 CLI 局部更新 revision 58→59→官方完整回读通过，9 节点含新图源；两端主要标签和连线核对，导出 SVG 的连接标签遮罩仍有差异 |
| S11.B | 空白白板创建与回读 | 原始 blank 显示画布；回读稿可显示真实预览 | A、F、M | P 创建及真实引用已取得，D blank preview 已下载 |
| S15.S | 内联 SVG；CLI 展开 SVG 文件 | 内联图源可编辑，保留真实 SVG 子元素；正文可安全显示精确云 SVG，资源树只读源码 | W；whiteboard-source/editor/resources 测试 | 云创建 13 节点与六标签保留，三卡片配色/标签及服务端 viewBox 与本地核对；真实改源/CLI dry-run/撤销通过，该次改字未云写 |
| S15.P | PlantUML 文件图源 | 不在本地编译或编辑 PlantUML 源；文件 path 或云 token 可精确映射下载的 SVG 预览 | W；原 XML 保护 | CLI 文件展开与云创建成功，8 节点、原生图源与文件 trim 后相同；两端三条生命线四条消息与标签核对，云 SVG viewBox 原样保留 |
| S15.B | blank | 显示空画布或真实下载预览，无画布内绘图工具 | W | 新建回读 0 节点、预览取得；空白成功不代表复杂白板功能通过 |
| 不含内联图源的既有白板 | whiteboard src/token/path | 精确资源映射可显示栅格或清理后的 SVG 静态预览，无映射显示未缓存；内部不编辑 | A、M、W | 本轮三份云 SVG viewBox 与本地 DOM 相同，范围、标签与配色已核对；复杂跨文档复制未验收 |

图片实物为 720×180 PNG，源稿请求显示为 360×90；附件复用该 PNG，不伪造 PDF 内容。本地路径相对 XML 所在目录。官方 CLI 的 `@path` 优先相对执行工作目录，必要时回退源 XML 目录，见 [路径解析](https://github.com/larksuite/cli/blob/b8b21da3a57b5634b0dc6f5074d479f1e751e658/shortcuts/doc/doc_resource_path.go)。发布前应确认实际文件，避免同名路径遮蔽素材。

本地 [resources 协议](protocol.md#已下载资源映射) 映射图片原图、附件文件和白板静态预览。附件使用独立的 `source + token` 选择条件，figure 读取其唯一直接 source 子节点；不复用 img token、不根据文件名猜测、不自动调用云服务。PDF、复杂未知 figure 仍受保护；HTML 只可在资源树作为受限文本查看，不执行。白板原生节点文件作为独立证据保存，不等同于本地可编辑节点模型。新资源树只读入口的限制见 [图源编辑与资源树](protocol.md#图源编辑与资源树)。

## 云动态块与引用资料

| 样稿位置 | 官方能力 | 本地呈现与编辑 | 同稿云端结果与待验项 |
| --- | --- | --- | --- |
| S12.B | bookmark name/href | 占位 / 保护 | P 创建与回读已取得；未提供原生书签外观 |
| S12.O | OpenLink button | 标签 / 保护，不在本地执行云动作 | P 链接与标签保留，button 包入 p；其他按钮动作未测 |
| S12.T | time，样稿 should-notify=false | 占位 / 保护 | P 时间戳与文字保留，标签文字移至 time 后；时区外观未完整验收 |
| S12.S | sheet type=blank；独立 Sheets 单元格协议 | **占位 / 保护，无表格内部编辑器** | P 已创建并回读真实 sheet 引用；S 的 CLI mock/schema/dry-run 通过，真实读取受应用 scope 阻塞，未云写单元格 |
| S12.1 | 人员/文档 cite、参考文献 | 占位 / 保护 | 尚缺独立真实样例，不用假身份或 token 冒充 |
| S12.2 | task、chat_card | 占位 / 保护 | 待专用测试实体及访问权限 |
| S12.3 | sub-page-list、OKR | 占位 / 保护 | 待独立云端样例与源数据 |
| S12.4 | HTML5 及完整 reference_map | 占位 / 保护，不执行 HTML | 待真实 HTML5 样例；仅 XML 不足以完整复制 |
| 扩展样例待准备 | Bitable、会议记录、同步引用块 | 占位 / 保护 | 待关联源及各自读取协议，未承诺完整往返 |

保真材料应保存 `--detail full` 的完整响应及其 `content`、`reference_map`（若返回）和资源。本次 revision 31 响应没有 `reference_map` 字段，不能据此编造映射或宣称云评论已验收。Lark Review 不直接导入整份 fetch JSON，不解释官方 `reference_map`；本地 resources 是显示缓存，不是可提交的官方映射。

官方云评论和本地 `.review.json` 是不同协议。当前未覆盖云评论导入、HTML5 完整映射与复杂媒体跨文档复制，真实标识只保留在受控材料。

## 同一稿件的文件与回执

| 材料 | 用途与当前状态 |
| --- | --- |
| examples/compatibility.xml、examples/assets/colors.png | 可公开原始样稿及素材；作为发布起点和结构比对基准 |
| .local/cloud-test/publish/source.xml | 本次实际发布输入快照；保留原稿，不能用回读稿覆盖它掩盖差异 |
| .local/cloud-test/after-publish2.official.full.json、after-publish2.xml | revision 29 的完整回读；包含已发现的附件尾文丢失等差异 |
| .local/cloud-test/structure-comparison.private.json | revision 29 的独立逐节、marks、表格、公式、列宽与资源结构报告；不自动代表修复后的状态 |
| .local/cloud-test/native-inline-attachment-network.json | S10.F1 原生块只读证据，确认尾文不是仅被 full fetch 遗漏 |
| .local/cloud-test/inline-tail-fixed.official.json、after-tail-fix.full.json、after-tail-fix.xml | 仅修复 S10.F1 的写入回执与 revision 31 full fetch；已核对尾文恢复 |
| 公式往返的完整回读与恢复记录（私有） | 历史 revision 34 full fetch、完整原文及公式闭环回执；保留作为当次证据 |
| .local/cloud-test/grid-width-validation.json、after-grid-width-update.json、after-grid-width-update.xml | 原生 update-grid 的 revision 37→38 回执、三处比例 diff 和官方完整回读 |
| .local/cloud-test/attachments-byte-validation.json | 四附件各 1532 字节，与公开 PNG 素材逐字节相同的核对记录 |
| .local/cloud-test/roundtrip.xml、roundtrip.review.json；sheet-board-iteration/after-main-sync.json | 主稿通过 CAS 同步 revision 59，与官方完整回读及 JSON 正文快照一致；两条已解决原评论、18 项资源映射保留 |
| examples/local-resources.xml、examples/assets/resource-a/、resource-b/、resource-check.csv | 可公开 S14 输入；同名 note.txt 使用不同正文与字节数，CSV 不冒充可编辑 sheet |
| .local/cloud-test/resources-iteration/input.xml、input-manifest.json、append.json、after-append.json、after-append-official.json、byte-validation.json | S14 输入与逐资源快照、revision 47→55 追加回执、双方独立回读和 7 项 SHA-256 核验 |
| .local/cloud-test/resources-iteration/downloaded/ | S14 图片和 6 份附件的原始下载；分别核对，不按同名文件猜测绑定 |
| examples/whiteboards.xml、examples/assets/review-map.svg、review-sequence.puml | 公开 S15 源稿与文件图源，无真实云引用 |
| .local/cloud-test/sheet-board-iteration/whiteboard-validation.json、after-whiteboards.json、after-whiteboards-official.json、各类型 nodes/preview | S15 revision 56→57、183 个既有 ID、源代码/标签及真实 JPEG 2560×2560 的离线复核；下载的历史文件后缀为 .png，实际字节与 MIME 为 JPEG，以内容为准 |
| .local/cloud-test/sheet-board-iteration/browser-mermaid-validation.json、browser-svg-validation.json、after-browser-mermaid-official.json | Mermaid 实际浏览器改源、保存、撤销重做、revision 58→59 云写与独立回读；SVG 实际改源保留子元素、CLI dry-run 与撤销，仅本地验证 |
| .local/visual-evidence/S15-cloud-board-mermaid.png、S15-cloud-board-svg.png、S15-cloud-board-plantuml.png、S15-local-cloud-svg-preview.png、S15-local-plantuml-preview.png | 三种非空白板两端实看与已保存截图，SVG 三卡片/六标签/配色、PlantUML 三生命线/四消息核对；Mermaid 标签遮罩差异保留 |
| .local/visual-evidence/S03-local-neutral.png、S03-cloud-neutral-reference.png | 白底、默认黑灰文字和原稿显式颜色两端核对 |
| examples/sheet-cells.json、sheet-edit.json、sheet-restore.json、sheet-expectations.json；.local/cloud-test/sheet-board-iteration/sheets-fixture-validation.json | 6×5 单元格输入与精确 B3 修改/恢复，官方 schema 与 6 次离线 dry-run 通过；预期 D6 90→106→90 是本地计算，未经云端公式回读 |
| .local/cloud-test/resources/ | 图片原图、四份附件、两张白板预览与 Mermaid 原生 nodes；资源下载与本地映射已完成 |
| .local/visual-evidence/S10-local-attachments-v38.png、S10-cloud-attachments-v37.png | 真实本地附件展示与 Chrome 云端附件截图；其间仅修改三栏比例，附件未改 |
| .local/cloud-test/resources-iteration/validation.json；.local/visual-evidence/S14-cloud-resources.png、S14-local-resources.png、S14-local-cards-preview.png | S14 上传、回读、原文件、工作副本与三方视觉回执；图片 720×180→360×90、TXT 121/99 字节、CSV 67 字节和 PNG Preview 已核对；浏览器无错误或警告 |
| .local/visual-evidence/、.local/style-test/ | 私有截图与本地实际操作证据；窗口宽度不同，不充当全稿像素一致证明 |
| 专用飞书文档 | 同一 XML 发布及回读的目标；链接、真实 ID 和权限回执只在 .local，未宣称公开访问 |

原稿没有预置官方块 ID，revision 29 返回的 165 个 ID 唯一；这只能证明该次返回无重复，不能证明 overwrite 保持此前已有 ID。后续更新应使用新鲜回读和版本回执，而不是依赖旧锚点。

另保留 [compatibility-paste.html](../examples/compatibility-paste.html) 作早期外观参考。当前同一文档已使用完整 XML 正式发布，历史浏览器粘贴结果不再作为协议成功证据。

## 剩余验收

1. 扩大 C1：公式样例已完成修改、评论、落盘、兼容 CLI 回写、回读和恢复；其他尚未实际编辑的结构仍只记“保留”，继续逐项覆盖。
2. 对最新回读结果补齐同稿、同正文宽度的分节视觉比对。三栏已有原生命令补充设置与实际栏宽证据，官方 XML 写入仍需单独修复；emoji 变化、额外空段落、链接预览属性及图片名称差异继续保留。
3. 对评论与原子节点在该真实回读稿上的定位、删除、外部更新和撤销建立对应证据。已有本地回归与原始样稿操作可复用为基础，不能冒充每个云格式都已完成编辑回写。
4. 栅格附件 Card/Preview 的下载、字节核查及本地呈现已完成；任意附件内容预览或编辑、sheet、HTML5、引用和复杂云动态块继续按各自协议准备样例，保护占位不计原生内容呈现通过。

本轮 150 项测试、类型检查与构建通过，覆盖资源树、安全文本读取、内联白板编辑、SVG 真子元素与精确云 SVG 缓存。上一轮 125 项测试、代码调整后的 52 项定向回归属于历史验证。此前 113 项测试及公式闭环记录保留在 `.local/cloud-test/three-way-validation.json`、`tests-final.log` 与 `build-final.log`；较早附件与三栏结果分别见 `attachments-byte-validation.json` 和 `grid-width-validation.json`，S14 增量以 `resources-iteration/` 的对应回执为准，S15/Sheets 以 `sheet-board-iteration/` 为准。所有私有链接、原始响应、媒体引用和凭据仅留在受控本机存储，不进入公开文档。


## 白板组件评论增量

2026-09-12：本地 inline SVG、Mermaid flowchart 和真实云 SVG 缓存已支持组件选择、评论、高亮与引用定位；旁置 JSON 保存 board/id，旧整块评论兼容。Chrome 原生组件评论、兼容 CLI 块级创建、回复、解决/恢复已实际核验。公开 API 的内部节点锚点缺口、栅格缓存及原生拖拽限制详见 [本轮验收](whiteboard-comments-2026-09-12.md)，不宣称完整飞书白板对齐。

## 发布回读与 Mermaid 外观增量

2026-09-13：已用另一份专用全样式稿只读核对本地源文件、最新云 XML 和两端视觉。Mermaid 本地样式改为扁平、紧凑及自然宽度居中；当时的发布策略要求核对差异并再次确认后才更新本地；当前策略已调整为明确推送成功后自动更新并存档旧稿，见 [同步指南](projects-and-sync.md)。真实副本回读、18 项资源下载、原稿不变证明及仍存在的三栏、图标、原生画布空白等差距见 [验收记录](readback-and-layout-2026-09-13.md)。
