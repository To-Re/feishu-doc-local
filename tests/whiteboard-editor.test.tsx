// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { redoNoScroll, undoNoScroll } from '@tiptap/pm/history';
import { createReview, type Anchor, type ReviewComment } from '../src/core/types';
import { readWhiteboardSource } from '../src/core/whiteboard-source';
import { Reader } from '../src/ui/Reader';
import { WhiteboardEditor } from '../src/ui/WhiteboardEditor';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
beforeEach(() => {
  mermaid.initialize.mockReset(); mermaid.render.mockReset();
  mermaid.render.mockImplementation(async (_id: string, source: string) => {
    if (source.includes('invalid syntax')) throw new Error('图语法错误');
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="100" height="40"/><text>预览</text></svg>' };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(xml: string, comments: ReviewComment[] = []) {
  let editor: Editor | undefined;
  let review = { ...createReview('whiteboard.xml', xml), comments };
  const edits: string[] = [], errors: string[] = [];
  render(<Reader xml={xml} readOnly={false} assetURL={path => path} comments={comments} getReview={() => review} getDraft={() => null}
    onReady={value => { editor = value; }} onSelection={() => {}} onError={message => { errors.push(message); }}
    onEdit={(nextXML, nextComments) => { edits.push(nextXML); review = { ...review, comments: nextComments, document: { ...review.document, xml: nextXML } }; }}/>);
  await waitFor(() => expect(editor).toBeDefined());
  const controls = render(<WhiteboardEditor editor={editor!} readOnly={false}/>);
  return { get editor() { return editor!; }, get review() { return review; }, edits, errors, controls };
}
const initialSource = 'flowchart LR\nA[原稿] --> B[评论]';
const boardXML = "<whiteboard type='mermaid' caption='评审图' data-keep='yes'><![CDATA[" + initialSource + ']]></whiteboard>';

describe('selected whiteboard source editor', () => {
  it('previews then applies source through the real Reader save path and retains comments, attrs, undo and redo', async () => {
    const anchor: Anchor = { from: 0, to: 1, quote: '【白板：评审图】', state: 'attached' };
    const comment: ReviewComment = { id: 'board-comment', author: '我', body: '补充改稿节点', createdAt: '2026-09-12T00:00:00Z', status: 'open', anchor, replies: [] };
    const reader = await open(boardXML + '<p>后文保留</p>', [comment]);
    act(() => { reader.editor.commands.setNodeSelection(0); });
    const input = screen.getByLabelText('Mermaid 图源');
    const sourceID = reader.editor.state.doc.firstChild!.attrs.lrSource;
    const next = initialSource + '\nB --> C[改稿😀]';
    fireEvent.change(input, { target: { value: next } });
    expect(input.hasAttribute('data-review-draft')).toBe(true);
    expect(reader.edits).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: '应用白板' }).hasAttribute('disabled')).toBe(false));
    expect(mermaid.render.mock.calls.some(call => call[1] === next)).toBe(true);
    expect(within(screen.getByLabelText('白板修改预览')).getByRole('img', { name: '白板本地预览' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '应用白板' }));
    const edited = boardXML.replace(initialSource, next) + '<p>后文保留</p>';
    expect(reader.edits).toEqual([edited]);
    expect(reader.review.document.xml).toBe(edited);
    expect(reader.review.comments[0].anchor).toEqual(anchor);
    expect(reader.editor.state.doc.firstChild!.attrs.lrSource).toBe(sourceID);
    expect(input.hasAttribute('data-review-draft')).toBe(false);
    act(() => { expect(undoNoScroll(reader.editor.state, transaction => reader.editor.view.dispatch(transaction))).toBe(true); });
    expect(reader.edits.at(-1)).toBe(boardXML + '<p>后文保留</p>');
    expect((input as HTMLTextAreaElement).value).toBe(initialSource);
    act(() => { expect(redoNoScroll(reader.editor.state, transaction => reader.editor.view.dispatch(transaction))).toBe(true); });
    expect(reader.edits.at(-1)).toBe(edited);
    expect(reader.review.comments[0].anchor).toEqual(anchor);
    expect(reader.errors).toEqual([]);
  });

  it('refuses invalid previews and unsaved source never changes XML', async () => {
    const reader = await open(boardXML);
    act(() => { reader.editor.commands.setNodeSelection(0); });
    const input = screen.getByLabelText('Mermaid 图源');
    fireEvent.change(input, { target: { value: 'invalid syntax' } });
    await waitFor(() => expect(screen.getByLabelText('白板修改预览').textContent).toContain('图语法错误'));
    expect(screen.getByRole('button', { name: '应用白板' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '应用白板' }));
    expect(reader.edits).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '还原' }));
    expect((input as HTMLTextAreaElement).value).toBe(initialSource);
    expect(reader.review.document.xml).toBe(boardXML);
    reader.controls.rerender(<WhiteboardEditor editor={reader.editor} readOnly/>);
    expect(screen.queryByLabelText('Mermaid 图源')).toBeNull();
  });

  it('keeps a source draft when neighboring text shifts its selected node', async () => {
    const reader = await open('<p>前文</p>' + boardXML);
    act(() => { reader.editor.commands.setNodeSelection(4); });
    const next = initialSource + '\nB --> C[调整]';
    fireEvent.change(screen.getByLabelText('Mermaid 图源'), { target: { value: next } });
    act(() => { reader.editor.view.dispatch(reader.editor.state.tr.insertText('新', 1)); });
    expect((screen.getByLabelText('Mermaid 图源') as HTMLTextAreaElement).value).toBe(next);
    expect(reader.editor.state.selection.from).toBe(5);
    await waitFor(() => expect(screen.getByRole('button', { name: '应用白板' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '应用白板' }));
    expect(reader.edits.at(-1)).toBe('<p>新前文</p>' + boardXML.replace(initialSource, next));
    expect(reader.errors).toEqual([]);
  });

  it('edits SVG source while the preview strips active content and the outer XML is retained', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red" width="40" height="20"/></svg>';
    const xml = '<whiteboard type="svg" width="400">' + svg + '</whiteboard>';
    const reader = await open(xml);
    act(() => { reader.editor.commands.setNodeSelection(0); });
    const next = svg.replace('fill="red"', 'fill="green" onload="alert(1)"');
    fireEvent.change(screen.getByLabelText('SVG 图源'), { target: { value: next } });
    await waitFor(() => expect(screen.getByRole('button', { name: '应用白板' }).hasAttribute('disabled')).toBe(false));
    const preview = screen.getByLabelText('白板修改预览');
    expect(preview.querySelector('rect')?.getAttribute('fill')).toBe('green');
    expect(preview.querySelector('rect')?.hasAttribute('onload')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '应用白板' }));
    expect(readWhiteboardSource(reader.edits.at(-1))?.source).toBe(next);
    expect(reader.edits.at(-1)?.startsWith('<whiteboard type="svg" width="400">')).toBe(true);
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('never offers a source editor for a cloud token or a board with unknown child structure', async () => {
    const reader = await open('<whiteboard token="existing-cloud-board"/>' + '<whiteboard type="mermaid"><unknown>flowchart LR</unknown></whiteboard>');
    for (const position of [0, 1]) {
      act(() => { reader.editor.commands.setNodeSelection(position); });
      expect(screen.queryByLabelText('Mermaid 图源')).toBeNull();
      expect(screen.queryByLabelText('SVG 图源')).toBeNull();
    }
    expect(reader.edits).toEqual([]);
  });
});
