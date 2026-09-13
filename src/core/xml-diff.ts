import { diffArrays, diffChars } from 'diff';
import { SaxesParser } from 'saxes';

export type DiffPart = { text: string; changed: boolean };
export type DiffCell = { number: number; text: string; parts: DiffPart[] };
export type DiffRow = { kind: 'equal' | 'change'; before?: DiffCell; after?: DiffCell };
export type XMLDiff = { rows: DiffRow[]; added: number; removed: number; identical: boolean; limited: boolean; notice?: string };

const MAX_INPUT = 1_000_000;
const MAX_ROWS = 8_000;
const MAX_ELEMENTS = 32_000;
const MAX_DEPTH = 256;
const TOTAL_MS = 120;
const INLINE_MAX = 4_096;
const INLINE_TOTAL = 40_000;
const atomicBlocks = new Set(['p', 'title', 'pre', 'blockquote', 'callout', 'tr', 'checkbox', ...Array.from({ length: 9 }, (_, index) => 'h' + (index + 1))]);

type Element = { tag: string; start: number; openEnd: number; end: number; closeStart: number; mixed: boolean; children: Element[] };
class DisplayLimit extends Error {}
function checkTime(deadline: number) {
  if (Date.now() >= deadline) throw new DisplayLimit('结构分段超过时间预算，请展开「查看完整原文」。');
}

/** Boundaries are parser offsets into the original string, never serialized XML.
 * A display row is an XML block or inter-block trivia, not a physical file line.
 */
function displayRows(xml: string, deadline: number): string[] {
  if (!xml) return [];
  const roots: Element[] = [], stack: Element[] = [];
  const parser = new SaxesParser({ fragment: true, xmlns: false });
  let start = 0, elements = 0;
  parser.on('error', error => { throw error; });
  parser.on('doctype', () => { throw new Error('DOCTYPE'); });
  parser.on('opentagstart', () => { start = xml.lastIndexOf('<', parser.position - 1); });
  parser.on('opentag', tag => {
    if (++elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) throw new DisplayLimit('XML 结构过多或嵌套过深，请展开「查看完整原文」。');
    if (elements % 64 === 0) checkTime(deadline);
    const element: Element = { tag: tag.name, start, openEnd: parser.position, end: 0, closeStart: 0, mixed: false, children: [] };
    if (stack.length) stack.at(-1)!.children.push(element); else roots.push(element);
    stack.push(element);
  });
  parser.on('closetag', tag => {
    const element = stack.pop()!;
    element.end = parser.position;
    element.closeStart = tag.isSelfClosing ? element.openEnd : xml.lastIndexOf('</', element.end - 1);
  });
  parser.on('text', text => { if (text.trim() && stack.length) stack.at(-1)!.mixed = true; });
  // Even whitespace-only CDATA stays inside its containing block.
  parser.on('cdata', () => { if (stack.length) stack.at(-1)!.mixed = true; });
  parser.write(xml).close();
  checkTime(deadline);

  const rows: string[] = [];
  function add(from: number, to: number) {
    if (from === to) return;
    if (rows.length >= MAX_ROWS) throw new DisplayLimit('XML 展示行数超过 8,000 行，请展开「查看完整原文」。');
    rows.push(xml.slice(from, to));
  }
  function visit(element: Element) {
    if (atomicBlocks.has(element.tag) || element.mixed || !element.children.length) {
      add(element.start, element.end); return;
    }
    add(element.start, element.openEnd);
    let offset = element.openEnd;
    for (const child of element.children) {
      add(offset, child.start); visit(child); offset = child.end;
    }
    add(offset, element.closeStart);
    add(element.closeStart, element.end);
  }
  let offset = 0;
  for (const root of roots) { add(offset, root.start); visit(root); offset = root.end; }
  add(offset, xml.length);
  checkTime(deadline);
  if (rows.join('') !== xml) throw new Error('XML slices did not preserve their source');
  return rows;
}

function unavailable(notice: string): XMLDiff {
  return { rows: [], added: 0, removed: 0, identical: false, limited: true, notice };
}
const whole = (text: string, changed: boolean): DiffPart[] => [{ text, changed }];

/** before is the side to be replaced; after is the chosen synchronization source.
 * Equal strings exit before parsing. A limited result with no rows has no counts;
 * callers must show the notice and offer the complete source instead of "0 changes".
 */
export function buildXMLDiff(before: string, after: string): XMLDiff {
  if (before === after) return { rows: [], added: 0, removed: 0, identical: true, limited: false };
  if (before.length > MAX_INPUT || after.length > MAX_INPUT)
    return unavailable('正文超过 1,000,000 字符，未计算结构差异。请展开「查看完整原文」。');
  const deadline = Date.now() + TOTAL_MS;
  let beforeRows: string[], afterRows: string[];
  try { beforeRows = displayRows(before, deadline); afterRows = displayRows(after, deadline); }
  catch (error) {
    return unavailable(error instanceof DisplayLimit ? error.message : '无法安全按 XML 结构分段，未计算差异。请展开「查看完整原文」。');
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return unavailable('结构差异超过时间预算，请展开「查看完整原文」。');
  const changes = diffArrays(beforeRows, afterRows, { timeout: remaining, maxEditLength: 2_000 });
  if (!changes) return unavailable('结构差异超过计算预算，未生成部分结果。请展开「查看完整原文」。');

  const rows: DiffRow[] = [];
  let beforeNumber = 0, afterNumber = 0, added = 0, removed = 0, inlineBudget = INLINE_TOTAL, limited = false;
  function parts(left: string, right: string): [DiffPart[], DiffPart[]] {
    const time = deadline - Date.now();
    if (left.length > INLINE_MAX || right.length > INLINE_MAX || left.length + right.length > inlineBudget || time <= 0) {
      limited = true; return [whole(left, true), whole(right, true)];
    }
    inlineBudget -= left.length + right.length;
    const detail = diffChars(left, right, { timeout: Math.min(10, time), maxEditLength: 1_500 });
    if (!detail) { limited = true; return [whole(left, true), whole(right, true)]; }
    return [detail.filter(part => !part.added).map(part => ({ text: part.value, changed: !!part.removed })),
      detail.filter(part => !part.removed).map(part => ({ text: part.value, changed: !!part.added }))];
  }
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      for (const text of change.value) rows.push({ kind: 'equal', before: { number: ++beforeNumber, text, parts: whole(text, false) }, after: { number: ++afterNumber, text, parts: whole(text, false) } });
      index++; continue;
    }
    const left: string[] = [], right: string[] = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const part = changes[index++];
      (part.removed ? left : right).push(...part.value);
    }
    removed += left.length; added += right.length;
    for (let pair = 0; pair < Math.max(left.length, right.length); pair++) {
      const beforeText = left[pair], afterText = right[pair];
      const [beforeParts, afterParts] = beforeText !== undefined && afterText !== undefined ? parts(beforeText, afterText) : [whole(beforeText || '', true), whole(afterText || '', true)];
      rows.push({ kind: 'change',
        ...(beforeText !== undefined ? { before: { number: ++beforeNumber, text: beforeText, parts: beforeParts } } : {}),
        ...(afterText !== undefined ? { after: { number: ++afterNumber, text: afterText, parts: afterParts } } : {}) });
    }
  }
  return { rows, added, removed, identical: false, limited,
    ...(limited ? { notice: '部分展示行过长或逐字比较超过预算，已保留整行增删标记；可展开「查看完整原文」。' } : {}) };
}
