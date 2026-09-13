// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { closeHistory, undoNoScroll, redoNoScroll } from '@tiptap/pm/history';

const editors: Editor[] = [];
function open(xml: string) {
  const document = parseDocxXML(xml);
  const editor = new Editor({ element: window.document.createElement('div'), extensions: xmlExtensions(), content: document.content });
  editors.push(editor);
  return { document, editor };
}
function replaceText(editor: Editor, before: string, after: string) {
  let range: { from: number; to: number } | undefined;
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(before)) range = { from: position + node.text.indexOf(before), to: position + node.text.indexOf(before) + before.length };
  });
  if (!range) throw new Error(`Missing text: ${before}`);
  editor.view.dispatch(editor.state.tr.insertText(after, range.from, range.to));
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

const fullFixture = `<!-- untouched -->\n<title align='center'>本地阅稿</title>\n<h1 seq="auto">章</h1><h9>深层标题</h9>
<p custom="keep" align="right">原文 <b>粗体 <em>斜体</em></b>、<u>下划线</u>、<del>删除线</del>、<code>x &lt; y</code><br/>
<span text-color="red" background-color="light-yellow">有色文字</span><a type="url-preview" href="https://example.com/?a=1&amp;b=2">链接</a></p>
<ol><li seq="3">步骤<ul><li>子项</li></ul>尾部</li><li seq="auto">下一步</li></ol>
<checkbox done="false">待办</checkbox><blockquote><p>引用</p></blockquote>
<callout emoji="💡" background-color="light-blue"><p>提示</p><checkbox done="true">完成</checkbox></callout>
<table data-table="keep"><colgroup><col width="160"/><col width="120" span="2"/></colgroup>
<thead data-head="keep"><tr><th colspan="2" background-color="light-gray"><p>合并表头</p></th><th><p>C</p></th></tr></thead>
<tbody data-body="keep"><tr><td rowspan="2" vertical-align="middle"><p>A</p></td><td data-cell="keep"><p>B1</p></td><td><p>C1</p></td></tr>
<tr><td><p>B2</p></td><td><p>C2</p></td></tr></tbody></table>
<pre lang="go" caption="示例"><code data-code="keep"><![CDATA[if a < b {\n    println("中文")\n}]]></code></pre>
<p>前文<source token="attachment-token" name="附件.pdf"/>后文</p>
<img src="image-token" width="100" caption="图片"/>
<whiteboard src='board-token'><mystery value="kept"/></whiteboard>
<future-block custom='yes'><p>未知结构内部</p></future-block>\n<!-- tail -->\n`;

// Shape from an actual full fetch. IDs and prose are synthetic; six-digit
// ratios and code <br/> separators reproduce the server's wire representation.
const officialFetchFixture = '<pre id="fixture-code" caption="示例代码&#xA;" lang="go"><code>package main<br/><br/>func main() {<br/>    if 2 &lt; 3 {<br/>        println("hello &amp; world")<br/>    }<br/>}</code></pre>' +
  '<grid id="fixture-grid"><column id="fixture-left" width-ratio="0.333333"><p>左栏正文</p></column><column id="fixture-middle" width-ratio="0.333333"><p>中栏正文</p></column><column id="fixture-right" width-ratio="0.333333"><p>右栏正文</p></column></grid>';

describe('strict DocxXML adapter', () => {
  it('keeps original bytes after real Tiptap initialization, including defaults and normalized marks', () => {
    const { document, editor } = open(fullFixture);
    expect(document.serialize(document.content)).toBe(fullFixture);
    expect(document.serialize(editor.getJSON())).toBe(fullFixture);
    expect(editor.state.doc.textContent).toContain('后文');
    expect(editor.state.doc.textContent).toContain('尾部');
    expect(editor.state.doc.toJSON().content.some((node: JSONContent) => node.type === 'heading' && node.attrs?.level === 9)).toBe(true);
    expect(editor.view.dom.querySelector('img')).toBeNull();
  });

  it('edits table text while retaining spans, section attributes, widths and all protected XML', () => {
    const { document, editor } = open(fullFixture);
    replaceText(editor, 'B1', '改后的单元格');
    const result = document.serialize(editor.getJSON());
    expect(result).toContain('<td data-cell="keep"><p>改后的单元格</p></td>');
    expect(result).toContain('<th colspan="2" background-color="light-gray"><p>合并表头</p></th>');
    expect(result).toContain('<td rowspan="2" vertical-align="middle"><p>A</p></td>');
    expect(result).toContain('<tbody data-body="keep">');
    expect(result).toContain('<colgroup><col width="160"/><col width="120" span="2"/></colgroup>');
    expect(result).toContain("<whiteboard src='board-token'><mystery value=\"kept\"/></whiteboard>");
    expect(result).toContain("<future-block custom='yes'><p>未知结构内部</p></future-block>");
    expect(result.endsWith('\n<!-- tail -->\n')).toBe(true);
    expect(parseDocxXML(result).content).toBeTruthy();
  });

  it('applies colgroup width and repeated spans to real editor columns and merged cells', () => {
    const { document, editor } = open(fullFixture);
    const widths = [...editor.view.dom.querySelectorAll<HTMLElement>('table colgroup col')].map(col => col.style.width);
    expect(widths).toEqual(['160px', '120px', '120px']);
    let table: JSONContent | undefined;
    editor.state.doc.descendants(node => { if (node.type.name === 'table') table = node.toJSON(); });
    expect(table!.content![0].content![0].attrs?.colwidth).toEqual([160, 120]);
    expect(table!.content![1].content![0].attrs?.colwidth).toEqual([160]);
    expect(table!.content![2].content![0].attrs?.colwidth).toEqual([120]);
    expect(document.serialize(editor.getJSON())).toBe(fullFixture);
    replaceText(editor, 'B1', '改列宽表格中的文字');
    expect(document.serialize(editor.getJSON())).toContain('<colgroup><col width="160"/><col width="120" span="2"/></colgroup>');
  });

  it('retains inline attachments and unknown nodes when text after them changes', () => {
    const source = '<p id="p1">前<source token="tok" name="x.pdf"/>后<custom flag=\'yes\'><nested/></custom>尾文</p>';
    const { document, editor } = open(source);
    replaceText(editor, '尾文', '最后的正文');
    const result = document.serialize(editor.getJSON());
    expect(result).toContain('<source token="tok" name="x.pdf"/>后');
    expect(result).toContain("<custom flag='yes'><nested/></custom>最后的正文");
    expect(result).toContain('id="p1"');
  });

  it('reuses the initial adapter for successive edits and returns original bytes on undo', () => {
    const source = "\n<p align='center'>第一段</p>\n<future attr='keep'><raw/></future>\n<p>第二段</p>\n";
    const { document, editor } = open(source);
    replaceText(editor, '第一段', '第一次修改');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('第一段', '第一次修改'));
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false));
    replaceText(editor, '第二段', '第二次修改');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('第一段', '第一次修改').replace('第二段', '第二次修改'));
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source.replace('第一段', '第一次修改'));
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source);
    redoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source.replace('第一段', '第一次修改'));
  });

  it.each([
    { title: '文章标题', position: 5, left: '文章标题', right: '' },
    { title: '文章标题', position: 3, left: '文章', right: '标题' },
    { title: '文章标题', position: 1, left: '', right: '文章标题' },
    { title: '', position: 1, left: '', right: '' },
    { title: '文章标题', position: { from: 2, to: 4 }, left: '文', right: '题' },
  ])('creates a paragraph when Enter splits title $title at $position', ({ title, position, left, right }) => {
    const { document, editor } = open(`<title data-keep="title">${title}</title><p>原正文</p>`);
    editor.commands.setTextSelection(position);
    expect(editor.commands.keyboardShortcut('Enter')).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).type.name).toBe('xmlTitle');
    expect(editor.state.doc.child(0).textContent).toBe(left);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe(right);
    expect(editor.state.doc.child(2).textContent).toBe('原正文');
    const xml = document.serialize(editor.getJSON());
    expect(xml.match(/<title(?:\s|>)/g)).toHaveLength(1);
    expect(xml).toContain('data-keep="title"');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(`<title data-keep="title">${title}</title><p>原正文</p>`);
  });

  it('ignores checkbox interactions in readonly mode and resumes them in edit mode', () => {
    const { document, editor } = open('<checkbox done="false">待办</checkbox>');
    const container = editor.options.element as HTMLElement;
    window.document.body.append(container);
    const input = editor.view.dom.querySelector('input')!;
    editor.setEditable(false);
    input.click();
    expect(editor.state.doc.firstChild!.attrs.checked).toBe(false);
    expect(input.checked).toBe(false);
    expect(document.serialize(editor.getJSON())).toBe('<checkbox done="false">待办</checkbox>');
    editor.setEditable(true);
    input.click();
    expect(editor.state.doc.firstChild!.attrs.checked).toBe(true);
    expect(document.serialize(editor.getJSON())).toBe('<checkbox done="true">待办</checkbox>');
    container.remove();
  });

  it('keeps text formatting, link kind and arbitrary attributes when its paragraph changes', () => {
    const { document, editor } = open('<p align="center" data-keep="x">前<b data-bold="1">粗</b><span text-color="blue" background-color="light-gray">颜色</span><a href="https://example.com" type="url-preview">链接</a>尾</p>');
    replaceText(editor, '前', '修改');
    const result = document.serialize(editor.getJSON());
    expect(result).toContain('align="center" data-keep="x"');
    expect(result).toContain('<b data-bold="1">粗</b>');
    expect(result).toContain('<span text-color="blue" background-color="light-gray">颜色</span>');
    expect(result).toContain('<a href="https://example.com" type="url-preview">链接</a>');
  });

  it('retains empty styled elements and inline XML comments during nearby edits', () => {
    const source = '<p>前<span data-anchor="empty"></span><!-- inline --><b/>尾</p>';
    const { document, editor } = open(source);
    replaceText(editor, '尾', '改后');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('尾', '改后'));
  });

  it('keeps block media in its container without wrapping it as inline content', () => {
    const source = '<blockquote><source token="file" name="file.pdf"/><p>后文</p></blockquote>';
    const { document, editor } = open(source);
    replaceText(editor, '后文', '改后');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('后文', '改后'));
  });

  it('only asks the host to resolve safe relative local image paths', () => {
    const paths: string[] = [];
    const document = parseDocxXML('<img href="https://example.com/remote.png"/><img src="cloud-token"/><img path="@../outside.png"/><img path="@./local.png"/>');
    const editor = new Editor({ element: window.document.createElement('div'), extensions: xmlExtensions(path => { paths.push(path); return '/assets/local.png'; }), content: document.content });
    editors.push(editor);
    expect(paths).toEqual(['./local.png']);
    expect(editor.view.dom.querySelectorAll('img')).toHaveLength(1);
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('/assets/local.png');
  });

  it('displays local image dimensions and captions without applying nonnumeric or invalid sizes', () => {
    const source = '<img path="@./local.png" width="320" height="180" caption="图例 &lt;script&gt;"/><img path="@./local.png" width="NaN" height="-5"/>';
    const document = parseDocxXML(source);
    const editor = new Editor({ element: window.document.createElement('div'), extensions: xmlExtensions(() => '/assets/local.png'), content: document.content });
    editors.push(editor);
    const images = editor.view.dom.querySelectorAll('img');
    expect(images[0].getAttribute('width')).toBe('320');
    expect(images[0].getAttribute('height')).toBe('180');
    expect(images[1].hasAttribute('width')).toBe(false);
    expect(images[1].hasAttribute('height')).toBe(false);
    expect(editor.view.dom.querySelector('.lr-media-caption')?.textContent).toBe('图例 <script>');
    expect(editor.view.dom.querySelector('script')).toBeNull();
    expect(document.serialize(editor.getJSON())).toBe(source);
  });

  it('writes checkbox state and keeps numbered nested lists editable', () => {
    const { document, editor } = open('<ol><li seq="3">步骤<ul><li>子项</li></ul>尾部</li></ol><checkbox done="false" id="task">待办</checkbox>');
    replaceText(editor, '子项', '修改子项');
    let checkbox = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'xmlCheckbox') checkbox = pos; });
    const node = editor.state.doc.nodeAt(checkbox)!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(checkbox, undefined, { ...node.attrs, checked: true }));
    const result = document.serialize(editor.getJSON());
    expect(result).toContain('<li seq="3">步骤<ul><li>修改子项</li></ul>尾部</li>');
    expect(result).toContain('<checkbox done="true" id="task">待办</checkbox>');
  });

  it('renders proportional editable columns and preserves their XML attributes, gaps and unknown children', () => {
    const source = `<grid data-layout='keep'>\n  <column width-ratio='0.35' data-column='left'>\n    <p>左栏正文</p>\n    <future mode='keep'><child/></future>\n  </column>\n  <column width-ratio="0.65"><p>右栏正文</p><blockquote><p>引用</p></blockquote></column>\n</grid><p>尾文</p>`;
    const { document, editor } = open(source);
    expect(document.serialize(editor.getJSON())).toBe(source);
    const grid = editor.view.dom.querySelector<HTMLElement>('.lr-grid')!;
    expect(grid.style.display).toBe('flex');
    const columns = grid.querySelectorAll<HTMLElement>('.lr-column');
    expect(columns).toHaveLength(2);
    expect(columns[0].style.flexGrow).toBe('0.35');
    expect(columns[1].style.flexGrow).toBe('0.65');
    expect(editor.state.doc.firstChild!.type.name).toBe('xmlGrid');
    expect(editor.state.doc.firstChild!.firstChild!.type.name).toBe('xmlColumn');
    replaceText(editor, '左栏正文', '修改左栏');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('左栏正文', '修改左栏'));
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source);
  });

  it('renders actual full-fetch code breaks and six-decimal columns, preserving no-op bytes and edited siblings', () => {
    const {document,editor} = open(officialFetchFixture);
    expect(document.warnings).toEqual([]);
    const expectedCode = 'package main\n\nfunc main() {\n    if 2 < 3 {\n        println("hello & world")\n    }\n}';
    expect(editor.state.doc.firstChild!.type.name).toBe('codeBlock');
    expect(editor.state.doc.firstChild!.textContent).toBe(expectedCode);
    expect(editor.view.dom.querySelector('.lr-code-block code')?.textContent).toBe(expectedCode);
    expect(editor.view.dom.querySelector('.lr-code-caption')?.textContent).toBe('示例代码\n');
    const columns = editor.view.dom.querySelectorAll<HTMLElement>('.lr-grid .lr-column');
    expect(columns).toHaveLength(3);
    expect([...columns].map(column => column.style.flexGrow)).toEqual(['0.333333','0.333333','0.333333']);
    expect(document.serialize(editor.getJSON())).toBe(officialFetchFixture);
    replaceText(editor,'中栏正文','修改中栏');
    expect(document.serialize(editor.getJSON())).toBe(officialFetchFixture.replace('中栏正文','修改中栏'));
    undoNoScroll(editor.state,transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(officialFetchFixture);
    replaceText(editor,'hello & world','goodbye & world');
    const changed = document.serialize(editor.getJSON());
    expect(changed).toBe(officialFetchFixture.replace('hello &amp; world','goodbye &amp; world'));
    expect(parseDocxXML(changed).content.content![0].content![0].text).toBe(expectedCode.replace('hello','goodbye'));
  });

  it('allows only rounding-sized grid errors and continues protecting invalid layouts and decorated code breaks', () => {
    const rounded = '<grid>' + Array.from({length:6},(_,index) => `<column width-ratio="0.166667"><p>栏${index}</p></column>`).join('') + '</grid>';
    const {document,editor} = open(rounded);
    expect(editor.view.dom.querySelectorAll('.lr-column')).toHaveLength(6);
    expect(document.serialize(editor.getJSON())).toBe(rounded);
    const invalid = '<grid>' + Array.from({length:3},() => '<column width-ratio="0.333332"><p>错误比例</p></column>').join('') + '</grid>';
    expect(open(invalid).editor.state.doc.firstChild!.type.name).toBe('protectedBlock');
    const decorated = '<pre><code>前<br data-unknown="preserve"/>后</code></pre><p>尾文</p>';
    const protectedCode = open(decorated);
    expect(protectedCode.editor.state.doc.firstChild!.type.name).toBe('protectedBlock');
    replaceText(protectedCode.editor,'尾文','修改尾文');
    expect(protectedCode.document.serialize(protectedCode.editor.getJSON())).toBe(decorated.replace('尾文','修改尾文'));
  });

  it('retains direct column text and block media after edits in the same column', () => {
    const source = '<grid><column width-ratio="0.5">直接文字<source token="file" name="x.pdf"/><p>尾段</p></column><column width-ratio="0.5"><p>另栏</p></column></grid>';
    const { document, editor } = open(source);
    replaceText(editor, '直接文字', '改后文字');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('直接文字', '改后文字'));
    expect(editor.state.doc.firstChild!.firstChild!.child(1).type.name).toBe('protectedBlock');
  });

  it('protects incomplete grid layouts without normalizing ratios or dropping unrecognized structure', () => {
    const source = '<grid><column width-ratio="0.8"><p>一</p></column><column width-ratio="0.5"><p>二</p></column></grid><grid><column width-ratio="1"/><future/></grid><p>尾段</p>';
    const { document, editor } = open(source);
    expect(editor.view.dom.querySelector('.lr-grid')).toBeNull();
    replaceText(editor, '尾段', '改后');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('尾段', '改后'));
  });

  it('renders inline and standalone formulas with local KaTeX and updates selected formula source without losing XML attributes', () => {
    const source = '<p>公式 <b><latex data-keep=\'inline\'><![CDATA[x < y]]></latex></b> 后文</p>\n<latex id="block">\\frac{a}{b}</latex>';
    const { document, editor } = open(source);
    expect(document.serialize(editor.getJSON())).toBe(source);
    expect(editor.view.dom.querySelectorAll('.katex')).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll('.lr-latex-inline')).toHaveLength(1);
    expect(editor.view.dom.querySelector('.lr-latex-block .katex-display')).not.toBeNull();
    let formula = -1;
    editor.state.doc.descendants((node, position) => { if (node.type.name === 'xmlInlineLatex') formula = position; });
    expect(formula).toBeGreaterThan(0);
    editor.commands.setNodeSelection(formula);
    expect(editor.commands.updateAttributes('xmlInlineLatex', { expression: 'x < z' })).toBe(true);
    const edited = document.serialize(editor.getJSON());
    expect(edited).toContain("<latex data-keep='inline'>x &lt; z</latex>");
    expect(editor.view.dom.querySelector('.lr-latex-inline .katex')).not.toBeNull();
    expect(edited).toContain('<latex id="block">\\frac{a}{b}</latex>');
    expect(edited).toContain(' 后文</p>');
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source);
  });

  it('edits standalone formula source through node attributes and refreshes its rendered math', () => {
    const source = '<latex data-keep="block"><![CDATA[\\frac{a}{b}]]></latex><p>尾段</p>';
    const { document, editor } = open(source);
    editor.commands.setNodeSelection(0);
    expect(editor.commands.updateAttributes('xmlBlockLatex', { expression: '\\begin{matrix}a&b\\end{matrix}' })).toBe(true);
    expect(editor.view.dom.querySelector('.lr-latex-block .katex')).not.toBeNull();
    expect(editor.view.dom.querySelector('.lr-latex-error')).toBeNull();
    expect(document.serialize(editor.getJSON())).toBe('<latex data-keep="block">\\begin{matrix}a&amp;b\\end{matrix}</latex><p>尾段</p>');
    undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction));
    expect(document.serialize(editor.getJSON())).toBe(source);
  });

  it('matches Feishu display-style summation limits within an inline formula without changing its source', () => {
    const expression = '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}';
    const source = `<p>前文<latex data-keep='inline'><![CDATA[${expression}]]></latex>后文</p>`;
    const { document, editor } = open(source);
    const formula = editor.view.dom.querySelector('.lr-latex-inline')!;
    expect(formula.tagName).toBe('SPAN');
    expect(formula.querySelector('.mop.op-limits')).not.toBeNull();
    expect(formula.querySelector('.op-symbol.large-op')).not.toBeNull();
    expect(formula.querySelector('.katex-display')).toBeNull();
    expect(formula.getAttribute('data-latex-source')).toBe(expression);
    expect(document.serialize(editor.getJSON())).toBe(source);
    replaceText(editor, '后文', '改后正文');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('后文', '改后正文'));
  });

  it('keeps formula context inside list items, callouts, columns and table cells', () => {
    const source = '<ul><li>列表<latex>x_1</latex>尾</li></ul><callout>提示<latex>x_2</latex></callout><grid><column width-ratio="1"><latex>x_3</latex><p>列内<latex>x_4</latex></p></column></grid><table><tr><td><latex>x_5</latex><p>格内<latex>x_6</latex></p></td></tr></table>';
    const { document, editor } = open(source);
    expect(document.serialize(editor.getJSON())).toBe(source);
    expect(editor.view.dom.querySelectorAll('.lr-latex-inline')).toHaveLength(4);
    expect(editor.view.dom.querySelectorAll('.lr-latex-block')).toHaveLength(2);
    replaceText(editor, '列表', '改列表');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('列表', '改列表'));
  });

  it('keeps malformed or unsupported TeX visible as source and never creates remote resources or injected HTML', () => {
    const source = '<p><latex>\\includegraphics{https://example.com/remote.png}</latex><latex>\\href{javascript:alert(1)}{x}</latex><latex>\\htmlClass{injected}{x}</latex><latex>\\badCommand{</latex><latex>&lt;script&gt;alert(1)&lt;/script&gt;</latex></p><latex><unknown/></latex><p>尾段</p>';
    const { document, editor } = open(source);
    expect(editor.view.dom.querySelector('img[src],script,a,.injected')).toBeNull();
    expect(editor.view.dom.querySelector('.lr-latex-error')).not.toBeNull();
    replaceText(editor, '尾段', '改后');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('尾段', '改后'));
  });

  it('escapes edited code and preserves whitespace and original code attributes', () => {
    const { document, editor } = open('<pre lang="go" caption="说明"><code data-keep="yes">a &lt; b\n    原文</code></pre>');
    replaceText(editor, '原文', 'c && d');
    const result = document.serialize(editor.getJSON());
    expect(result).toBe('<pre lang="go" caption="说明"><code data-keep="yes">a &lt; b\n    c &amp;&amp; d</code></pre>');
  });

  it('shows code captions, language and heading numbering metadata without modifying text or XML', () => {
    const source = '<h1 seq="auto">章节</h1><h2 seq="auto">小节</h2><pre lang="go" caption="示例 &lt;script&gt;"><code>原代码</code></pre>';
    const { document, editor } = open(source);
    expect(editor.view.dom.querySelector('h1')?.getAttribute('data-xml-seq')).toBe('auto');
    expect(editor.view.dom.querySelector('h2')?.getAttribute('data-xml-seq')).toBe('auto');
    expect(editor.view.dom.querySelector('.lr-code-caption')?.textContent).toBe('示例 <script>');
    expect(editor.view.dom.querySelector('.lr-code-language')?.textContent).toBe('go');
    expect(editor.view.dom.querySelector('.lr-code-block code')?.textContent).toBe('原代码');
    expect(editor.state.doc.textContent).toBe('章节小节原代码');
    expect(editor.view.dom.querySelector('script')).toBeNull();
    expect(document.serialize(editor.getJSON())).toBe(source);
    replaceText(editor, '原代码', '新代码');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('原代码', '新代码'));
  });

  it('protects unsupported containers as a whole and never injects raw XML as HTML', () => {
    const source = '<callout><table><tr><td><p>不可直接编辑</p></td></tr></table></callout><future><script>alert(1)</script><img href="https://example.com/x.png"/></future><p>尾段</p>';
    const { document, editor } = open(source);
    expect(editor.view.dom.querySelector('script,img,table')).toBeNull();
    replaceText(editor, '尾段', '新尾段');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('尾段', '新尾段'));
  });

  it('attaches local whiteboard previews while preserving the original XML and releasing removed views', () => {
    const source = '<whiteboard type="blank" data-keep=\'yes\'></whiteboard><whiteboard src="existing-board"/><p>尾段</p>';
    const { document, editor } = open(source);
    expect(editor.view.dom.querySelectorAll('.whiteboard-preview')).toHaveLength(2);
    const canvas = editor.view.dom.querySelector('.whiteboard-preview-blank')!;
    expect(canvas.getAttribute('aria-label')).toBe('空白画板');
    expect(editor.view.dom.querySelector('.whiteboard-preview-message')?.textContent).toContain('尚未缓存');
    expect(document.serialize(editor.getJSON())).toBe(source);
    replaceText(editor, '尾段', '改后');
    expect(document.serialize(editor.getJSON())).toBe(source.replace('尾段', '改后'));
    const preview = editor.view.dom.querySelector('.whiteboard-preview')!;
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild!.nodeSize));
    expect(preview.childElementCount).toBe(0);
  });

  it.each([
    '<p>未闭合', '<p><b>错配</p></b>', '<p align=center>无引号</p>',
    '<!DOCTYPE p SYSTEM "file:///etc/passwd"><p/>',
    '<!DOCTYPE p [<!ENTITY secret SYSTEM "https://example.com">]><p>&secret;</p>',
    '<p>&unknown;</p>', '<p>a & b</p>', '<p x="1" x="2"/>', '<p>\u0000</p>',
  ])('rejects malformed or dangerous XML instead of repairing it: %s', source => {
    expect(() => parseDocxXML(source)).toThrow();
  });

  it('allows entity-looking code as CDATA without interpreting it', () => {
    const source = '<pre><code><![CDATA[<!DOCTYPE example> && <x>]]></code></pre>';
    const { document, editor } = open(source);
    expect(document.serialize(editor.getJSON())).toBe(source);
    expect(editor.state.doc.textContent).toContain('<!DOCTYPE example>');
  });
});
