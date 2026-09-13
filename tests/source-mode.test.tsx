// @vitest-environment jsdom
import React from 'react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/ui/App';
import { createReview, type Review, type Session, type Snapshot } from '../src/core/types';
import type { ReviewProject } from '../src/core/projects';

// Real App, Reader, parser and source editor; replace only the local HTTP boundary.
const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('../src/ui/Reader', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/Reader')>();
  return { ...actual, Reader: (props: React.ComponentProps<typeof actual.Reader>) =>
    <actual.Reader {...props} onReady={editor => { captured.editor = editor; props.onReady(editor); }}/> };
});

const handle = { id: 'source-a', name: 'article.xml', path: '/source/article.xml', reviewPath: '/source/article.review.json' };
const original = '<p>原文内容</p>';
const invalid = '<p>尚未闭合的源码';
const cloud = { documentId: 'cloud-a', url: 'https://example.feishu.cn/docx/cloud-a', localPath: handle.path };
const project: ReviewProject = { id: 'project-a', name: '源码测试项目', localPath: handle.path, cloud, defaultDirection: 'push', createdAt: '2026-09-13T00:00:00Z' };
const other: ReviewProject = { id: 'project-b', name: '另一个项目', localPath: '/source/other.xml', defaultDirection: 'pull', createdAt: project.createdAt };
const response = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Write = { xml: string; review: Review; revision: string };
type Request = { url: string; method: string; body?: Write };
let disk: Snapshot;
let session: Session;
let requests: Request[];
let route: (url: string, options: RequestInit) => Promise<Response> | undefined;
const writes = () => requests.filter(request => request.method === 'PUT');
const reads = () => requests.filter(request => request.url.startsWith('/api/document') && request.method === 'GET');
const geometry = ['getClientRects', 'getBoundingClientRect'].map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name) }));

beforeEach(() => {
  localStorage.clear(); captured.editor = null; requests = []; route = () => undefined;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  const review = createReview(handle.name, original);
  review.comments.push({ id: 'comment-a', author: '我', body: '保留这条意见', createdAt: project.createdAt, status: 'open',
    anchor: { from: 1, to: 3, quote: '原文', state: 'attached' },
    replies: [{ id: 'reply-a', author: '我', body: '原有回复', createdAt: project.createdAt }] });
  review.result = { author: 'AI', summary: '原有处理记录', appliedAt: project.createdAt };
  disk = { xml: original, review, revision: 'r0' };
  session = { csrf: 'source-csrf', document: handle, nativePicker: true, cloud };
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
    requests.push({ url, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(String(options.body)) as Write } : {}) });
    const routed = route(url, options); if (routed) return routed;
    if (url === '/api/session') return response(session);
    if (url === '/api/projects') return response({ projects: [project, other], activeProjectId: project.id, cloudAvailable: true });
    if (url === '/api/project-settings') return response({ shared: false, path: '/source/projects.json', defaultSharedPath: '/test/.lark-review/projects.json' });
    if (url.startsWith('/api/document')) {
      if (options.method === 'PUT') {
        const value = JSON.parse(String(options.body)) as Write;
        expect(value.revision).toBe(disk.revision);
        disk = { xml: value.xml, review: value.review, revision: disk.revision + '+' };
      }
      return response(disk);
    }
    if (url === '/api/pick') return response(null);
    throw new Error('Unexpected source-mode request: ' + url);
  }));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const { name, descriptor } of geometry) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor); else Reflect.deleteProperty(Range.prototype, name);
  }
});
async function open() {
  render(<App/>); await waitFor(() => expect(captured.editor?.view.dom.isConnected).toBe(true));
  if (session.project) await screen.findByRole('combobox', { name: '当前项目' });
}
function mode(name: '编辑' | '只读' | '源码') { return screen.getByRole('button', { name }); }
function source() { return screen.getByLabelText('文档源码') as HTMLTextAreaElement; }
function enterSource() { fireEvent.click(mode('源码')); expect(mode('源码').getAttribute('aria-pressed')).toBe('true'); }
function typeSource(value: string) { fireEvent.change(source(), { target: { value } }); }
function unloadBlocked() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
async function settleAutosave() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); }); }
function openFileMenu() {
  fireEvent.click(screen.getByRole('button', { name: '切换文档' }));
}

describe('whole-document source mode through the real editor', () => {
  it('switches among all three modes without writing or invalidating existing comments', async () => {
    const initial = structuredClone(disk); await open();
    enterSource(); expect(source().value).toBe(original);
    fireEvent.click(mode('只读')); fireEvent.click(mode('编辑')); enterSource();
    await settleAutosave();
    expect(writes()).toHaveLength(0); expect(disk).toEqual(initial); expect(unloadBlocked()).toBe(false);
  });

  it('autosaves exact source bytes, preserves unknown XML and review data, and invalidates old comment positions', async () => {
    const initialXML = '\ufeff<!-- 顶层注释 -->\n<p id="paragraph-a">原文内容<!-- 行内注释 --></p>\n<future mode="opaque"><![CDATA[a < b && c > d]]></future>\n';
    disk.xml = initialXML; disk.review!.document.xml = initialXML; disk.review!.document.baselineXML = initialXML;
    const initial = structuredClone(disk.review!); await open(); enterSource();
    const xml = initialXML.replace('原文内容', '新正文');
    typeSource(xml); await waitFor(() => expect(writes()).toHaveLength(1));
    expect(disk.xml).toBe(xml); expect(writes()[0].body?.xml).toBe(xml);
    expect(disk.review!.document.baselineXML).toBe(initialXML); expect(disk.review!.document.xml).toBe(xml);
    expect(disk.review!.comments).toEqual(initial.comments.map(comment => ({ ...comment, anchor: { ...comment.anchor, state: 'unverified' } })));
    expect(disk.review!.result).toEqual(initial.result);
    fireEvent.click(mode('只读')); expect(captured.editor!.state.doc.textContent).toContain('新正文');
    expect((screen.getByRole('button', { name: '原文' }) as HTMLButtonElement).disabled).toBe(true);
    enterSource(); expect(source().value).toBe(xml); await settleAutosave(); expect(writes()).toHaveLength(1);
  });

  it('preserves the existing CRLF file style when textarea normalizes a one-place source edit to LF', async () => {
    const initialXML = '<p>原文内容</p>\r\n<p>结尾</p>\r\n';
    disk = { xml: initialXML, revision: 'r0', review: createReview(handle.name, initialXML) };
    await open(); enterSource(); expect(source().value).toBe(initialXML.replace(/\r\n/g, '\n'));
    typeSource(source().value.replace('原文内容', '新正文'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(disk.xml).toBe(initialXML.replace('原文内容', '新正文'));
    expect(disk.review!.document.baselineXML).toBe(initialXML);
  });

  it('opens an existing comment quotation in the read-only article from unchanged source mode', async () => {
    await open(); enterSource(); fireEvent.click(screen.getByRole('button', { name: '原文' }));
    expect(mode('只读').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('文章正文').closest('section')?.hidden).toBe(false);
    expect(captured.editor!.isEditable).toBe(false);
    expect(captured.editor!.state.selection.from).toBe(1); expect(captured.editor!.state.selection.to).toBe(3);
    expect(writes()).toHaveLength(0); expect(disk.review!.comments[0].anchor.state).toBe('attached');
  });

  it('retains invalid source through read-only preview and blocks visual editing and unload', async () => {
    await open(); enterSource(); typeSource(invalid);
    expect(source().getAttribute('aria-invalid')).toBe('true'); expect(unloadBlocked()).toBe(true);
    fireEvent.click(mode('只读')); expect(captured.editor!.state.doc.textContent).toBe('原文内容');
    expect(screen.getByText(/只读预览显示最近有效内容/)).toBeDefined(); expect(captured.editor!.isEditable).toBe(false);
    fireEvent.click(mode('编辑')); expect(mode('只读').getAttribute('aria-pressed')).toBe('true');
    enterSource(); expect(source().value).toBe(invalid); expect(unloadBlocked()).toBe(true);
    await settleAutosave(); expect(writes()).toHaveLength(0); expect(disk.xml).toBe(original);
  });

  it('resumes autosave and permits opening after invalid source is corrected', async () => {
    await open(); enterSource(); typeSource(invalid); typeSource('<p>已修复</p>');
    await waitFor(() => expect(disk.xml).toBe('<p>已修复</p>'));
    expect(source().getAttribute('aria-invalid')).toBe('false'); expect(screen.queryByText('源码未保存')).toBeNull();
    expect(unloadBlocked()).toBe(false); fireEvent.click(mode('编辑')); expect(captured.editor!.isEditable).toBe(true);
    openFileMenu(); await waitFor(() => expect(requests.filter(request => request.url === '/api/pick')).toHaveLength(1));
  });

  it('restores the last valid source without a write and releases resource navigation', async () => {
    await open(); enterSource(); typeSource(invalid); fireEvent.click(mode('只读'));
    fireEvent.click(screen.getByRole('button', { name: '还原源码' })); enterSource();
    expect(source().value).toBe(original); expect(unloadBlocked()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(screen.getByRole('button', { name: /article.review.json/ }));
    expect(screen.getByRole('region', { name: '资源预览' })).toBeDefined();
    await settleAutosave(); expect(writes()).toHaveLength(0); expect(disk.xml).toBe(original);
  });

  it('keeps an invalid draft and its error when an earlier valid PUT finishes', async () => {
    const saving = deferred<Response>();
    route = (_url, options) => options.method === 'PUT' ? saving.promise : undefined;
    await open(); enterSource(); typeSource('<p>已提交的合法版本</p>');
    await waitFor(() => expect(writes()).toHaveLength(1)); typeSource(invalid);
    const sent = writes()[0].body!; disk = { xml: sent.xml, review: sent.review, revision: 'r1' };
    await act(async () => { saving.resolve(await response(disk)); });
    expect(source().value).toBe(invalid); expect(source().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('源码未保存')).toBeDefined(); expect(screen.getByRole('alert').textContent).toContain('DocxXML');
    await settleAutosave(); expect(writes()).toHaveLength(1); expect(disk.xml).toBe('<p>已提交的合法版本</p>');
  });

  it('ignores an idle poll started before invalid source input', async () => {
    const polling = deferred<Response>(); await open();
    route = (url, options) => url.startsWith('/api/document') && options.method === 'GET' ? polling.promise : undefined;
    await act(async () => { vi.advanceTimersByTime(1800); }); expect(reads()).toHaveLength(2);
    enterSource(); typeSource(invalid);
    await act(async () => { polling.resolve(await response({ xml: '<p>外部新版本</p>', review: createReview(handle.name, '<p>外部新版本</p>'), revision: 'r2' })); });
    expect(source().value).toBe(invalid); fireEvent.click(mode('只读'));
    expect(captured.editor!.state.doc.textContent).toBe('原文内容'); expect(screen.queryByText('已同步本地文件中的更新。')).toBeNull();
    enterSource(); expect(source().value).toBe(invalid); expect(writes()).toHaveLength(0);
  });

  it('blocks subsequent disk polling while invalid source is hidden in read mode', async () => {
    await open(); enterSource(); typeSource(invalid); fireEvent.click(mode('只读'));
    disk = { xml: '<p>外部新版本</p>', revision: 'r2', review: createReview(handle.name, '<p>外部新版本</p>') };
    await act(async () => { vi.advanceTimersByTime(5400); }); expect(reads()).toHaveLength(1);
    enterSource(); expect(source().value).toBe(invalid); expect(unloadBlocked()).toBe(true); expect(writes()).toHaveLength(0);
  });

  it('blocks document opening, resource selection and cloud comments while preserving invalid source', async () => {
    await open(); enterSource(); typeSource(invalid); openFileMenu();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(screen.getByRole('button', { name: /article.review.json/ }));
    fireEvent.click(screen.getByRole('button', { name: '同步飞书评论' }));
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '资源预览' })).toBeNull(); expect(source().value).toBe(invalid);
    expect(screen.getAllByText(/源码尚未通过校验/).length).toBeGreaterThan(0);
  });

  it('blocks project switching and body sync preview before any request when source is invalid', async () => {
    session = { ...session, project }; await open(); enterSource(); typeSource(invalid);
    fireEvent.click(screen.getByRole('combobox', { name: '当前项目' }));
    fireEvent.click(await screen.findByRole('option', { name: other.name }));
    fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    expect(requests.filter(request => request.method !== 'GET')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: '当前项目' }).textContent).toContain(project.name);
    expect(source().value).toBe(invalid); expect(screen.getAllByText(/源码尚未通过校验/).length).toBeGreaterThan(0);
  });

  it.each([
    { name: 'formula', xml: '<latex>x^2</latex>', label: '公式表达式', value: 'x^3' },
    { name: 'whiteboard', xml: '<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text id="label">原图</text></svg></whiteboard>', label: 'SVG 图源', value: '<svg xmlns="http://www.w3.org/2000/svg"><text>未应用</text></svg>' },
  ])('keeps the unapplied $name draft and refuses entering whole-document source mode', async kind => {
    disk = { xml: kind.xml, revision: 'r0', review: createReview(handle.name, kind.xml) }; await open();
    act(() => { captured.editor!.commands.setNodeSelection(0); });
    fireEvent.change(await screen.findByLabelText(kind.label), { target: { value: kind.value } });
    fireEvent.click(mode('源码')); expect(mode('编辑').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(kind.label) as HTMLTextAreaElement).value).toBe(kind.value);
    expect(screen.getByText(/应用或还原公式、白板修改，再编辑源码/)).toBeDefined();
    expect(writes()).toHaveLength(0); expect(unloadBlocked()).toBe(true);
  });
});
