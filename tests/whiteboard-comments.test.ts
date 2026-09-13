// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { captureWhiteboardComponentAnchor } from '../src/core/anchors';
import { parseDocxXML } from '../src/core/docxml';
import type { Anchor, AnchorTarget, ReviewComment } from '../src/core/types';
import { applyWhiteboardComponentHighlights, locateWhiteboardComponent } from '../src/ui/whiteboard-comments';
import { xmlExtensions } from '../src/ui/xml-extensions';

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });
const target: AnchorTarget = { kind: 'whiteboard-component', board: 'token:board-one', id: 'shared-node', label: '同名节点' };
const anchor: Anchor = { from: 0, to: 1, quote: '【白板节点：同名节点】', state: 'attached', target };
function mount(xml = '<whiteboard token="board-one"/><whiteboard token="board-two"/>') {
  const element = document.createElement('div'); document.body.append(element);
  const editor = new Editor({ element, extensions: xmlExtensions(), content: parseDocxXML(xml).content }); editors.push(editor);
  return editor;
}
function preview(editor: Editor, position: number, board: string, ids: string[]) {
  const container = document.createElement('div'); container.setAttribute('data-review-board', board);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); container.append(svg);
  const components = ids.map(id => {
    const component = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    component.setAttribute('data-review-component-id', id);
    component.textContent = '同名节点'; svg.append(component); return component;
  });
  (editor.view.nodeDOM(position) as Element).append(container);
  return { container, svg, components };
}
function comment(id: string, commentAnchor: Anchor = anchor): ReviewComment {
  return { id, author: '我', body: '说明此节点', createdAt: '2026-09-12T00:00:00Z', status: 'open', replies: [], anchor: commentAnchor };
}

describe('whiteboard comment DOM identity', () => {
  it('locates identical component ids only inside their original PM atom and exact board identity', () => {
    const editor = mount();
    const first = preview(editor, 0, 'token:board-one', ['shared-node']);
    const second = preview(editor, 1, 'token:board-two', ['shared-node']);
    expect(locateWhiteboardComponent(editor, anchor)).toEqual({ element: first.components[0] });
    const secondAnchor = captureWhiteboardComponentAnchor(editor.state.doc, 1, { ...target, board: 'token:board-two' })!;
    expect(locateWhiteboardComponent(editor, secondAnchor)).toEqual({ element: second.components[0] });
    const wrongPosition = { ...anchor, from: 1, to: 2 };
    expect(locateWhiteboardComponent(editor, wrongPosition)).toMatchObject({ element: null, reason: expect.stringContaining('来源已变化') });
  });

  it('never searches a neighboring board even when its identity and node id would both match', () => {
    const editor = mount();
    preview(editor, 1, target.board, [target.id]);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('尚未就绪') });
  });

  it('reports missing or ambiguous component ids without falling back to an identical label', () => {
    const editor = mount();
    const { container } = preview(editor, 0, target.board, ['different-node']);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('找不到') });
    container.remove(); preview(editor, 0, target.board, [target.id, target.id]);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('重复的节点') });
  });

  it('rejects duplicate matching board containers and components owned by a nested different board', () => {
    const editor = mount();
    const first = preview(editor, 0, target.board, []);
    const duplicate = preview(editor, 0, target.board, [target.id]);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('重复身份') });
    duplicate.container.setAttribute('data-review-board', 'token:nested-other-board');
    first.container.append(duplicate.container);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('找不到') });
  });

  it('compares ids as opaque attribute values rather than interpolating them into selectors', () => {
    const editor = mount(); const id = 'node"]:special';
    const { components } = preview(editor, 0, target.board, [id]);
    expect(locateWhiteboardComponent(editor, { ...anchor, target: { ...target, id } }).element).toBe(components[0]);
  });

  it('does not locate deleted, externally invalidated, malformed or non-whiteboard targets', () => {
    const editor = mount('<p>同名节点</p><latex>x^2</latex><whiteboard token="board-one"/>');
    for (const invalid of [
      { ...anchor, state: 'deleted' as const }, { ...anchor, state: 'unverified' as const },
      { ...anchor, from: -1, to: 0 }, { ...anchor, from: 0, to: 10 }, { ...anchor, from: 999, to: 1000 },
      anchor, { ...anchor, target: undefined }, { ...anchor, target: { ...target, id: '' } },
    ]) expect(locateWhiteboardComponent(editor, invalid)).toMatchObject({ element: null, reason: expect.any(String) });
    expect(locateWhiteboardComponent(editor, { ...anchor, from: 6, to: 7 })).toMatchObject({ element: null, reason: expect.stringContaining('不再是白板') });
  });

  it('requires an SVG component and cannot match an HTML imitation', () => {
    const editor = mount(); const { container } = preview(editor, 0, target.board, []);
    const imitation = document.createElement('button'); imitation.setAttribute('data-review-component-id', target.id); container.append(imitation);
    expect(locateWhiteboardComponent(editor, anchor)).toMatchObject({ element: null, reason: expect.stringContaining('格式不正确') });
  });

  it('clears stale highlights and highlights only attached open component comments, without changing the document', () => {
    const editor = mount();
    const first = preview(editor, 0, target.board, [target.id, 'resolved-node', 'stale-node']);
    const second = preview(editor, 1, 'token:board-two', [target.id]);
    first.components[2].classList.add('lr-whiteboard-component-commented');
    first.components[0].classList.add('lr-whiteboard-component-selected');
    const outside = document.createElement('div'); outside.className = 'lr-whiteboard-component-commented'; document.body.append(outside);
    const beforeDoc = editor.state.doc; const beforeSelection = editor.state.selection;
    const resolved = { ...comment('resolved', { ...anchor, target: { ...target, id: 'resolved-node' } }), status: 'resolved' as const };
    const comments = [comment('active'), resolved, comment('deleted', { ...anchor, from: 1, to: 2, state: 'deleted', target: { ...target, board: 'token:board-two' } }),
      comment('unverified', { ...anchor, state: 'unverified' }), comment('whole-board', { ...anchor, target: undefined })];
    applyWhiteboardComponentHighlights(editor, comments);
    expect(first.components.map(element => element.classList.contains('lr-whiteboard-component-commented'))).toEqual([true, false, false]);
    expect(second.components[0].classList.contains('lr-whiteboard-component-commented')).toBe(false);
    expect(first.components[0].classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(outside.classList.contains('lr-whiteboard-component-commented')).toBe(true);
    expect(editor.state.doc).toBe(beforeDoc); expect(editor.state.selection).toBe(beforeSelection);
    applyWhiteboardComponentHighlights(editor, []);
    expect(first.components[0].classList.contains('lr-whiteboard-component-commented')).toBe(false);
  });
});
