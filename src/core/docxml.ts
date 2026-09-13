import type { JSONContent } from '@tiptap/core';
import { SaxesParser } from 'saxes';

type Attrs = Record<string, string>;
type XMLText = { kind: 'text'; text: string };
type XMLRaw = { kind: 'raw'; raw: string };
type XMLElement = {
  kind: 'element'; tag: string; attrs: Attrs; children: XMLNode[];
  start: number; end: number; openEnd: number; closeStart: number; source: string;
};
type XMLNode = XMLText | XMLRaw | XMLElement;
type SavedNode = { element: XMLElement; signature: string };

const blockTags = new Set(['title', 'p', 'blockquote', 'pre', 'ul', 'ol', 'li', 'checkbox', 'table', 'grid', 'column', 'callout', 'hr', ...Array.from({ length: 9 }, (_, i) => `h${i + 1}`)]);
const markTags: Record<string, string> = { b: 'bold', em: 'italic', i: 'italic', u: 'underline', del: 'strike', code: 'code', a: 'link', span: 'xmlSpan' };
const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

/** Strict fragment parsing. No HTML repair, entity declarations, resource reads or requests. */
function readXML(xml: string): XMLElement[] {
  if (new TextEncoder().encode(xml).length > 20_000_000) throw new Error('DocxXML 超过 20 MB。');
  const roots: XMLElement[] = [];
  const stack: XMLElement[] = [];
  const parser = new SaxesParser({ fragment: true, xmlns: false });
  let start = 0;
  const text = (value: string) => {
    if (stack.length) stack.at(-1)!.children.push({ kind: 'text', text: value });
    else if (value.trim()) throw new Error('DocxXML 正文必须放在块标签内。');
  };
  const trivia = (opening: string) => {
    // Saxes emits comment after '--', before consuming its final '>'.
    const end = parser.position + (opening === '<!--' ? 1 : 0);
    if (stack.length) stack.at(-1)!.children.push({ kind: 'raw', raw: xml.slice(xml.lastIndexOf(opening, end - 1), end) });
  };
  parser.on('error', error => { throw new Error(`DocxXML 格式错误：${error.message}`); });
  parser.on('doctype', () => { throw new Error('DocxXML 不允许 DOCTYPE 或实体声明。'); });
  parser.on('opentagstart', () => { start = xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    if (stack.length >= 256) throw new Error('DocxXML 嵌套超过 256 层。');
    const element: XMLElement = {
      kind: 'element', tag: tag.name, attrs: { ...tag.attributes }, children: [],
      start, end: 0, openEnd: parser.position, closeStart: parser.position, source: '',
    };
    if (stack.length) stack.at(-1)!.children.push(element);
    else roots.push(element);
    stack.push(element);
  });
  parser.on('closetag', tag => {
    const element = stack.pop()!;
    element.end = parser.position;
    element.closeStart = tag.isSelfClosing ? element.openEnd : xml.lastIndexOf('</', element.end - 1);
    element.source = xml.slice(element.start, element.end);
  });
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('comment', () => trivia('<!--'));
  parser.on('processinginstruction', () => trivia('<?'));
  parser.write(xml).close();
  return roots;
}

// ProseMirror adds defaults and sorts marks. Neither should count as a human edit.
function normalized(node: JSONContent): unknown {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (value == null || key === 'target' || key === 'rel' || key === 'class') continue;
    if ((key === 'start' || key === 'colspan' || key === 'rowspan') && value === 1) continue;
    if (key === 'checked' && value === false) continue;
    attrs[key] = value;
  }
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(attrs).length ? { attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) } : {}),
    ...(node.marks?.length ? { marks: node.marks.map(mark => normalized(mark)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
    ...(node.content?.length ? { content: node.content.map(normalized) } : {}),
  };
}
const signature = (node: JSONContent) => JSON.stringify(normalized(node));
const elementsOnly = (nodes: XMLNode[]) => nodes.every(node => node.kind === 'element' || (node.kind === 'text' && !node.text.trim()));

export interface ParsedDocxXML {
  content: JSONContent;
  warnings: string[];
  serialize(content: JSONContent): string;
}

/** The returned serializer belongs to this source revision; keep it with the editor session. */
export function parseDocxXML(xml: string): ParsedDocxXML {
  const roots = readXML(xml);
  const warnings = new Set<string>();
  const saved = new Map<string, SavedNode>();
  const sources = new Map<XMLElement, string>();
  let sequence = 0;
  function sourceID(element: XMLElement) {
    let key = sources.get(element);
    if (!key) { key = `xml-${++sequence}`; sources.set(element, key); }
    return key;
  }
  function remember(element: XMLElement, node: JSONContent): JSONContent {
    node.attrs = { ...node.attrs, lrSource: sourceID(element), lrAttrs: element.attrs, lrTag: element.tag };
    saved.set(node.attrs.lrSource, { element, signature: signature(node) });
    return node;
  }
  function protectedNode(element: XMLElement, inline = false): JSONContent {
    warnings.add(`〈${element.tag}〉作为受保护内容保留，正文编辑不会改写它。`);
    const children = element.children.filter(child => child.kind !== 'text' || child.text.trim());
    const attachmentName = element.tag === 'figure' && children.length === 1 && children[0].kind === 'element' &&
      children[0].tag === 'source' ? children[0].attrs.name : undefined;
    return remember(element, {
      type: inline ? 'protectedInline' : 'protectedBlock',
      attrs: {
        rawXML: element.source,
        label: element.attrs.caption || element.attrs.name || attachmentName || `〈${element.tag}〉`,
        assetPath: element.tag === 'img' ? element.attrs.path || null : null,
      },
    });
  }
  function latex(element: XMLElement, isInline: boolean): JSONContent {
    if (!element.children.every(child => child.kind === 'text')) return protectedNode(element, isInline);
    return remember(element, { type: isInline ? 'xmlInlineLatex' : 'xmlBlockLatex', attrs: { expression: element.children.map(child => (child as XMLText).text).join('') } });
  }
  function inline(nodes: XMLNode[], marks: NonNullable<JSONContent['marks']> = []): JSONContent[] {
    const output: JSONContent[] = [];
    for (const node of nodes) {
      if (node.kind === 'text') {
        if (node.text) output.push({ type: 'text', text: node.text, ...(marks.length ? { marks } : {}) });
        continue;
      }
      if (node.kind === 'raw') {
        output.push({ type: 'protectedInline', attrs: { rawXML: node.raw, label: 'XML 注释', assetPath: null }, ...(marks.length ? { marks } : {}) });
        continue;
      }
      if (node.tag === 'br' && !node.children.length) {
        output.push(remember(node, { type: 'hardBreak', ...(marks.length ? { marks } : {}) }));
      } else if (node.tag === 'latex') {
        output.push({ ...latex(node, true), ...(marks.length ? { marks } : {}) });
      } else if (markTags[node.tag] && node.children.length && !marks.some(mark => mark.type === markTags[node.tag]) &&
        !node.children.some(child => child.kind === 'element' && blockTags.has(child.tag))) {
        const attrs: Record<string, unknown> = { lrAttrs: node.attrs, lrTag: node.tag };
        if (node.tag === 'a') attrs.href = node.attrs.href || '';
        if (node.tag === 'span') {
          attrs.textColor = node.attrs['text-color'] || null;
          attrs.backgroundColor = node.attrs['background-color'] || null;
        }
        output.push(...inline(node.children, [...marks, { type: markTags[node.tag], attrs }]));
      } else {
        output.push({ ...protectedNode(node, true), ...(marks.length ? { marks } : {}) });
      }
    }
    // Adjacent text is normalized by ProseMirror on import.
    return output.reduce<JSONContent[]>((result, node) => {
      const prior = result.at(-1);
      if (node.type === 'text' && prior?.type === 'text' && JSON.stringify(normalized({ type: 'text', marks: node.marks })) === JSON.stringify(normalized({ type: 'text', marks: prior.marks }))) prior.text! += node.text!;
      else result.push(node);
      return result;
    }, []);
  }
  function flow(nodes: XMLNode[], unwrap = false, inlineMedia = unwrap): JSONContent[] {
    const result: JSONContent[] = [];
    let run: XMLNode[] = [];
    const flush = () => {
      if (run.some(node => node.kind !== 'text' || node.text.trim())) result.push({ type: 'paragraph', attrs: unwrap ? { lrTag: 'inline-run' } : undefined, content: inline(run) });
      run = [];
    };
    for (const node of nodes) {
      if (node.kind === 'element' && (blockTags.has(node.tag) || !inlineMedia && ['source', 'img', 'latex'].includes(node.tag) || !markTags[node.tag] && !['br', 'source', 'img', 'latex'].includes(node.tag))) {
        flush(); result.push(block(node));
      } else run.push(node);
    }
    flush();
    return result.length ? result : [{ type: 'paragraph' }];
  }
  function simple(element: XMLElement, type: string, attrs: Record<string, unknown> = {}): JSONContent {
    if (element.children.some(child => child.kind === 'element' && blockTags.has(child.tag))) return protectedNode(element);
    return remember(element, { type, attrs, content: inline(element.children) });
  }
  function table(element: XMLElement): JSONContent {
    if (!elementsOnly(element.children)) return protectedNode(element);
    const rows: { row: XMLElement; section?: XMLElement }[] = [];
    const colgroups: string[] = [];
    const columnWidths: number[] = [];
    for (const child of element.children) {
      if (child.kind !== 'element') continue;
      if (child.tag === 'colgroup' && child.children.every(col => col.kind === 'text' && !col.text.trim() || col.kind === 'element' && col.tag === 'col' && !col.children.length)) {
        colgroups.push(child.source);
        for (const col of child.children) if (col.kind === 'element') {
          const span = Number(col.attrs.span || 1), width = Number(col.attrs.width);
          if (!Number.isInteger(span) || span < 1 || columnWidths.length + span > 1000) return protectedNode(element);
          columnWidths.push(...Array.from({ length: span }, () => Number.isFinite(width) && width > 0 ? width : 0));
        }
      }
      else if (child.tag === 'tr') rows.push({ row: child });
      else if (['thead', 'tbody', 'tfoot'].includes(child.tag) && elementsOnly(child.children) && child.children.every(row => row.kind !== 'element' || row.tag === 'tr')) {
        sourceID(child);
        saved.set(sourceID(child), { element: child, signature: '' });
        rows.push(...child.children.filter((row): row is XMLElement => row.kind === 'element').map(row => ({ row, section: child })));
      } else return protectedNode(element);
    }
    if (!rows.length || rows.length > 1000) return protectedNode(element);
    const occupancy: boolean[][] = Array.from({ length: rows.length }, () => []);
    const converted: JSONContent[] = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const { row, section } = rows[rowIndex];
      if (!elementsOnly(row.children)) return protectedNode(element);
      const cells: JSONContent[] = [];
      let column = 0;
      for (const cell of row.children) {
        if (cell.kind !== 'element') continue;
        if (!['td', 'th'].includes(cell.tag)) return protectedNode(element);
        while (occupancy[rowIndex][column]) column++;
        const colspan = Number(cell.attrs.colspan || 1), rowspan = Number(cell.attrs.rowspan || 1);
        if (!Number.isInteger(colspan) || !Number.isInteger(rowspan) || colspan < 1 || rowspan < 1 || column + colspan > 1000 || rowIndex + rowspan > rows.length) return protectedNode(element);
        for (let r = rowIndex; r < rowIndex + rowspan; r++) for (let c = column; c < column + colspan; c++) {
          if (occupancy[r][c]) return protectedNode(element);
          occupancy[r][c] = true;
        }
        const widths = Array.from({ length: colspan }, (_, offset) => columnWidths[column + offset] || 0);
        column += colspan;
        cells.push(remember(cell, { type: cell.tag === 'th' ? 'tableHeader' : 'tableCell', attrs: { colspan, rowspan, colwidth: widths.some(width => width > 0) ? widths : null, xmlBackground: cell.attrs['background-color'] || null, verticalAlign: cell.attrs['vertical-align'] || null }, content: flow(cell.children) }));
      }
      if (!cells.length) return protectedNode(element);
      converted.push(remember(row, { type: 'tableRow', attrs: { lrSection: section ? sourceID(section) : null }, content: cells }));
    }
    const width = occupancy[0].length;
    if (occupancy.some(row => row.length !== width || Array.from({ length: width }, (_, i) => !row[i]).some(Boolean))) return protectedNode(element);
    return remember(element, { type: 'table', attrs: { xmlColgroup: colgroups.join('') || null }, content: converted });
  }
  function grid(element: XMLElement): JSONContent {
    if (!elementsOnly(element.children)) return protectedNode(element);
    const columns = element.children.filter((child): child is XMLElement => child.kind === 'element');
    const ratios = columns.map(column => Number(column.attrs['width-ratio']));
    if (!columns.length || columns.some(column => column.tag !== 'column') || !validRatios(ratios)) return protectedNode(element);
    return remember(element, { type: 'xmlGrid', content: columns.map(column => remember(column, {
      type: 'xmlColumn', attrs: { widthRatio: column.attrs['width-ratio'] }, content: flow(column.children, true, false),
    })) });
  }
  function validRatios(ratios: number[]): boolean {
    // Official fetch rounds each column to six decimal places. Flex layout
    // normalizes these weights for display; the original XML values stay intact.
    const tolerance = ratios.length * (0.0000005 + Number.EPSILON);
    return ratios.length > 0 && ratios.every(ratio => Number.isFinite(ratio) && ratio > 0 && ratio <= 1) && Math.abs(ratios.reduce((sum, ratio) => sum + ratio, 0) - 1) <= tolerance;
  }
  function codeText(children: XMLNode[]): string | undefined {
    if (!children.every(child => child.kind === 'text' || child.kind === 'element' && child.tag === 'br' && !child.children.length && !Object.keys(child.attrs).length)) return;
    return children.map(child => child.kind === 'text' ? child.text : '\n').join('');
  }
  function block(element: XMLElement): JSONContent {
    const { tag, attrs, children } = element;
    const align = attrs.align || null;
    if (tag === 'p') return simple(element, 'paragraph', { textAlign: align });
    if (tag === 'title') return simple(element, 'xmlTitle', { textAlign: align });
    if (/^h[1-9]$/.test(tag)) return simple(element, 'heading', { level: Number(tag.slice(1)), textAlign: align, xmlSeq: attrs.seq || null });
    if (tag === 'checkbox' && (attrs.done === undefined || ['true', 'false'].includes(attrs.done))) return simple(element, 'xmlCheckbox', { checked: attrs.done === 'true', textAlign: align });
    if (tag === 'hr' && !children.length) return remember(element, { type: 'horizontalRule' });
    if (tag === 'blockquote') return remember(element, { type: 'blockquote', content: flow(children) });
    if (tag === 'pre') {
      const code = children.filter(child => child.kind === 'element');
      const text = code.length === 1 && code[0].tag === 'code' ? codeText(code[0].children) : undefined;
      if (elementsOnly(children) && text !== undefined) {
        return remember(element, { type: 'codeBlock', attrs: { language: attrs.lang || null, xmlCaption: attrs.caption || null, xmlCodeAttrs: code[0].attrs }, content: text ? [{ type: 'text', text }] : [] });
      }
      return protectedNode(element);
    }
    if (tag === 'ul' || tag === 'ol') {
      if (!elementsOnly(children) || children.some(child => child.kind === 'element' && child.tag !== 'li')) return protectedNode(element);
      const items = children.filter((child): child is XMLElement => child.kind === 'element');
      if (!items.length) return protectedNode(element);
      const start = /^\d+$/.test(items[0].attrs.seq || '') ? Number(items[0].attrs.seq) : 1;
      return remember(element, { type: tag === 'ul' ? 'bulletList' : 'orderedList', attrs: tag === 'ol' ? { start } : undefined, content: items.map(item => {
        const content = flow(item.children, true);
        if (content[0].type !== 'paragraph') content.unshift({ type: 'paragraph', attrs: { lrTag: 'inline-run' } });
        return remember(item, { type: 'listItem', attrs: { textAlign: item.attrs.align || null, xmlSeq: item.attrs.seq || null }, content });
      }) });
    }
    if (tag === 'table') return table(element);
    if (tag === 'grid') return grid(element);
    if (tag === 'latex') return latex(element, false);
    if (tag === 'callout') {
      const allowed = new Set(['p', 'ol', 'ul', 'checkbox']);
      if (children.some(child => child.kind === 'element' && !allowed.has(child.tag) && !markTags[child.tag] && !['br', 'latex'].includes(child.tag))) return protectedNode(element);
      const content = flow(children, true, true);
      if (content.some(child => !['paragraph', 'bulletList', 'orderedList', 'xmlCheckbox'].includes(child.type || ''))) return protectedNode(element);
      return remember(element, { type: 'xmlCallout', attrs: { emoji: attrs.emoji || null, xmlBackground: attrs['background-color'] || null, borderColor: attrs['border-color'] || null, textColor: attrs['text-color'] || null }, content });
    }
    return protectedNode(element);
  }
  const content: JSONContent = { type: 'doc', content: roots.length ? roots.map(block) : [{ type: 'paragraph' }] };
  const originalSignature = signature(content);
  const gaps = new Map<string, string>();
  let cursor = 0;
  for (const element of roots) { gaps.set(sourceID(element), xml.slice(cursor, element.start)); cursor = element.end; }
  const trailing = xml.slice(cursor);

  function original(node: JSONContent) { return typeof node.attrs?.lrSource === 'string' ? saved.get(node.attrs.lrSource) : undefined; }
  function tagXML(tag: string, attrs: Record<string, unknown>, body: string, element?: XMLElement, empty = false) {
    const clean = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]));
    const attrsSame = element?.tag === tag && JSON.stringify(Object.entries(clean).sort()) === JSON.stringify(Object.entries(element.attrs).sort());
    const originallyClosed = element && element.openEnd === element.end;
    if (attrsSame && (!originallyClosed || !body)) {
      return xml.slice(element!.start, element!.openEnd) + body + (originallyClosed ? '' : xml.slice(element!.closeStart, element!.end));
    }
    const attributes = Object.entries(clean).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
    return empty && !body ? `<${tag}${attributes}/>` : `<${tag}${attributes}>${body}</${tag}>`;
  }
  function attrsFor(node: JSONContent): Record<string, unknown> { return { ...(node.attrs?.lrAttrs || {}) }; }
  function applyAttr(attrs: Record<string, unknown>, name: string, value: unknown) {
    if (value === null || value === undefined || value === '') delete attrs[name];
    else attrs[name] = value;
  }
  function inlineXML(nodes: JSONContent[] = []): string {
    let output = '';
    let open: NonNullable<JSONContent['marks']> = [];
    const markTag = (mark: NonNullable<JSONContent['marks']>[number]) => mark.attrs?.lrTag || ({ bold: 'b', italic: 'em', underline: 'u', strike: 'del', code: 'code', link: 'a', xmlSpan: 'span' } as Record<string, string>)[mark.type];
    for (const node of nodes) {
      const marks = node.marks || [];
      let shared = 0;
      while (shared < open.length && shared < marks.length && signature(open[shared]) === signature(marks[shared])) shared++;
      for (let i = open.length - 1; i >= shared; i--) output += `</${markTag(open[i])}>`;
      for (let i = shared; i < marks.length; i++) {
        const mark = marks[i], tag = markTag(mark);
        if (!tag) throw new Error(`不支持导出文字样式 ${mark.type}。`);
        const attrs = attrsFor(mark);
        if (mark.type === 'link') applyAttr(attrs, 'href', mark.attrs?.href);
        if (mark.type === 'xmlSpan') { applyAttr(attrs, 'text-color', mark.attrs?.textColor); applyAttr(attrs, 'background-color', mark.attrs?.backgroundColor); }
        output += `<${tag}${Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`).join('')}>`;
      }
      output += node.type === 'text' ? escapeText(node.text || '') : render({ ...node, marks: undefined });
      open = marks;
    }
    for (let i = open.length - 1; i >= 0; i--) output += `</${markTag(open[i])}>`;
    return output;
  }
  function containerXML(node: JSONContent, children: JSONContent[]): string {
    const element = original(node)?.element;
    if (!element || !elementsOnly(element.children)) return children.map(render).join('');
    const before = new Map<string, string>();
    let end = element.openEnd;
    for (const child of element.children) if (child.kind === 'element') {
      before.set(sourceID(child), xml.slice(end, child.start));
      end = child.end;
    }
    return children.map(child => (before.get(child.attrs?.lrSource) || '') + render(child)).join('') + xml.slice(end, element.closeStart);
  }
  function render(node: JSONContent): string {
    const prior = original(node);
    if (prior?.signature === signature(node)) return prior.element.source;
    if (node.type === 'protectedBlock' || node.type === 'protectedInline') {
      if (typeof node.attrs?.rawXML !== 'string') throw new Error('受保护块缺少原始 XML。');
      return node.attrs.rawXML;
    }
    const attrs = attrsFor(node), children = node.content || [];
    let tag = ({ paragraph: 'p', xmlTitle: 'title', blockquote: 'blockquote', bulletList: 'ul', orderedList: 'ol', listItem: 'li', xmlCheckbox: 'checkbox', xmlCallout: 'callout', xmlGrid: 'grid', xmlColumn: 'column', xmlInlineLatex: 'latex', xmlBlockLatex: 'latex', codeBlock: 'pre', hardBreak: 'br', horizontalRule: 'hr', table: 'table', tableRow: 'tr', tableHeader: 'th', tableCell: 'td' } as Record<string, string>)[node.type || ''];
    if (node.type === 'heading') tag = `h${node.attrs?.level || 1}`;
    if (!tag) throw new Error(`不支持导出节点 ${node.type || 'unknown'}。`);
    if (['paragraph', 'xmlTitle', 'heading', 'listItem', 'xmlCheckbox'].includes(node.type!)) applyAttr(attrs, 'align', node.attrs?.textAlign);
    if (['heading', 'listItem'].includes(node.type!)) applyAttr(attrs, 'seq', node.attrs?.xmlSeq);
    if (node.type === 'xmlCheckbox') attrs.done = node.attrs?.checked ? 'true' : 'false';
    if (node.type === 'xmlColumn') applyAttr(attrs, 'width-ratio', node.attrs?.widthRatio);
    if (node.type === 'xmlCallout') {
      applyAttr(attrs, 'emoji', node.attrs?.emoji); applyAttr(attrs, 'background-color', node.attrs?.xmlBackground);
      applyAttr(attrs, 'border-color', node.attrs?.borderColor); applyAttr(attrs, 'text-color', node.attrs?.textColor);
    }
    if (node.type === 'tableHeader' || node.type === 'tableCell') {
      for (const key of ['colspan', 'rowspan']) if ((node.attrs?.[key] || 1) !== 1 || key in attrs) attrs[key] = node.attrs?.[key] || 1;
      applyAttr(attrs, 'background-color', node.attrs?.xmlBackground); applyAttr(attrs, 'vertical-align', node.attrs?.verticalAlign);
    }
    let body: string;
    if (node.type === 'xmlInlineLatex' || node.type === 'xmlBlockLatex') {
      if (typeof node.attrs?.expression !== 'string') throw new Error('公式缺少源表达式。');
      body = escapeText(node.attrs.expression);
    } else if (node.type === 'xmlGrid' || node.type === 'xmlColumn') {
      if (node.type === 'xmlGrid' && (children.some(child => child.type !== 'xmlColumn') || !validRatios(children.map(child => Number(child.attrs?.widthRatio))))) throw new Error('分栏需要有效的 width-ratio，且各列比例之和为 1。');
      body = containerXML(node, children);
    } else if (node.type === 'codeBlock') {
      applyAttr(attrs, 'lang', node.attrs?.language);
      applyAttr(attrs, 'caption', node.attrs?.xmlCaption);
      const originalCode = prior?.element.children.find((child): child is XMLElement => child.kind === 'element' && child.tag === 'code');
      const text = children.map(child => child.text || '').join('');
      const codeAttrs = node.attrs?.xmlCodeAttrs || {};
      if (originalCode && text === codeText(originalCode.children) && JSON.stringify(codeAttrs) === JSON.stringify(originalCode.attrs)) body = originalCode.source;
      else {
        const escaped = escapeText(text);
        const usesBreaks = originalCode?.children.some(child => child.kind === 'element' && child.tag === 'br');
        body = tagXML('code', codeAttrs, usesBreaks ? escaped.replace(/\n/g,'<br/>') : escaped, originalCode);
      }
    } else if (node.type === 'table') {
      body = node.attrs?.xmlColgroup || '';
      let section: string | null = null;
      let sectionRows = '';
      const flush = () => {
        const element = section ? saved.get(section)?.element : undefined;
        body += element ? tagXML(element.tag, element.attrs, sectionRows, element) : sectionRows;
        sectionRows = '';
      };
      for (const row of children) {
        const next = row.attrs?.lrSection || null;
        if (next !== section) { flush(); section = next; }
        sectionRows += render(row);
      }
      flush();
    } else if (node.type === 'orderedList') {
      body = children.map((child, index) => {
        if (index || !node.attrs?.start || node.attrs.start === 1 || String(node.attrs.start) === String(child.attrs?.xmlSeq)) return render(child);
        return render({ ...child, attrs: { ...child.attrs, xmlSeq: String(node.attrs.start) } });
      }).join('');
    } else if (['paragraph', 'xmlTitle', 'heading', 'xmlCheckbox'].includes(node.type!)) body = inlineXML(children);
    else body = children.map(render).join('');
    if (node.type === 'paragraph' && node.attrs?.lrTag === 'inline-run') return body;
    return tagXML(tag, attrs, body, prior?.element, ['br', 'hr'].includes(tag));
  }
  return {
    content,
    warnings: [...warnings],
    serialize(next) {
      if (next.type !== 'doc') throw new Error('DocxXML 导出需要完整文档。');
      if (signature(next) === originalSignature) return xml;
      const result = (next.content || []).map(node => (gaps.get(node.attrs?.lrSource) || '') + render(node)).join('') + trailing;
      readXML(result);
      return result;
    },
  };
}
