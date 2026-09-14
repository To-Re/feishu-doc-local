# 第三方许可清单

由 `node scripts/generate-third-party-notices.mjs` 离线生成；来源为当前锁文件、已安装包的原始许可文本和已核对的上游补充文件。缺少许可或版本不符会失败。完整来源、版本、哈希和包完整性值见 [dependencies.json](dependencies.json)。

## 运行时依赖

以下 187 项为运行时依赖闭包，覆盖构建入包依赖并包含被 tree shaking 去掉的包；不是声称每个包都进入最终 JS。

| 包 | 版本 | 本分发使用的许可 | 完整文本与通知 |
| --- | --- | --- | --- |
| @antfu/install-pkg | 2.0.1 | MIT | [LICENSE](packages/antfu__install-pkg-2.0.1/LICENSE) |
| tinyexec | 1.3.1 | MIT | [LICENSE](packages/tinyexec-1.3.1/LICENSE) |
| @braintree/sanitize-url | 7.1.2 | MIT | [LICENSE](packages/braintree__sanitize-url-7.1.2/LICENSE) |
| @chevrotain/cst-dts-gen | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain__cst-dts-gen-11.1.2/LICENSE.txt) |
| @chevrotain/gast | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain__gast-11.1.2/LICENSE.txt) |
| @chevrotain/regexp-to-ast | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain__regexp-to-ast-11.1.2/LICENSE.txt) |
| @chevrotain/types | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain__types-11.1.2/LICENSE.txt) |
| @chevrotain/utils | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain__utils-11.1.2/LICENSE.txt) |
| @floating-ui/core | 1.8.0 | MIT | [LICENSE](packages/floating-ui__core-1.8.0/LICENSE) |
| @floating-ui/dom | 1.8.0 | MIT | [LICENSE](packages/floating-ui__dom-1.8.0/LICENSE) |
| @floating-ui/utils | 0.2.12 | MIT | [LICENSE](packages/floating-ui__utils-0.2.12/LICENSE) |
| @iconify/types | 2.0.0 | MIT | [license.txt](packages/iconify__types-2.0.0/license.txt) |
| @iconify/utils | 3.1.7 | MIT | [license.txt](packages/iconify__utils-3.1.7/license.txt) |
| @mermaid-js/parser | 2.0.0 | MIT | [LICENSE](packages/mermaid-js__parser-2.0.0/LICENSE) |
| @tiptap/core | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__core-3.31.3/LICENSE.md) |
| @tiptap/extension-blockquote | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-blockquote-3.31.3/LICENSE.md) |
| @tiptap/extension-bold | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-bold-3.31.3/LICENSE.md) |
| @tiptap/extension-bubble-menu | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-bubble-menu-3.31.3/LICENSE.md) |
| @tiptap/extension-bullet-list | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-bullet-list-3.31.3/LICENSE.md) |
| @tiptap/extension-code | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-code-3.31.3/LICENSE.md) |
| @tiptap/extension-code-block | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-code-block-3.31.3/LICENSE.md) |
| @tiptap/extension-document | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-document-3.31.3/LICENSE.md) |
| @tiptap/extension-dropcursor | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-dropcursor-3.31.3/LICENSE.md) |
| @tiptap/extension-floating-menu | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-floating-menu-3.31.3/LICENSE.md) |
| @tiptap/extension-gapcursor | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-gapcursor-3.31.3/LICENSE.md) |
| @tiptap/extension-hard-break | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-hard-break-3.31.3/LICENSE.md) |
| @tiptap/extension-heading | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-heading-3.31.3/LICENSE.md) |
| @tiptap/extension-horizontal-rule | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-horizontal-rule-3.31.3/LICENSE.md) |
| @tiptap/extension-italic | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-italic-3.31.3/LICENSE.md) |
| @tiptap/extension-link | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-link-3.31.3/LICENSE.md) |
| @tiptap/extension-list | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-list-3.31.3/LICENSE.md) |
| @tiptap/extension-list-item | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-list-item-3.31.3/LICENSE.md) |
| @tiptap/extension-list-keymap | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-list-keymap-3.31.3/LICENSE.md) |
| @tiptap/extension-ordered-list | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-ordered-list-3.31.3/LICENSE.md) |
| @tiptap/extension-paragraph | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-paragraph-3.31.3/LICENSE.md) |
| @tiptap/extension-strike | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-strike-3.31.3/LICENSE.md) |
| @tiptap/extension-table | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-table-3.31.3/LICENSE.md) |
| @tiptap/extension-text | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-text-3.31.3/LICENSE.md) |
| @tiptap/extension-underline | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extension-underline-3.31.3/LICENSE.md) |
| @tiptap/extensions | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__extensions-3.31.3/LICENSE.md) |
| @tiptap/pm | 3.31.3 | MIT | [LICENSE](packages/tiptap__pm-3.31.3/LICENSE) |
| @tiptap/react | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__react-3.31.3/LICENSE.md) |
| @tiptap/starter-kit | 3.31.3 | MIT | [LICENSE.md](packages/tiptap__starter-kit-3.31.3/LICENSE.md) |
| @types/d3 | 7.4.3 | MIT | [LICENSE](packages/types__d3-7.4.3/LICENSE) |
| @types/d3-array | 3.2.2 | MIT | [LICENSE](packages/types__d3-array-3.2.2/LICENSE) |
| @types/d3-axis | 3.0.6 | MIT | [LICENSE](packages/types__d3-axis-3.0.6/LICENSE) |
| @types/d3-brush | 3.0.6 | MIT | [LICENSE](packages/types__d3-brush-3.0.6/LICENSE) |
| @types/d3-chord | 3.0.6 | MIT | [LICENSE](packages/types__d3-chord-3.0.6/LICENSE) |
| @types/d3-color | 3.1.3 | MIT | [LICENSE](packages/types__d3-color-3.1.3/LICENSE) |
| @types/d3-contour | 3.0.6 | MIT | [LICENSE](packages/types__d3-contour-3.0.6/LICENSE) |
| @types/d3-delaunay | 6.0.4 | MIT | [LICENSE](packages/types__d3-delaunay-6.0.4/LICENSE) |
| @types/d3-dispatch | 3.0.7 | MIT | [LICENSE](packages/types__d3-dispatch-3.0.7/LICENSE) |
| @types/d3-drag | 3.0.7 | MIT | [LICENSE](packages/types__d3-drag-3.0.7/LICENSE) |
| @types/d3-dsv | 3.0.7 | MIT | [LICENSE](packages/types__d3-dsv-3.0.7/LICENSE) |
| @types/d3-ease | 3.0.2 | MIT | [LICENSE](packages/types__d3-ease-3.0.2/LICENSE) |
| @types/d3-fetch | 3.0.7 | MIT | [LICENSE](packages/types__d3-fetch-3.0.7/LICENSE) |
| @types/d3-force | 3.0.10 | MIT | [LICENSE](packages/types__d3-force-3.0.10/LICENSE) |
| @types/d3-format | 3.0.4 | MIT | [LICENSE](packages/types__d3-format-3.0.4/LICENSE) |
| @types/d3-geo | 3.1.1 | MIT | [LICENSE](packages/types__d3-geo-3.1.1/LICENSE) |
| @types/d3-hierarchy | 3.1.7 | MIT | [LICENSE](packages/types__d3-hierarchy-3.1.7/LICENSE) |
| @types/d3-interpolate | 3.0.4 | MIT | [LICENSE](packages/types__d3-interpolate-3.0.4/LICENSE) |
| @types/d3-path | 3.1.1 | MIT | [LICENSE](packages/types__d3-path-3.1.1/LICENSE) |
| @types/d3-polygon | 3.0.2 | MIT | [LICENSE](packages/types__d3-polygon-3.0.2/LICENSE) |
| @types/d3-quadtree | 3.0.6 | MIT | [LICENSE](packages/types__d3-quadtree-3.0.6/LICENSE) |
| @types/d3-random | 3.0.4 | MIT | [LICENSE](packages/types__d3-random-3.0.4/LICENSE) |
| @types/d3-scale | 4.0.9 | MIT | [LICENSE](packages/types__d3-scale-4.0.9/LICENSE) |
| @types/d3-scale-chromatic | 3.1.0 | MIT | [LICENSE](packages/types__d3-scale-chromatic-3.1.0/LICENSE) |
| @types/d3-selection | 3.0.11 | MIT | [LICENSE](packages/types__d3-selection-3.0.11/LICENSE) |
| @types/d3-shape | 3.2.0 | MIT | [LICENSE](packages/types__d3-shape-3.2.0/LICENSE) |
| @types/d3-time | 3.0.4 | MIT | [LICENSE](packages/types__d3-time-3.0.4/LICENSE) |
| @types/d3-time-format | 4.0.3 | MIT | [LICENSE](packages/types__d3-time-format-4.0.3/LICENSE) |
| @types/d3-timer | 3.0.2 | MIT | [LICENSE](packages/types__d3-timer-3.0.2/LICENSE) |
| @types/d3-transition | 3.0.9 | MIT | [LICENSE](packages/types__d3-transition-3.0.9/LICENSE) |
| @types/d3-zoom | 3.0.8 | MIT | [LICENSE](packages/types__d3-zoom-3.0.8/LICENSE) |
| @types/geojson | 7946.0.16 | MIT | [LICENSE](packages/types__geojson-7946.0.16/LICENSE) |
| @types/hast | 3.0.5 | MIT | [LICENSE](packages/types__hast-3.0.5/LICENSE) |
| @types/react | 19.2.14 | MIT | [LICENSE](packages/types__react-19.2.14/LICENSE) |
| @types/react-dom | 19.2.3 | MIT | [LICENSE](packages/types__react-dom-19.2.3/LICENSE) |
| @types/trusted-types | 2.0.7 | MIT | [LICENSE](packages/types__trusted-types-2.0.7/LICENSE) |
| @types/unist | 3.0.3 | MIT | [LICENSE](packages/types__unist-3.0.3/LICENSE) |
| @types/use-sync-external-store | 0.0.6 | MIT | [LICENSE](packages/types__use-sync-external-store-0.0.6/LICENSE) |
| @upsetjs/venn.js | 2.0.0 | MIT | [LICENSE](packages/upsetjs__venn.js-2.0.0/LICENSE) |
| chevrotain | 11.1.2 | Apache-2.0 | [LICENSE.txt](packages/chevrotain-11.1.2/LICENSE.txt) |
| commander | 15.0.0 | MIT | [LICENSE](packages/commander-15.0.0/LICENSE) |
| cose-base | 1.0.3 | MIT | [LICENSE](packages/cose-base-1.0.3/LICENSE) |
| csstype | 3.2.3 | MIT | [LICENSE](packages/csstype-3.2.3/LICENSE) |
| cytoscape | 3.34.3 | MIT | [LICENSE](packages/cytoscape-3.34.3/LICENSE), [license-update.mjs](packages/cytoscape-3.34.3/license-update.mjs) |
| cytoscape-cose-bilkent | 4.1.0 | MIT | [LICENSE](packages/cytoscape-cose-bilkent-4.1.0/LICENSE) |
| cytoscape-fcose | 2.2.0 | MIT | [LICENSE](packages/cytoscape-fcose-2.2.0/LICENSE) |
| cose-base | 2.2.0 | MIT | [LICENSE](packages/cose-base-2.2.0/LICENSE) |
| layout-base | 2.0.1 | MIT | [LICENSE](packages/layout-base-2.0.1/LICENSE) |
| d3 | 7.9.0 | ISC | [LICENSE](packages/d3-7.9.0/LICENSE) |
| d3-array | 3.2.4 | ISC | [LICENSE](packages/d3-array-3.2.4/LICENSE) |
| d3-axis | 3.0.0 | ISC | [LICENSE](packages/d3-axis-3.0.0/LICENSE) |
| d3-brush | 3.0.0 | ISC | [LICENSE](packages/d3-brush-3.0.0/LICENSE) |
| d3-chord | 3.0.1 | ISC | [LICENSE](packages/d3-chord-3.0.1/LICENSE) |
| d3-color | 3.1.0 | ISC | [LICENSE](packages/d3-color-3.1.0/LICENSE) |
| d3-contour | 4.0.2 | ISC | [LICENSE](packages/d3-contour-4.0.2/LICENSE) |
| d3-delaunay | 6.0.4 | ISC | [LICENSE](packages/d3-delaunay-6.0.4/LICENSE) |
| d3-dispatch | 3.0.1 | ISC | [LICENSE](packages/d3-dispatch-3.0.1/LICENSE) |
| d3-drag | 3.0.0 | ISC | [LICENSE](packages/d3-drag-3.0.0/LICENSE) |
| d3-dsv | 3.0.1 | ISC | [LICENSE](packages/d3-dsv-3.0.1/LICENSE) |
| commander | 7.2.0 | MIT | [LICENSE](packages/commander-7.2.0/LICENSE) |
| d3-ease | 3.0.1 | BSD-3-Clause | [LICENSE](packages/d3-ease-3.0.1/LICENSE) |
| d3-fetch | 3.0.1 | ISC | [LICENSE](packages/d3-fetch-3.0.1/LICENSE) |
| d3-force | 3.0.0 | ISC | [LICENSE](packages/d3-force-3.0.0/LICENSE) |
| d3-format | 3.1.2 | ISC | [LICENSE](packages/d3-format-3.1.2/LICENSE) |
| d3-geo | 3.1.1 | ISC | [LICENSE](packages/d3-geo-3.1.1/LICENSE) |
| d3-hierarchy | 3.1.2 | ISC | [LICENSE](packages/d3-hierarchy-3.1.2/LICENSE) |
| d3-interpolate | 3.0.1 | ISC | [LICENSE](packages/d3-interpolate-3.0.1/LICENSE) |
| d3-path | 3.1.0 | ISC | [LICENSE](packages/d3-path-3.1.0/LICENSE) |
| d3-polygon | 3.0.1 | ISC | [LICENSE](packages/d3-polygon-3.0.1/LICENSE) |
| d3-quadtree | 3.0.1 | ISC | [LICENSE](packages/d3-quadtree-3.0.1/LICENSE) |
| d3-random | 3.0.1 | ISC | [LICENSE](packages/d3-random-3.0.1/LICENSE) |
| d3-sankey | 0.12.3 | BSD-3-Clause | [LICENSE](packages/d3-sankey-0.12.3/LICENSE) |
| d3-array | 2.12.1 | BSD-3-Clause | [LICENSE](packages/d3-array-2.12.1/LICENSE) |
| d3-path | 1.0.9 | BSD-3-Clause | [LICENSE](packages/d3-path-1.0.9/LICENSE) |
| d3-shape | 1.3.7 | BSD-3-Clause | [LICENSE](packages/d3-shape-1.3.7/LICENSE) |
| internmap | 1.0.1 | ISC | [LICENSE](packages/internmap-1.0.1/LICENSE) |
| d3-scale | 4.0.2 | ISC | [LICENSE](packages/d3-scale-4.0.2/LICENSE) |
| d3-scale-chromatic | 3.1.0 | ISC | [LICENSE](packages/d3-scale-chromatic-3.1.0/LICENSE) |
| d3-selection | 3.0.0 | ISC | [LICENSE](packages/d3-selection-3.0.0/LICENSE) |
| d3-shape | 3.2.0 | ISC | [LICENSE](packages/d3-shape-3.2.0/LICENSE) |
| d3-time | 3.1.0 | ISC | [LICENSE](packages/d3-time-3.1.0/LICENSE) |
| d3-time-format | 4.1.0 | ISC | [LICENSE](packages/d3-time-format-4.1.0/LICENSE) |
| d3-timer | 3.0.1 | ISC | [LICENSE](packages/d3-timer-3.0.1/LICENSE) |
| d3-transition | 3.0.1 | ISC | [LICENSE](packages/d3-transition-3.0.1/LICENSE) |
| d3-zoom | 3.0.0 | ISC | [LICENSE](packages/d3-zoom-3.0.0/LICENSE) |
| dagre-d3-es | 7.0.14 | MIT | [LICENSE.md](packages/dagre-d3-es-7.0.14/LICENSE.md) |
| dayjs | 1.11.23 | MIT | [LICENSE](packages/dayjs-1.11.23/LICENSE) |
| delaunator | 5.1.0 | ISC | [LICENSE](packages/delaunator-5.1.0/LICENSE) |
| dequal | 2.0.3 | MIT | [license](packages/dequal-2.0.3/license) |
| devlop | 1.1.0 | MIT | [license](packages/devlop-1.1.0/license) |
| diff | 9.0.0 | BSD-3-Clause | [LICENSE](packages/diff-9.0.0/LICENSE) |
| dompurify | 3.4.15 | Apache-2.0 | [LICENSE](packages/dompurify-3.4.15/LICENSE), [LICENSE-MPL](packages/dompurify-3.4.15/LICENSE-MPL), [COPYRIGHT.txt](packages/dompurify-3.4.15/COPYRIGHT.txt) |
| elkjs | 0.9.3 | EPL-2.0 AND Apache-2.0 | [LICENSE.md](packages/elkjs-0.9.3/LICENSE.md), [COPYRIGHT.txt](packages/elkjs-0.9.3/COPYRIGHT.txt), [Apache-2.0.txt](packages/elkjs-0.9.3/Apache-2.0.txt) |
| es-toolkit | 1.52.0 | MIT | [LICENSE](packages/es-toolkit-1.52.0/LICENSE), [NOTICE](packages/es-toolkit-1.52.0/NOTICE) |
| fast-equals | 5.4.2 | MIT | [LICENSE](packages/fast-equals-5.4.2/LICENSE) |
| hachure-fill | 0.5.2 | MIT | [LICENSE](packages/hachure-fill-0.5.2/LICENSE) |
| highlight.js | 11.11.1 | BSD-3-Clause | [LICENSE](packages/highlight.js-11.11.1/LICENSE) |
| iconv-lite | 0.6.3 | MIT | [LICENSE](packages/iconv-lite-0.6.3/LICENSE) |
| import-meta-resolve | 4.2.0 | MIT | [license](packages/import-meta-resolve-4.2.0/license) |
| internmap | 2.0.3 | ISC | [LICENSE](packages/internmap-2.0.3/LICENSE) |
| katex | 0.18.7 | MIT | [LICENSE](packages/katex-0.18.7/LICENSE) |
| khroma | 2.1.0 | MIT | [license](packages/khroma-2.1.0/license) |
| layout-base | 1.0.2 | MIT | [LICENSE](packages/layout-base-1.0.2/LICENSE) |
| linkifyjs | 4.3.3 | MIT | [LICENSE](packages/linkifyjs-4.3.3/LICENSE) |
| lodash-es | 4.17.23 | MIT | [LICENSE](packages/lodash-es-4.17.23/LICENSE) |
| lowlight | 3.3.0 | MIT | [license](packages/lowlight-3.3.0/license) |
| lucide-react | 1.31.0 | ISC | [LICENSE](packages/lucide-react-1.31.0/LICENSE) |
| marked | 16.4.2 | MIT | [LICENSE.md](packages/marked-16.4.2/LICENSE.md) |
| mermaid | 12.0.0 | MIT | [LICENSE](packages/mermaid-12.0.0/LICENSE) |
| commander | 8.3.0 | MIT | [LICENSE](packages/commander-8.3.0/LICENSE) |
| katex | 0.16.47 | MIT | [LICENSE](packages/katex-0.16.47/LICENSE) |
| orderedmap | 2.1.1 | MIT | [LICENSE](packages/orderedmap-2.1.1/LICENSE) |
| package-manager-detector | 1.8.0 | MIT | [LICENSE](packages/package-manager-detector-1.8.0/LICENSE) |
| path-data-parser | 0.1.0 | MIT | [LICENSE](packages/path-data-parser-0.1.0/LICENSE) |
| points-on-curve | 0.2.0 | MIT | [LICENSE](packages/points-on-curve-0.2.0/LICENSE) |
| points-on-path | 0.2.1 | MIT | [LICENSE](packages/points-on-path-0.2.1/LICENSE) |
| prosemirror-changeset | 2.4.2 | MIT | [LICENSE](packages/prosemirror-changeset-2.4.2/LICENSE) |
| prosemirror-commands | 1.7.2 | MIT | [LICENSE](packages/prosemirror-commands-1.7.2/LICENSE) |
| prosemirror-dropcursor | 1.8.3 | MIT | [LICENSE](packages/prosemirror-dropcursor-1.8.3/LICENSE) |
| prosemirror-gapcursor | 1.4.1 | MIT | [LICENSE](packages/prosemirror-gapcursor-1.4.1/LICENSE) |
| prosemirror-history | 1.5.0 | MIT | [LICENSE](packages/prosemirror-history-1.5.0/LICENSE) |
| prosemirror-inputrules | 1.5.1 | MIT | [LICENSE](packages/prosemirror-inputrules-1.5.1/LICENSE) |
| prosemirror-keymap | 1.2.3 | MIT | [LICENSE](packages/prosemirror-keymap-1.2.3/LICENSE) |
| prosemirror-model | 1.25.11 | MIT | [LICENSE](packages/prosemirror-model-1.25.11/LICENSE) |
| prosemirror-schema-list | 1.5.1 | MIT | [LICENSE](packages/prosemirror-schema-list-1.5.1/LICENSE) |
| prosemirror-state | 1.4.4 | MIT | [LICENSE](packages/prosemirror-state-1.4.4/LICENSE) |
| prosemirror-tables | 1.8.5 | MIT | [LICENSE](packages/prosemirror-tables-1.8.5/LICENSE) |
| prosemirror-transform | 1.12.1 | MIT | [LICENSE](packages/prosemirror-transform-1.12.1/LICENSE) |
| prosemirror-view | 1.42.3 | MIT | [LICENSE](packages/prosemirror-view-1.42.3/LICENSE) |
| react | 19.2.8 | MIT | [LICENSE](packages/react-19.2.8/LICENSE) |
| react-dom | 19.2.8 | MIT | [LICENSE](packages/react-dom-19.2.8/LICENSE) |
| robust-predicates | 3.0.3 | Unlicense | [LICENSE](packages/robust-predicates-3.0.3/LICENSE) |
| rope-sequence | 1.3.4 | MIT | [LICENSE](packages/rope-sequence-1.3.4/LICENSE) |
| roughjs | 4.6.6 | MIT | [LICENSE](packages/roughjs-4.6.6/LICENSE) |
| rw | 1.3.3 | BSD-3-Clause | [LICENSE](packages/rw-1.3.3/LICENSE) |
| safer-buffer | 2.1.2 | MIT | [LICENSE](packages/safer-buffer-2.1.2/LICENSE) |
| saxes | 6.0.0 | ISC | [LICENSE](packages/saxes-6.0.0/LICENSE) |
| scheduler | 0.27.0 | MIT | [LICENSE](packages/scheduler-0.27.0/LICENSE) |
| stylis | 4.4.0 | MIT | [LICENSE](packages/stylis-4.4.0/LICENSE) |
| ts-dedent | 2.3.0 | MIT | [LICENSE](packages/ts-dedent-2.3.0/LICENSE) |
| use-sync-external-store | 1.7.0 | MIT | [LICENSE](packages/use-sync-external-store-1.7.0/LICENSE) |
| uuid | 14.0.2 | MIT | [LICENSE.md](packages/uuid-14.0.2/LICENSE.md) |
| w3c-keyname | 2.2.8 | MIT | [LICENSE](packages/w3c-keyname-2.2.8/LICENSE) |
| xmlchars | 2.2.0 | MIT | [LICENSE](packages/xmlchars-2.2.0/LICENSE) |

## 构建工具

这些工具用于安装、转换或构建，不作为编辑器运行时代码打包。平台二进制、测试依赖和完整 node_modules 不随本项目分发；若改变分发范围，需重新审计。

| 包 | 版本 | 许可 | 完整文本与通知 |
| --- | --- | --- | --- |
| @vitejs/plugin-react | 6.0.2 | MIT | [LICENSE](packages/vitejs__plugin-react-6.0.2/LICENSE) |
| esbuild | 0.28.2 | MIT | [LICENSE.md](packages/esbuild-0.28.2/LICENSE.md) |
| lightningcss | 1.33.0 | MPL-2.0 | [LICENSE](packages/lightningcss-1.33.0/LICENSE) |
| typescript | 5.9.3 | Apache-2.0 | [LICENSE.txt](packages/typescript-5.9.3/LICENSE.txt) |
| vite | 8.2.2 | MIT | [LICENSE.md](packages/vite-8.2.2/LICENSE.md) |
| vite | 7.3.6 | MIT | [LICENSE.md](packages/vite-7.3.6/LICENSE.md) |
| vite | 7.3.6 | MIT | [LICENSE.md](packages/vite-7.3.6/LICENSE.md) |

## 字体

KaTeX 的 60 个字体文件按 **OFL-1.1** 单独记录，包含原始版权、各字体保留名称和完整许可：[字体通知](KaTeX-fonts-OFL-1.1.txt)。JS/CSS 的 MIT 不能替代字体许可。

运行 `node scripts/generate-third-party-notices.mjs --check --verify-bundle`，可比较清单与安装状态，并以内存构建核对 Vite 和 esbuild 实际模块及字体覆盖范围；该检查不改写 dist。
