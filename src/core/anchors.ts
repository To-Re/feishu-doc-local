import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { StepMap } from '@tiptap/pm/transform';
import type { Anchor, AnchorTarget, ReviewComment } from './types';

type Span = { from: number; to: number };

/** Stored identities are opaque data, not selectors, URLs to fetch, or source code. */
export function isAnchorTarget(value: unknown): value is AnchorTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return target.kind === 'whiteboard-component' &&
    typeof target.board === 'string' && target.board.trim().length > 0 && target.board.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(target.board) &&
    typeof target.id === 'string' && target.id.length > 0 && target.id.length <= 512 &&
    !/[\s\u0000-\u001f\u007f]/u.test(target.id) &&
    (target.label === undefined || typeof target.label === 'string') &&
    Object.keys(target).every(key => key === 'kind' || key === 'board' || key === 'id' || key === 'label');
}

function validRange(doc: PMNode, from: number, to: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= doc.content.size;
}

/** A quote describes a leaf; its text length never becomes a document position. */
function leafQuote(node: PMNode): string {
  if (node.type.spec.leafText) return node.type.spec.leafText(node);
  if (node.type.name === 'xmlInlineLatex' || node.type.name === 'xmlBlockLatex') {
    const expression = typeof node.attrs.expression === 'string' ? node.attrs.expression.trim() : '';
    return expression ? `【公式：${expression}】` : '【空公式】';
  }
  if (node.type.name === 'protectedInline' || node.type.name === 'protectedBlock') {
    const kind = ({ img: '图片', whiteboard: '白板', source: '附件', figure: '附件' } as Record<string, string>)[node.attrs.lrTag] || '受保护内容';
    const label = typeof node.attrs.label === 'string' ? node.attrs.label.trim() : '';
    return label && label !== `〈${node.attrs.lrTag}〉` ? `【${kind}：${label}】` : `【${kind}】`;
  }
  return '';
}

/** Positions use ProseMirror's UTF-16 offsets, including positions between blocks. */
export function captureAnchor(doc: PMNode, from: number, to: number): Anchor | null {
  if (!validRange(doc, from, to)) return null;
  const quote = doc.textBetween(from, to, '\n', leafQuote);
  if (!quote.trim()) return null;
  return { from, to, quote, state: 'attached' };
}

function whiteboardAt(doc: PMNode, from: number): PMNode | null {
  if (!Number.isSafeInteger(from) || from < 0 || from >= doc.content.size) return null;
  const node = doc.nodeAt(from);
  return node?.isAtom && node.isLeaf && node.attrs.lrTag === 'whiteboard' &&
    (node.type.name === 'protectedBlock' || node.type.name === 'protectedInline') ? node : null;
}

/** A component is anchored to its containing board atom; its identity stays in the sidecar only. */
export function captureWhiteboardComponentAnchor(doc: PMNode, from: number, target: AnchorTarget): Anchor | null {
  const node = whiteboardAt(doc, from);
  if (!node || !isAnchorTarget(target)) return null;
  const label = target.label?.trim() || target.id;
  return { from, to: from + node.nodeSize, quote: `【白板节点：${label}】`, state: 'attached', target: { ...target } };
}

/** Track original text and atoms, not the structure between selected paragraphs. */
function originalTargetSpans(doc: PMNode, anchor: Anchor): Span[] {
  const spans: Span[] = [];
  doc.nodesBetween(anchor.from, anchor.to, (node, pos) => {
    if (node.isText || (node.isLeaf && leafQuote(node))) {
      const from = Math.max(anchor.from, pos);
      const to = Math.min(anchor.to, pos + node.nodeSize);
      if (from < to) spans.push({ from, to });
    }
  });
  return spans;
}

/** Split around inserted/replaced content so it never counts as surviving original targets. */
function mapSurvivors(spans: Span[], map: StepMap): Span[] {
  const changes: Span[] = [];
  map.forEach((from, to) => changes.push({ from, to }));
  if (!changes.length) return spans;

  const survivors: Span[] = [];
  for (const span of spans) {
    let cursor = span.from;
    for (const change of changes) {
      if (change.to < cursor || change.from > span.to) continue;
      const end = Math.min(change.from, span.to);
      if (cursor < end) {
        const from = map.map(cursor, 1);
        const to = map.map(end, -1);
        if (from < to) survivors.push({ from, to });
      }
      cursor = Math.max(cursor, change.to);
      if (cursor >= span.to) break;
    }
    if (cursor < span.to) {
      const from = map.map(cursor, 1);
      const to = map.map(span.to, -1);
      if (from < to) survivors.push({ from, to });
    }
  }
  return survivors;
}

/** Follow this transaction only. An unrelated document reload must invalidate anchors. */
export function mapAnchor(anchor: Anchor, tr: Transaction): Anchor {
  if (anchor.state !== 'attached' || !tr.docChanged) return anchor;
  if (!validRange(tr.before, anchor.from, anchor.to)) return { ...anchor, state: 'unverified' };
  if (anchor.target) {
    const board = whiteboardAt(tr.before, anchor.from);
    if (!isAnchorTarget(anchor.target) || !board || anchor.to !== anchor.from + board.nodeSize)
      return { ...anchor, state: 'unverified' };
  }

  let survivors = originalTargetSpans(tr.before, anchor);
  if (!survivors.length) return { ...anchor, state: 'unverified' };

  let { from, to } = anchor;
  for (let index = 0; index < tr.mapping.maps.length; index += 1) {
    const map = tr.mapping.maps[index];
    survivors = mapSurvivors(survivors, map);
    // Boundary inserts belong to neighboring text, while interior inserts stay in the range.
    from = map.map(from, 1);
    to = map.map(to, -1);
    if (!survivors.length) {
      // Complete replacement is a deletion of the original target, even if new text remains.
      const position = Math.min(tr.mapping.slice(index + 1).map(Math.min(from, to), -1), tr.doc.content.size);
      return { ...anchor, from: Math.max(0, position), to: Math.max(0, position), state: 'deleted' };
    }
  }
  if (from === anchor.from && to === anchor.to) return anchor;
  return { ...anchor, from, to };
}

export function mapComments(comments: ReviewComment[], tr: Transaction): ReviewComment[] {
  let changed = false;
  const mapped = comments.map((comment) => {
    const anchor = mapAnchor(comment.anchor, tr);
    if (anchor === comment.anchor) return comment;
    changed = true;
    return { ...comment, anchor };
  });
  return changed ? mapped : comments;
}

/** External whole-document revisions have no transaction history proving correspondence. */
export function invalidateAnchors(comments: ReviewComment[]): ReviewComment[] {
  return comments.map((comment) => comment.anchor.state === 'unverified'
    ? comment
    : { ...comment, anchor: { ...comment.anchor, state: 'unverified' } });
}
