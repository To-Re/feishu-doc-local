import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { getSchema } from '@tiptap/core';
import { captureAnchor, invalidateAnchors, mapAnchor, mapComments } from '../src/core/anchors';
import type { Anchor, ReviewComment } from '../src/core/types';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    table: { group: 'block', content: 'row+' },
    row: { content: 'cell+' },
    cell: { content: 'paragraph+' },
  },
  marks: { strong: {} },
});
const p = (text: string) => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks);
const state = (document: PMNode) => EditorState.create({ schema: document.type.schema, doc: document });
const select = (document: PMNode, from: number, to: number) => captureAnchor(document, from, to)!;
const comment = (anchor: Anchor): ReviewComment => ({
  id: 'comment-1', author: '人类', body: '补充依据', createdAt: '2026-09-12T00:00:00.000Z',
  status: 'open', anchor, replies: [],
});
const xmlSchema = getSchema(xmlExtensions());
const xmlDoc = (xml: string) => xmlSchema.nodeFromJSON(parseDocxXML(xml).content);

describe('comment anchors through real ProseMirror transactions', () => {
  it('captures text and rejects empty or invalid ranges', () => {
    const document = doc(p('中文文章'));
    expect(select(document, 1, 3).quote).toBe('中文');
    for (const [from, to] of [[1, 1], [3, 1], [-1, 2], [1, 999], [1.5, 2]]) {
      expect(captureAnchor(document, from, to)).toBeNull();
    }
    expect(captureAnchor(doc(p('  ')), 1, 3)).toBeNull();
  });

  it.each([
    ['<latex>\\frac{a}{b}</latex>', '【公式：\\frac{a}{b}】'],
    ['<latex/>', '【空公式】'],
    ['<img path="@./image.png" caption="对照图"/>', '【图片：对照图】'],
    ['<whiteboard type="mermaid"><![CDATA[graph LR; SecretSource --> B]]></whiteboard>', '【白板】'],
    ['<source token="private-reference" name="说明.pdf"/>', '【附件：说明.pdf】'],
  ])('captures an actual DocxXML atom using a display quote and its single original position: %s', (xml, quote) => {
    const document = xmlDoc(xml);
    expect(document.firstChild!.isLeaf).toBe(true);
    expect(document.firstChild!.nodeSize).toBe(1);
    expect(select(document, 0, 1)).toEqual({ from: 0, to: 1, quote, state: 'attached' });
  });

  it('captures inline formulas mixed with text without using quote length as a position', () => {
    const document = xmlDoc('<p>前<latex>x_{long}</latex>后</p>');
    const atom = select(document, 2, 3);
    expect(atom.quote).toBe('【公式：x_{long}】');
    expect(select(document, 1, 4).quote).toBe('前【公式：x_{long}】后');
    const tr = state(document).tr.insertText('😀', 1);
    expect(mapAnchor(atom, tr)).toEqual({ ...atom, from: 4, to: 5 });
    expect(tr.doc.nodeAt(4)!.type.name).toBe('xmlInlineLatex');
  });

  it('follows the selected atom past edits without binding another atom with the same label', () => {
    const document = xmlDoc('<img path="@./first.png" caption="相同图片"/><img path="@./second.png" caption="相同图片"/><p>后文</p>');
    const anchor = select(document, 1, 2);
    const tr = state(document).tr.insert(0, xmlSchema.node('paragraph', null, xmlSchema.text('新增前文')));
    const mapped = mapAnchor(anchor, tr);
    expect(mapped).toEqual({ ...anchor, from: 7, to: 8 });
    expect(tr.doc.nodeAt(mapped.from)!.attrs.lrAttrs.path).toBe('@./second.png');
    const deleted = state(document).tr.delete(1, 2);
    expect(mapAnchor(anchor, deleted)).toEqual({ ...anchor, from: 1, to: 1, state: 'deleted' });
    expect(deleted.doc.firstChild!.attrs.lrAttrs.path).toBe('@./first.png');
  });

  it('keeps an atom attached through attribute-only editing and marks an actual replacement deleted', () => {
    const document = xmlDoc('<latex>x_1</latex><p>后文</p>');
    const anchor = select(document, 0, 1);
    const edited = state(document).tr.setNodeAttribute(0, 'expression', 'x_2');
    expect(mapAnchor(anchor, edited)).toBe(anchor);
    expect(select(edited.doc, 0, 1).quote).toBe('【公式：x_2】');
    expect(anchor.quote).toBe('【公式：x_1】');
    const replacement = xmlSchema.node('xmlBlockLatex', { expression: 'x_1' });
    expect(mapAnchor(anchor, state(document).tr.replaceWith(0, 1, replacement)).state).toBe('deleted');
  });

  it('does not count newly inserted atoms as surviving parts of a mixed target', () => {
    const document = xmlDoc('<p>甲<latex>x</latex>乙</p>');
    const anchor = select(document, 1, 4);
    const tr = state(document).tr
      .insert(2, xmlSchema.node('xmlInlineLatex', { expression: 'x' }))
      .delete(1, 2)
      .delete(2, 4);
    expect(tr.doc.firstChild!.childCount).toBe(1);
    expect(tr.doc.firstChild!.firstChild!.attrs.expression).toBe('x');
    expect(mapAnchor(anchor, tr).state).toBe('deleted');
  });

  it('follows an insertion before the range, without matching identical text elsewhere', () => {
    const document = doc(p('相同文字，相同文字'));
    const anchor = select(document, 6, 10);
    const tr = state(document).tr.insertText('新增前文：', 1);
    const result = mapAnchor(anchor, tr);
    expect(result).toEqual({ ...anchor, from: 11, to: 15 });
    expect(tr.doc.textBetween(result.from, result.to)).toBe('相同文字');
  });

  it('excludes inserts at both boundaries, and includes edits inside the selected passage', () => {
    const document = doc(p('甲乙丙丁'));
    const anchor = select(document, 2, 4);
    const tr = state(document).tr.insertText('前', 2).insertText('后', 5).insertText('中', 4);
    const result = mapAnchor(anchor, tr);
    expect(tr.doc.textBetween(result.from, result.to)).toBe('乙中丙');
    expect(result.quote).toBe('乙丙');
    expect(result.state).toBe('attached');
  });

  it('retains a partially deleted selection and its original quote', () => {
    const document = doc(p('甲乙丙丁'));
    const anchor = select(document, 2, 4);
    const tr = state(document).tr.delete(2, 3);
    expect(mapAnchor(anchor, tr)).toEqual({ ...anchor, from: 2, to: 3 });
  });

  it('marks complete deletion as deleted rather than attaching to adjacent repeated text', () => {
    const document = doc(p('原文原文'));
    const anchor = select(document, 1, 3);
    const result = mapAnchor(anchor, state(document).tr.delete(1, 3));
    expect(result).toEqual({ ...anchor, from: 1, to: 1, state: 'deleted' });
  });

  it('does not attach a completely replaced target to its replacement', () => {
    const document = doc(p('前原文后'));
    const anchor = select(document, 2, 4);
    const tr = state(document).tr.insertText('新的措辞', 2, 4);
    const result = mapAnchor(anchor, tr);
    expect(result.state).toBe('deleted');
    expect(result.from).toBe(result.to);
    expect(result.quote).toBe('原文');
  });

  it('detects deletion of every original character across multiple steps even when inserted text survives', () => {
    const document = doc(p('甲乙'));
    const anchor = select(document, 1, 3);
    const tr = state(document).tr.insertText('新', 2).delete(1, 2).delete(2, 3);
    expect(tr.doc.textContent).toBe('新');
    expect(mapAnchor(anchor, tr).state).toBe('deleted');
  });

  it('follows a cross-paragraph range and ignores retained structure when all selected text is removed', () => {
    const document = doc(p('甲乙'), p('丙丁'));
    const anchor = select(document, 2, 6);
    expect(anchor.quote).toBe('乙\n丙');
    const inserted = state(document).tr.insertText('前', 1);
    const moved = mapAnchor(anchor, inserted);
    expect(inserted.doc.textBetween(moved.from, moved.to, '\n')).toBe('乙\n丙');
    const deleted = state(document).tr.delete(5, 6).delete(2, 3);
    expect(deleted.doc.childCount).toBe(2);
    expect(mapAnchor(anchor, deleted).state).toBe('deleted');
  });

  it('uses UTF-16 positions for emoji and follows selections crossing table cells', () => {
    const table = schema.node('table', null, [schema.node('row', null, [
      schema.node('cell', null, [p('甲😀乙')]), schema.node('cell', null, [p('丙丁')]),
    ])]);
    const document = doc(p('序'), table);
    const positions: number[] = [];
    document.descendants((node, pos) => { if (node.isText) positions.push(pos); });
    const first = positions[1], second = positions[2];
    const anchor = select(document, first + 1, second + 1);
    expect(anchor.quote).toBe('😀乙\n丙');
    const tr = state(document).tr.insertText('📝', 1);
    const moved = mapAnchor(anchor, tr);
    expect(moved.from).toBe(anchor.from + 2);
    expect(moved.to).toBe(anchor.to + 2);
    expect(tr.doc.textBetween(moved.from, moved.to, '\n')).toBe(anchor.quote);
    const deleted = state(document).tr.delete(second, second + 1).delete(first + 1, first + 4);
    expect(mapAnchor(anchor, deleted).state).toBe('deleted');
  });

  it('does not alter anchors for formatting or selection-only transactions', () => {
    const document = doc(p('正文'));
    const anchor = select(document, 1, 3);
    expect(mapAnchor(anchor, state(document).tr)).toBe(anchor);
    expect(mapAnchor(anchor, state(document).tr.addMark(1, 3, schema.mark('strong')))).toBe(anchor);
  });

  it('maps comments without losing replies/status and uses the same function for a comment draft', () => {
    const document = doc(p('正文'));
    const anchor = select(document, 1, 3);
    const original = comment(anchor);
    original.status = 'resolved';
    original.replies.push({ id: 'reply-1', author: 'AI', body: '收到', createdAt: original.createdAt });
    const tr = state(document).tr.insertText('前', 1);
    expect(mapComments([original], tr)[0]).toEqual({ ...original, anchor: mapAnchor(anchor, tr) });
    const unchanged = [original];
    expect(mapComments(unchanged, state(document).tr)).toBe(unchanged);
  });

  it('does not resurrect deleted/unverified anchors and explicitly invalidates external revisions', () => {
    const document = doc(p('正文'));
    const anchor = select(document, 1, 3);
    const deleted: Anchor = { ...anchor, from: 1, to: 1, state: 'deleted' };
    const unknown: Anchor = { ...anchor, state: 'unverified' };
    const tr = state(document).tr.insertText('正文', 1);
    expect(mapAnchor(deleted, tr)).toBe(deleted);
    expect(mapAnchor(unknown, tr)).toBe(unknown);
    const comments = [comment(anchor), comment(deleted)];
    expect(invalidateAnchors(comments).map((item) => item.anchor.state)).toEqual(['unverified', 'unverified']);
    expect(comments[0].anchor.state).toBe('attached');
  });
});
