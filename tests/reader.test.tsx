// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { Reader } from '../src/ui/Reader';
import { createReview, type Anchor, type ReviewComment, type ResourceManifest } from '../src/core/types';

afterEach(cleanup);

async function mountReader(xml: string, comments: ReviewComment[] = [], draft: Anchor | null = null) {
  let editor: Editor | null = null;
  let review = { ...createReview('article.xml', xml), comments };
  let pending = draft;
  const edits: string[] = [];
  const errors: string[] = [];
  const props = {
    xml, readOnly: false, assetURL: (path: string) => path,
    comments, getReview: () => review, getDraft: () => pending,
    onEdit: (nextXML: string, nextComments: ReviewComment[], nextDraft: Anchor | null) => {
      edits.push(nextXML);
      review = { ...review, comments: nextComments, document: { ...review.document, xml: nextXML } };
      pending = nextDraft;
    },
    onSelection: () => {}, onReady: (value: Editor) => { editor = value; },
    onError: (message: string) => { errors.push(message); },
  };
  const rendered = render(<Reader {...props}/>);
  await waitFor(() => { expect(editor).not.toBeNull(); });
  return {
    get editor() { return editor!; }, get review() { return review; }, get draft() { return pending; }, edits, errors,
    load(nextXML: string, nextComments = review.comments) {
      review = { ...review, comments: nextComments, document: { ...review.document, xml: nextXML } };
      rendered.rerender(<Reader {...props} xml={nextXML} comments={nextComments}/>);
    },
    resources(next: ResourceManifest | undefined) {
      review = {...review,resources:next};
      rendered.rerender(<Reader {...props} xml={review.document.xml} comments={review.comments}/>);
    },
  };
}

describe('Reader with the real Tiptap editor', () => {
  it('starts fresh history on external XML, emits no save, and can undo subsequent edits', async () => {
    const reader = await mountReader('<p>original</p>');
    act(() => { reader.editor.chain().insertContentAt(1, 'local ').run(); });
    expect(reader.editor.getText()).toBe('local original');
    expect(reader.editor.can().undo()).toBe(true);
    const savedEdits = reader.edits.length;

    reader.load('<p>external revision</p>');
    expect(reader.editor.getText()).toBe('external revision');
    expect(reader.edits).toHaveLength(savedEdits);
    expect(reader.editor.can().undo()).toBe(false);
    act(() => { expect(reader.editor.commands.undo()).toBe(false); });
    expect(reader.editor.getText()).toBe('external revision');
    expect(reader.edits).toHaveLength(savedEdits);

    act(() => { reader.editor.chain().insertContentAt(1, 'new ').run(); });
    expect(reader.editor.getText()).toBe('new external revision');
    act(() => { expect(reader.editor.commands.undo()).toBe(true); });
    expect(reader.editor.getText()).toBe('external revision');
    expect(reader.edits.at(-1)).toContain('external revision');
    expect(reader.errors).toEqual([]);
  });

  it('retains local undo history when only comment data is refreshed', async () => {
    const reader = await mountReader('<p>original</p>');
    act(() => { reader.editor.commands.insertContentAt(1, 'local '); });
    reader.load(reader.review.document.xml, []);
    expect(reader.editor.can().undo()).toBe(true);
    act(() => { reader.editor.commands.undo(); });
    expect(reader.editor.getText()).toBe('original');
    expect(reader.errors).toEqual([]);
  });

  it('shows newly cached sidecar resources without saving XML or resetting selection and undo', async () => {
    const reader = await mountReader('<img src="image-token"/><p>original</p>');
    expect(document.querySelector('.protected-block img')).toBeNull();
    act(() => { reader.editor.commands.insertContentAt(2,'local '); });
    const doc = reader.editor.state.doc;
    const selection = reader.editor.state.selection;
    const saves = reader.edits.length;
    reader.resources({version:1,items:[{tag:'img',attribute:'src',value:'image-token',path:'resources/image.png',representation:'original'}]});
    await waitFor(() => expect(document.querySelector('.protected-block img')?.getAttribute('src')).toBe('resources/image.png'));
    expect(reader.editor.state.doc).toBe(doc);
    expect(reader.editor.state.selection).toBe(selection);
    expect(reader.edits).toHaveLength(saves);
    act(() => { reader.editor.commands.undo(); });
    expect(reader.edits.at(-1)).toBe('<img src="image-token"/><p>original</p>');
    reader.resources(undefined);
    expect(document.querySelector('.protected-block img')).toBeNull();
    expect(reader.errors).toEqual([]);
  });

  it('maps comments and draft selections through real paste rule appended transactions', async () => {
    const anchor: Anchor = { from: 1, to: 3, quote: '目标', state: 'attached' };
    const comment: ReviewComment = {
      id: 'comment', author: '我', body: '补充依据', createdAt: '2026-09-12T00:00:00.000Z',
      status: 'open', anchor, replies: [],
    };
    const reader = await mountReader('<p>目标评论正文足够长以免越界</p>', [comment], anchor);
    act(() => {
      reader.editor.commands.setTextSelection(1);
      reader.editor.view.pasteText('**加粗** ', new window.Event('paste') as unknown as ClipboardEvent);
    });
    expect(reader.editor.getText()).toBe('加粗 目标评论正文足够长以免越界');
    expect(reader.review.comments[0].anchor).toEqual({ ...anchor, from: 4, to: 6 });
    expect(reader.draft).toEqual({ ...anchor, from: 4, to: 6 });
    const mapped = reader.review.comments[0].anchor;
    expect(reader.editor.state.doc.textBetween(mapped.from, mapped.to)).toBe('目标');
    expect(reader.errors).toEqual([]);
  });
});

it('highlights a block formula and edits its expression without detaching its comment', async () => {
  const anchor: Anchor={from:0,to:1,quote:'公式：x^2',state:'attached'};
  const comment: ReviewComment={id:'formula-comment',author:'我',body:'改为三次方',createdAt:'2026-09-12T00:00:00Z',status:'open',anchor,replies:[]};
  const reader=await mountReader('<latex>x^2</latex>',[comment]);
  expect(document.querySelector('.lr-latex-block.comment-highlight')).not.toBeNull();
  act(()=>{reader.editor.commands.setNodeSelection(0);});
  const {FormulaEditor}=await import('../src/ui/Reader');
  const {fireEvent,screen}=await import('@testing-library/react');
  const controls=render(<FormulaEditor editor={reader.editor} readOnly={false}/>);
  fireEvent.change(screen.getByLabelText('公式表达式'),{target:{value:'x^3'}});
  fireEvent.click(screen.getByText('应用公式'));
  expect(reader.edits.at(-1)).toBe('<latex>x^3</latex>');
  expect(reader.review.comments[0].anchor).toEqual(anchor);
  expect(document.querySelector('.lr-latex-block.comment-highlight')?.getAttribute('data-latex-source')).toBe('x^3');
  controls.rerender(<FormulaEditor editor={reader.editor} readOnly={true}/>);
  expect(screen.queryByLabelText('公式表达式')).toBeNull();
  act(()=>{reader.editor.commands.undo();});
  expect(reader.edits.at(-1)).toBe('<latex>x^2</latex>');
});
