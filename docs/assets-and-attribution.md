# 本地飞书文档：资源来源与分发边界

核对日期：2026-09-14。适用项目：**本地飞书文档 / feishu-doc-local**。

本清单区分项目随附素材、依赖提供的图标与字体，以及用户打开文档后产生的私有资源。项目的 MIT 许可不重新授权用户文档、飞书下载内容或第三方字体。第三方许可总入口为 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，完整文本在 `licenses/` 和对应依赖中保留。

## 随仓库分发的素材

本清单覆盖公开样例内嵌 SVG / Mermaid、UI 资源引用、产品截图和构建脚本。样例的独立视觉素材是 `colors.png` 和 `review-map.svg`；产品截图使用本仓自有样稿在本地界面生成，不包含真实飞书页面、私人稿件或云端素材。构建产物另外包含依赖提供的图标和字体，不能只检查 Git 中的图片扩展名。

| 位置 | 内容与来源证据 | 分发方式 |
| --- | --- | --- |
| `examples/assets/colors.png` | 项目自绘的 720 × 180 RGB 图片，仅背景和三个纯色矩形。`scripts/generate-example-colors.mjs` 明确记录像素尺寸、坐标和颜色，可离线重建；没有文字、标志或外部图片输入。 | 项目示例，适用项目 MIT 许可。 |
| `examples/assets/review-map.svg` | 项目自绘的三个矩形、六行中文和连接线。完整几何源码直接保存在 SVG；没有外部图片、嵌入字体或远程引用。 | 项目示例，适用项目 MIT 许可。 |
| `examples/demo.xml` 中的 SVG 与 Mermaid；`examples/whiteboards.xml` 中的 Mermaid | 本地文件、人类评审、AI 修订、发布流程的示例图源。SVG 是明确的矩形、文本、箭头；Mermaid 是可读的流程定义，无外部图标包或图片。 | 图源随示例分发，适用项目 MIT 许可；渲染器保留自己的许可。 |
| `examples/assets/review-sequence.puml` | 项目编写的人类、本地文件、AI 三方交互示例，四条消息。原始文本是来源；没有随附 PlantUML 程序或云端导出图片。 | 示例图源适用项目 MIT 许可。自行生成或下载的预览另行核对来源。 |
| `examples/assets/resource-check.csv`、`resource-a/note.txt`、`resource-b/note.txt` | 项目编写的资源树与文本预览测试材料，不含外部插图。 | 适用项目 MIT 许可。 |
| `examples/compatibility.xml`、`local-resources.xml`、`compatibility-paste.html` | 项目编写的排版兼容性用例；图片复用 `colors.png`，公开链接是可点击文本而非下载的站点素材。 | 适用项目 MIT 许可。 |
| `examples/showcase.xml` | 本轮编写的公开产品演示文章，内容为本地文章、人类评审与 AI 修订，使用自有 Mermaid 图源；无用户文章、账号、文档 token 或私人路径。 | 示例图源与文字适用项目 MIT 许可。 |
| `docs/images/editor-review.jpg`、`document-outline.jpg` | 之前使用公开演示内容在本地产品界面生成，评论为演示数据；不含电脑桌面、浏览器账号、真实云端页面或私人文件位置。 | 产品说明素材；保留界面中第三方图标和字体原有许可。不作为真实 Obsidian GUI 或云端往返的验收证据。 |
| `docs/images/browser-table.jpg` | 2026-09-14 使用 `examples/compatibility.xml` 的 S07 表格内容整理公开样稿，在真实浏览器的本地产品界面截图，展示普通表格、列宽、背景与合并。界面中的文件路径、项目关联均为演示配置。 | 产品说明素材；保留界面中第三方图标和字体原有许可。不包含私人稿件或真实飞书页面。 |
| `docs/images/sync-preview.jpg` | 2026-09-14 在实际产品的完整「正文同步预览」窗口截图，使用上述公开样稿；同步另一侧为本地合成数据，修改一处表格文字以展示差异。未连接飞书，不是云端返回内容。 | 产品说明素材；保留界面中第三方图标和字体原有许可。仅演示界面和确认流程，不作为云端回执或往返验收证据。 |
| `src/ui/whiteboard-preview.ts` 的 `type="blank"` 空态 | 原生 HTML / CSS 绘制白底边框和“空白画板”文字，无图片、SVG、字体下载或平台插图。 | 产品自身界面，适用项目 MIT 许可。 |
| `tests/` 内联 SVG | 小型矩形、路径、文字和安全处理测试片段；不作为产品插图使用。 | 测试源码随项目分发。恶意 URL 等字符串仅用于验证拒绝外部加载。 |

`docs/images/obsidian-table.jpg` 于 2026-09-14 在真实 Obsidian 应用内采集，使用与浏览器截图相同的公开 S07 表格样稿。截图保留 Obsidian 应用外壳与本插件界面，用于展示插件效果；不包含私人稿件、真实云端标识或应用二进制，不改变第三方界面、图标和字体原有权利。发布文件移除设备相关元数据，保留原截图像素数据。

公开静态文件的 SHA-256：

```text
387c866592678c332047a9959d2c5bb5192c9dc8f463f41ddd588d5f43c14802  examples/assets/colors.png
20ea6c2f5ae4dbd081870ab1bfe3a5bb277177ad49c0ceddb5fc6578859ca8a7  examples/assets/review-map.svg
```

颜色样片的重建与核对不依赖图片服务或绘图库：

```sh
# 只读检查已提交图片的格式、校验和和所有像素，不改文件。
node scripts/generate-example-colors.mjs --check

# 输出到一个不存在的新文件；命令拒绝覆盖已有文件。
node scripts/generate-example-colors.mjs --output /tmp/feishu-doc-local-colors.png
```

不同 zlib 版本可能产生不同压缩字节，检查以明确的像素内容为准。样片原 PNG 未因本次审计而改写。

## UI 图标、公式字体与图示渲染器

下表针对本次锁定并安装的视觉依赖。构建时，Vite 会把实际引用的依赖代码和 KaTeX 字体放入输出目录；它们虽不在 `examples/assets/`，仍属于分发审查范围。完整依赖清单与许可通知应随发布产物保留，不能仅附项目 MIT 文本。

| 依赖 / 资源位置 | 实际用途与来源 | 许可与保留要求 |
| --- | --- | --- |
| `lucide-react@1.31.0` | 工具栏、导航、资源树等 SVG 图标；来自安装包，不是从飞书页面截取。 | 包内 `LICENSE` 同时包含 Lucide 的 ISC 与 Feather 衍生图标的 MIT 两部分，均保留。公开依据：[Lucide License](https://lucide.dev/license)。 |
| `katex@0.18.7` 的 JS / CSS | 本地公式排版；入口 `src/main.tsx` 引入 `katex/dist/katex.min.css`。 | 程序代码为 MIT，保留包内 `LICENSE`。公开依据：[KaTeX LICENSE](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)。 |
| `katex/dist/fonts/KaTeX_*` | 20 个字型文件组，各含 TTF、WOFF、WOFF2，共 60 个文件。构建随公式 CSS 引用复制字体。 | **字体为 SIL OFL 1.1，不能仅标 MIT。** 本次逐一读取 20 份 TTF 的 OpenType `name` 表，均有 OFL 声明、Design Science 与 Khan Academy 版权和保留字体名。分发时保留字体、版权与 OFL 文本；修改字体还须遵守保留字体名条款。依据：[OFL 官方文本](https://openfontlicense.org/open-font-license-official-text/)及实际字体元数据。 |
| `mermaid@12.0.0` | 从当前文档的 Mermaid 文本生成本地 SVG；无附带平台空态图片。 | 渲染器为 MIT，保留包内许可。[Mermaid LICENSE](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE)。渲染器许可不会替用户图源或嵌入素材授予分发权。 |
| CSS 中的系统字体名称 | `PingFang SC`、`Segoe UI`、`SFMono-Regular` 等仅由操作系统选取；示例 SVG 也使用系统字体回退。 | 仓库未复制这些系统字体二进制。不要因为 CSS 中写了字体名称，就把对应商业字体打包进发布物。 |

字体元数据中列出的保留字体名为 `KaTeX_AMS`、`KaTeX_Caligraphic`、`KaTeX_Fraktur`、`KaTeX_Main`、`KaTeX_Math`、`KaTeX_SansSerif`、`KaTeX_Script`、`KaTeX_Size1` 至 `KaTeX_Size4`、`KaTeX_Typewriter`。这些名称用于准确保留来源，项目没有修改这些字体。

## 四种交付产物

| 产物 | 随包内容与边界 |
| --- | --- |
| 本地服务版 `dist/` | 共享编辑器、服务端代码及依赖资源。包含许可证；不包含用户数据或 CLI 可执行文件。 |
| 静态浏览器版 `dist/browser/` | 可直接托管的程序、样例、字体及许可证。不要将整个开发目录作为静态站点上传。 |
| Obsidian 基础插件 `obsidian-plugin/dist/` | 共享编辑器、图示 / 公式渲染、字体、manifest 与许可证；`obsidian` 由宿主提供，不打包 Obsidian 应用。 |
| Obsidian 同步扩展 `obsidian-sync-plugin/dist/` | 同步代码、差异视图、manifest 与许可证；不包含官方 CLI、登录态或用户项目索引。 |

Obsidian API 用于编译和宿主调用，Obsidian 应用由用户自行安装。本地服务版运行时需要 Node.js 22.13+；飞书同步按需使用用户配置的官方 CLI，程序与凭据不随本项目分发。第三方许可检查应覆盖以上四种构建结果，保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 与 `licenses/`，不能将包中的依赖代码全部改标项目 MIT。

## 私有文档、飞书预览与截图

S15.B 测试稿中间的蓝绿色插图来自**飞书白板下载预览**。本次本机比对发现，私有测试副本的 `.review.json` 将该白板 `token` 的 `preview` 映射到 `.review-assets-*/...jpg`，其内容与先前保留的云端空白白板 JPEG 相同。该 JPEG 并非 `examples/` 素材，也不是本地空态组件生成的图案。公开仓库不保存这份图片、真实 token、用户文档或回执。

应用继续按用户文档中的精确引用展示已有缓存。它不会凭标题或图片哈希推断云端画板为空，也不会为了开源审计改写用户 XML、删除缓存或修改云端内容。只有明确的 `<whiteboard type="blank"/>` 使用自有空态。

以下内容不受本项目 MIT 许可的分发授权：

- 用户的 XML、相邻 `.review.json`、附件和下载的 `.review-assets-*` 资源；获得读取权限不等于获得重新发布权。
- `.local/` 中的飞书导出、接口回执、资源缓存、浏览器截图和视觉验收证据；该目录已由 `.gitignore` 排除。
- `test-results/`、`playwright-report/` 中可能包含真实文档的测试附件与截图；这些目录也不进入 Git。
- Obsidian 插件的 `data.json`、同步配置、云端快照与原始诊断日志。它们可能含未保存全文、评论、文档关联和本机路径；不属于插件安装包。

`.review-assets-*` 可以位于用户选择的任意文档目录，不能仅依赖 `.local/` 的忽略规则判断它可公开。打包示例、录制产品截图或生成发布压缩包时，使用仓库自有样例；明确排除用户文档、反馈 JSON 和下载缓存。需要公开某个云端导出图或截图时，应单独取得相应内容和素材的分发授权。

## 后续更新

添加视觉素材时同步记录来源文件、创作或获取方式、许可证和是否随发布包分发。可重建的几何图保留 SVG、图源或生成脚本；引入字体、图标包时检查实际文件许可，不能只读取 npm 的 `license` 字段。更新依赖版本或构建分发方式后重新核对通知文件和输出中的资源。

本清单说明本次可查证的资源来源与分发范围，不将用户资源或未核对的新素材表述为已经获准开源。
