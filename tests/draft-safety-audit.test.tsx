// @vitest-environment jsdom
// Audit reproductions: real App + Reader + ProseMirror, mocked local file API.
// These are desired-safety assertions, not a browser/visual acceptance test.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undoNoScroll } from '@tiptap/pm/history';
import { App } from '../src/ui/App';
import { createReview } from '../src/core/types';

const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('../src/ui/Reader', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/Reader')>();
  return { ...actual, Reader: (props: React.ComponentProps<typeof actual.Reader>) =>
    <actual.Reader {...props} onReady={editor => { captured.editor = editor; props.onReady(editor); }}/>,
  };
});
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>预览</text></svg>',
})) } }));

const kinds = [
  { name: 'formula', label: '公式表达式', xml: '<latex>x^2</latex>', draft: 'x^3' },
  { name: 'whiteboard', label: 'Mermaid 图源', xml: '<whiteboard type="mermaid"><![CDATA[flowchart LR\nA[原稿] --> B[评论]]]></whiteboard>', draft: 'flowchart LR\nA[未应用图源] --> B[评论]' },
];
const handle = { id: 'draft-audit', name: 'audit.xml', path: '/tmp/audit.xml', reviewPath: '/tmp/audit.review.json' };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
let disk: { xml: string; revision: string; review: ReturnType<typeof createReview> };
let reads: number;
beforeEach(() => { captured.editor = null; reads = 0; vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open(xml: string) {
  disk = { xml, revision: 'r1', review: createReview('audit.xml', xml) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/session') return response({ csrf: 'audit', document: handle, nativePicker: false });
    if (url.startsWith('/api/document')) {
      if (init.method === 'PUT') {
        const write = JSON.parse(String(init.body));
        disk = { xml: write.xml, review: write.review, revision: 'saved' };
      } else reads++;
      return response(disk);
    }
    throw new Error('Unexpected audit request: ' + url);
  }));
  render(<App/>);
  await waitFor(() => expect(captured.editor?.view.dom.isConnected).toBe(true));
  act(() => { captured.editor!.commands.setNodeSelection(0); });
  const first = captured.editor!.state.doc.firstChild!;
  if (first.type.name === 'xmlBlockLatex') await screen.findByLabelText('公式表达式');
  if (first.attrs.lrTag === 'whiteboard') await screen.findByLabelText('Mermaid 图源');
}

describe('unapplied source draft safety audit (integration only)', () => {
  it.each(kinds)('$name reopens the source panel when the same selected node is clicked after closing it', async kind => {
    await open(kind.xml + '<p>后文</p>');
    act(() => { captured.editor!.commands.setTextSelection(2); captured.editor!.commands.setNodeSelection(0); });
    const panel = screen.getByRole('complementary', { name: '评论与内容编辑' });
    expect(panel.classList.contains('review-open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭评论面板' }));
    expect(panel.classList.contains('review-open')).toBe(false);
    const selection = captured.editor!.state.selection;
    const node = captured.editor!.view.nodeDOM(0) as HTMLElement;
    fireEvent.click(node);
    expect(captured.editor!.state.selection.eq(selection)).toBe(true);
    expect(panel.classList.contains('review-open')).toBe(true);
  });

  it.each(kinds)('$name retains an unapplied draft after selecting neighboring text and returning', async kind => {
    await open(kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    act(() => { captured.editor!.commands.setTextSelection(2); });
    expect(screen.queryByLabelText(kind.label)).toBeNull();
    act(() => { captured.editor!.commands.setNodeSelection(0); });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.draft);
  });

  it.each(kinds)('$name still protects navigation/unload after switching to read mode', async kind => {
    await open(kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    const beforeMode = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeMode);
    expect(beforeMode.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '只读' }));
    expect(screen.queryByLabelText(kind.label)).toBeNull();
    const afterMode = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterMode);
    expect(afterMode.defaultPrevented).toBe(true);
  });

  it.each(kinds)('$name treats clearing the source as an unapplied change', async kind => {
    await open(kind.xml + '<p>后文</p>');
    const input = screen.getByLabelText(kind.label);
    fireEvent.change(input, { target: { value: '' } });
    expect(input.hasAttribute('data-review-draft')).toBe(true);
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
  });

  it.each(kinds)('$name blocks external reload while its draft is hidden in read mode', async kind => {
    await open(kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    fireEvent.click(screen.getByRole('button', { name: '只读' }));
    const nextXML = kind.xml + '<p>AI 外部修改了后文</p>';
    disk = { xml: nextXML, revision: 'r2', review: createReview('audit.xml', nextXML) };
    await act(async () => { vi.advanceTimersByTime(1800); });
    expect.soft(reads).toBe(1);
    expect.soft(screen.queryByText('已同步本地文件中的更新。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    act(() => { captured.editor!.commands.setNodeSelection(0); });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.draft);
  });

  it('formula keeps its draft when an unrelated edit shifts the selected formula position', async () => {
    await open('<p>前文</p><latex>x^2</latex>');
    act(() => { captured.editor!.commands.setNodeSelection(4); });
    fireEvent.change(screen.getByLabelText('公式表达式'), { target: { value: 'x^3' } });
    act(() => { captured.editor!.view.dispatch(captured.editor!.state.tr.insertText('新', 1)); });
    expect((screen.getByLabelText('公式表达式') as HTMLTextAreaElement).value).toBe('x^3');
  });

  it.each(kinds)('$name isolates drafts belonging to two otherwise identical source nodes', async kind => {
    await open(kind.xml + kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    act(() => { captured.editor!.commands.setNodeSelection(1); });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).not.toBe(kind.draft);
    const second = kind.name === 'formula' ? 'x^4' : 'flowchart LR\nA[第二张图] --> B[评论]';
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: second } });
    act(() => { captured.editor!.commands.setNodeSelection(0); });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.draft);
    fireEvent.click(screen.getByRole('button', { name: '还原' }));
    act(() => { captured.editor!.commands.setNodeSelection(1); });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(second);
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
  });

  it.each(kinds)('$name preserves a deleted node draft without applying it to the next node, and restores it on undo', async kind => {
    await open(kind.xml + kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    act(() => { captured.editor!.view.dispatch(captured.editor!.state.tr.delete(0, 1)); });
    act(() => { captured.editor!.commands.setNodeSelection(0); });
    const kindLabel = kind.name === 'formula' ? '公式' : '白板';
    expect((screen.getByLabelText(kindLabel + '保留的草稿') as HTMLTextAreaElement).value).toBe(kind.draft);
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).not.toBe(kind.draft);
    expect(screen.getByRole('button', { name: '应用' + kindLabel }).hasAttribute('disabled')).toBe(true);
    act(() => {
      expect(undoNoScroll(captured.editor!.state, transaction => captured.editor!.view.dispatch(transaction))).toBe(true);
      captured.editor!.commands.setNodeSelection(0);
    });
    expect(screen.queryByLabelText(kindLabel + '保留的草稿')).toBeNull();
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.draft);
  });

  it.each(kinds)('$name pauses applying a draft when its original source changes', async kind => {
    await open(kind.xml + '<p>后文</p>');
    fireEvent.change(screen.getByLabelText(kind.label), { target: { value: kind.draft } });
    act(() => {
      captured.editor!.view.dispatch(captured.editor!.state.tr.setNodeAttribute(0,
        kind.name === 'formula' ? 'expression' : 'rawXML', kind.name === 'formula' ? 'y^2' : kind.xml.replace('原稿', '新原稿')));
    });
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.draft);
    expect(screen.getByRole('button', { name: kind.name === 'formula' ? '应用公式' : '应用白板' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/已改变，草稿已保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '还原' }));
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toContain(kind.name === 'formula' ? 'y^2' : '新原稿');
  });
});
