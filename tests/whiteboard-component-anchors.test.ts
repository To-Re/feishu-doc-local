import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { captureAnchor, captureWhiteboardComponentAnchor, invalidateAnchors, mapAnchor, mapComments } from '../src/core/anchors';
import { parseDocxXML } from '../src/core/docxml';
import type { Anchor, AnchorTarget, ReviewComment } from '../src/core/types';
import { xmlExtensions } from '../src/ui/xml-extensions';

const schema = getSchema(xmlExtensions());
const doc = (xml: string) => schema.nodeFromJSON(parseDocxXML(xml).content);
const state = (xml: string) => EditorState.create({ schema, doc: doc(xml) });
const target: AnchorTarget = { kind: 'whiteboard-component', board: 'token:public-test-board', id: 'node-review', label: '人类评审' };
const boardXML = '<whiteboard token="public-test-board"/>';
const comment = (anchor: Anchor): ReviewComment => ({
  id: 'board-component', author: '我', body: '说明这个节点的输入', createdAt: '2026-09-12T00:00:00Z',
  status: 'open', anchor, replies: [],
});

describe('whiteboard component anchors', () => {
  it('stores an actual component identity inside the containing atom range, separate from its display quote', () => {
    const document = doc(boardXML + '<p>后文</p>');
    const anchor = captureWhiteboardComponentAnchor(document, 0, target)!;
    expect(anchor).toEqual({ from: 0, to: 1, quote: '【白板节点：人类评审】', state: 'attached', target });
    expect(anchor.target).not.toBe(target);
    expect(captureWhiteboardComponentAnchor(document, 0, { ...target, label: undefined })?.quote).toBe('【白板节点：node-review】');
    expect(captureAnchor(document, 0, 1)).toEqual({ from: 0, to: 1, quote: '【白板】', state: 'attached' });
  });

  it('rejects text, formulas, images, mixed ranges and invalid component identities', () => {
    for (const xml of ['<p>普通文字</p>', '<latex>x^2</latex>', '<img path="@image.png"/>'])
      expect(captureWhiteboardComponentAnchor(doc(xml), 0, target)).toBeNull();
    for (const position of [-1, 0.5, 1, 999])
      expect(captureWhiteboardComponentAnchor(doc(boardXML), position, target)).toBeNull();
    expect(captureWhiteboardComponentAnchor(doc(boardXML), 0, { ...target, id: '' })).toBeNull();
    const s = state(boardXML + '<p>普通文字</p>');
    const textAnchor: Anchor = { ...captureAnchor(s.doc, 2, 4)!, target };
    expect(mapAnchor(textAnchor, s.tr.insertText('新增', 2))).toEqual({ ...textAnchor, state: 'unverified' });
    const mixedAnchor: Anchor = { ...captureAnchor(s.doc, 0, 4)!, target };
    expect(mapAnchor(mixedAnchor, s.tr.insertText('新增', 2)).state).toBe('unverified');
  });

  it('follows edits before the selected board and retains distinct node ids even when labels are identical', () => {
    const s = state('<p>前文</p>' + boardXML + boardXML);
    const first = captureWhiteboardComponentAnchor(s.doc, 4, target)!;
    const second = captureWhiteboardComponentAnchor(s.doc, 5, { ...target, id: 'node-next' })!;
    const transaction = s.tr.insertText('😀', 1);
    expect(mapAnchor(first, transaction)).toEqual({ ...first, from: 6, to: 7 });
    expect(mapAnchor(second, transaction)).toEqual({ ...second, from: 7, to: 8 });
    expect(mapComments([comment(first)], transaction)[0].anchor.target).toEqual(target);
  });

  it('keeps the identity through source attribute edits but does not guess whether a component still exists', () => {
    const s = state(boardXML + '<p>后文</p>');
    const anchor = captureWhiteboardComponentAnchor(s.doc, 0, target)!;
    const transaction = s.tr.setNodeAttribute(0, 'rawXML', '<whiteboard token="public-test-board" type="mermaid">flowchart LR; A-->B</whiteboard>');
    expect(mapAnchor(anchor, transaction)).toBe(anchor);
  });

  it('marks a deleted or replaced board deleted instead of rebinding an identical neighboring board', () => {
    const s = state(boardXML + boardXML + '<p>后文</p>');
    const anchor = captureWhiteboardComponentAnchor(s.doc, 1, target)!;
    const deleted = mapAnchor(anchor, s.tr.delete(1, 2));
    expect(deleted).toEqual({ ...anchor, from: 1, to: 1, state: 'deleted' });
    const replacement = doc(boardXML).firstChild!;
    expect(mapAnchor(anchor, s.tr.replaceWith(1, 2, replacement))).toEqual({ ...anchor, from: 1, to: 1, state: 'deleted' });
  });

  it('preserves target metadata while invalidating an external document version, without resurrecting deleted nodes', () => {
    const s = state(boardXML + '<p>后文</p>');
    const anchor = captureWhiteboardComponentAnchor(s.doc, 0, target)!;
    const invalid = invalidateAnchors([comment(anchor)])[0];
    expect(invalid.anchor).toEqual({ ...anchor, state: 'unverified' });
    expect(mapAnchor(invalid.anchor, s.tr.insertText('新增', 2))).toBe(invalid.anchor);
    const deleted: Anchor = { ...anchor, from: 0, to: 0, state: 'deleted' };
    expect(mapAnchor(deleted, s.tr.insert(0, doc(boardXML).firstChild!))).toBe(deleted);
  });
});
