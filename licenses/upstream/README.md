# 已核对的补充许可来源

这些文件用于补齐 npm 包未附带的通知或记录外部工具归因。原文于 2026-09-13 取得；生成器不联网获取，也不依赖维护者的相邻仓库。

| 本地文件 | 来源与用途 | SHA-256 |
| --- | --- | --- |
| [saxes-6.0.0-LICENSE.txt](saxes-6.0.0-LICENSE.txt) | [saxes v6.0.0 原文](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE)。ISC 及 SAX 来源通知；补齐当前 npm 包缺失的许可文件。 | `0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e` |
| [OFL-1.1-template.txt](OFL-1.1-template.txt) | [SIL 官方 OFL 1.1 完整模板](https://openfontlicense.org/documents/OFL.txt)。只将完整条款正文用于生成字体通知，模板占位版权不会被当作字体作者信息。实际版权、保留名称与许可声明来自当前 KaTeX TTF name 表。 | `1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e` |
| [lark-cli-MIT.txt](lark-cli-MIT.txt) | [官方 lark CLI LICENSE](https://github.com/larksuite/cli/blob/main/LICENSE)。从本机已取得的官方源码原样复制，保留 Lark Technologies 2026 版权；CLI 本身不随本项目分发。 | `c969fc7e3af68e6bf40b0d8dd9c3dcc377eb685a2139535b203b39fdcad739ee` |

字体生成结果见 [KaTeX-fonts-OFL-1.1.txt](../KaTeX-fonts-OFL-1.1.txt)，每个源字体的哈希在 [dependencies.json](../dependencies.json)。若更新依赖或原文，先核对对应版本与来源，再更新生成器中固定的原文哈希。

2026-11-17 补充 `web-worker@1.4.1` 的浏览器源码与 Apache 全文，取自 [npm 版本包](https://registry.npmjs.org/web-worker/-/web-worker-1.4.1.tgz)，包 SHA-1 为 `894e71a8f6fce059dc175864fcdf9e633eb7cc6b`。ELK 0.12.1 内嵌该包 `dist/browser/index.cjs`，内容与原包相同，但未保留源码头；生成器补回原始 `Copyright 2020 Google LLC` 及 Apache 通知。

- `web-worker-1.4.1-browser-source.txt` 原路径 `src/browser/index.js`，SHA-256：`5af8695e4e1a3830a2beb1b7482a293c811ac0f54302dc2ad577181f9e45e79d`。
- `web-worker-1.4.1-LICENSE.txt` 原路径 `LICENSE`，SHA-256：`43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1`。
