// @vitest-environment jsdom
import React from 'react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createReview, type Session, type Snapshot } from '../src/core/types';
import { App } from '../src/ui/App';

// Retain the real Reader, node views and App callbacks. Capturing its editor
// lets the race tests dispatch a late transaction that normal disabled UI forbids.
const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('../src/ui/Reader', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/Reader')>();
  return { ...actual, Reader: (props: React.ComponentProps<typeof actual.Reader>) =>
    <actual.Reader {...props} onReady={editor => { captured.editor = editor; props.onReady(editor); }}/> };
});

const handle = { id: 'doc', name: 'article.xml', path: '/project/article.xml', reviewPath: '/project/article.review.json' };
const xml = '<p>原文内容</p><latex>x^2</latex>';
const target = { url: 'https://example.feishu.cn/docx/test-document', documentId: 'test-document', localPath: handle.path };
const report = { imported: 1, created: 2, replies: 3, resolved: 1, issues: [], syncedAt: '2026-09-12T08:00:00Z' };
const response = (value: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => value } as Response);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let disk: Snapshot;
let cloud: Session['cloud'];
let routes: (url: string, options: RequestInit) => Promise<Response> | undefined;
let requests: Array<{ url: string; options: RequestInit }>;
const cloudRequests = () => requests.filter(request => request.url.startsWith('/api/cloud-sync'));
const writes = () => requests.filter(request => request.options.method === 'PUT');

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  captured.editor = null; cloud = target; routes = () => undefined; requests = [];
  const review = createReview(handle.name, xml);
  review.comments.push({ id: 'local-one', author: '我', body: '本地意见', createdAt: '2026-09-12T07:00:00Z',
    status: 'open', replies: [], anchor: { from: 1, to: 3, quote: '原文', state: 'attached' } });
  disk = { xml, review, revision: 'r0' };
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
    requests.push({ url, options });
    const routed = routes(url, options); if (routed) return routed;
    if (url === '/api/session') return response({ csrf: 'test-csrf', document: handle, nativePicker: true, ...(cloud ? { cloud } : {}) });
    if (url.startsWith('/api/document')) {
      if (options.method === 'PUT') {
        const value = JSON.parse(String(options.body));
        expect(value.revision).toBe(disk.revision);
        disk = { xml: value.xml, review: value.review, revision: 'r' + (Number(disk.revision.slice(1)) + 1) };
      }
      return response(disk);
    }
    if (url.startsWith('/api/cloud-sync')) return response({ snapshot: disk, report });
    throw new Error('unexpected request ' + url);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function open() {
  const mounted = render(<App/>);
  await waitFor(() => expect(captured.editor).not.toBeNull());
  return { mounted, editor: captured.editor! };
}
function syncButton() { return screen.getByRole('button', { name: '同步飞书评论' }) as HTMLButtonElement; }

describe('explicit cloud comment sync through App and the real Reader', () => {
  it('renders imported opaque account ids as Feishu users while retaining source identities and local author labels', async () => {
    const original = disk.review!.comments[0];
    original.author = 'ou_local_author';
    original.replies.push({ id: 'cloud-reply:reply-one', author: 'on_abcdef123456', body: '云端回复', createdAt: report.syncedAt });
    disk.review!.comments.push({ ...original, id: 'cloud:test-document:comment-one', author: 'ou_123456abcdef', body: '云端意见', replies: [
      { id: 'cloud-reply:reply-two', author: 'cli_123456abcdef', body: '应用回复', createdAt: report.syncedAt },
      { id: 'local-reply', author: 'on_local_author', body: '本地署名', createdAt: report.syncedAt },
    ] });
    const before = JSON.stringify(disk.review);
    await open();
    expect(screen.getAllByText('飞书用户')).toHaveLength(3);
    expect(screen.getByTitle('ou_123456abcdef').textContent).toBe('飞书用户');
    expect(screen.getByTitle('on_abcdef123456').textContent).toBe('飞书用户');
    expect(screen.getByTitle('cli_123456abcdef').textContent).toBe('飞书用户');
    expect(screen.getByText('ou_local_author')).toBeDefined();
    expect(screen.getByText('on_local_author')).toBeDefined();
    expect(JSON.stringify(disk.review)).toBe(before);
    expect(writes()).toHaveLength(0); expect(cloudRequests()).toHaveLength(0);
  });

  it.each(['unconfigured', 'different file'])('keeps %s documents purely local', async kind => {
    cloud = kind === 'unconfigured' ? undefined : { ...target, localPath: '/project/other.xml' };
    await open();
    expect(screen.queryByRole('region', { name: '飞书评论同步' })).toBeNull();
    expect(screen.queryByRole('link', { name: '打开飞书文档' })).toBeNull();
    expect(cloudRequests()).toHaveLength(0);
  });

  it('saves the latest local review before sync, locks input, and accepts only the returned review', async () => {
    const saving = deferred<Response>(), syncing = deferred<Response>();
    routes = (url, options) => options.method === 'PUT' ? saving.promise : url.startsWith('/api/cloud-sync') ? syncing.promise : undefined;
    const { editor } = await open();
    expect(cloudRequests()).toHaveLength(0);
    expect(screen.getByRole('link', { name: '打开飞书文档' }).getAttribute('href')).toBe(target.url);
    fireEvent.click(screen.getByRole('button', { name: '解决' }));
    fireEvent.click(syncButton());
    expect(writes()).toHaveLength(1); expect(cloudRequests()).toHaveLength(0);
    expect(editor.isEditable).toBe(false);
    expect((screen.getByRole('button', { name: '切换文档' }) as HTMLButtonElement).disabled).toBe(true);
    const latest = JSON.parse(String(writes()[0].options.body));
    expect(latest.review.comments[0].status).toBe('resolved'); expect(latest.xml).toBe(xml);
    disk = { xml: latest.xml, review: latest.review, revision: 'r1' };
    await act(async () => { saving.resolve(await response(disk)); });
    expect(cloudRequests()).toHaveLength(1);
    expect(cloudRequests()[0].url).toBe('/api/cloud-sync?id=doc');
    expect(cloudRequests()[0].options.headers).toMatchObject({ 'X-CSRF-Token': 'test-csrf' });
    expect(JSON.parse(String(cloudRequests()[0].options.body))).toEqual({ revision: 'r1' });
    fireEvent.click(screen.getByRole('button', { name: '正在同步飞书评论…' }));
    expect(cloudRequests()).toHaveLength(1);
    const imported = { ...disk.review!.comments[0], id: 'cloud-one', body: '飞书新增意见', status: 'open' as const };
    disk = { ...disk, revision: 'r2', review: { ...disk.review!, comments: [...disk.review!.comments, imported],
      cloudSync: { version: 1, documentId: target.documentId, url: target.url, links: [], lastSyncedAt: report.syncedAt } } };
    await act(async () => { syncing.resolve(await response({ snapshot: disk, report: { ...report, issues: ['一个已删除引用仍需确认'] } })); });
    expect(screen.getByText('飞书新增意见')).toBeDefined();
    expect(screen.getByText('1 项需要处理')).toBeDefined();
    expect(screen.getByText('一个已删除引用仍需确认')).toBeDefined();
    expect(editor.isEditable).toBe(true); expect(writes()).toHaveLength(1);
    expect(editor.getText()).toContain('原文内容'); expect(disk.xml).toBe(xml);
  });

  it('requires unfinished comments and replies to be sent or cancelled without losing their text', async () => {
    const { editor } = await open();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 3 }); });
    fireEvent.click(screen.getByRole('button', { name: '评论选中内容' }));
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '尚未发送的具体建议' } });
    fireEvent.click(syncButton());
    expect(screen.getByRole('alert').textContent).toContain('先发送或取消');
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('尚未发送的具体建议');
    expect(editor.isEditable).toBe(true); expect(cloudRequests()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '取消评论' }));
    const card = screen.getByText('本地意见').closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: '回复' }));
    fireEvent.change(screen.getByLabelText('回复评论'), { target: { value: '尚未发送的回复' } });
    fireEvent.click(syncButton());
    expect((screen.getByLabelText('回复评论') as HTMLTextAreaElement).value).toBe('尚未发送的回复');
    expect(cloudRequests()).toHaveLength(0); expect(writes()).toHaveLength(0);
  });

  it('blocks an unapplied formula draft even after its source editor is hidden by read mode', async () => {
    const { editor } = await open();
    act(() => { editor.commands.setNodeSelection(6); });
    const formula = await screen.findByLabelText('公式表达式');
    fireEvent.change(formula, { target: { value: 'x^3' } });
    fireEvent.click(screen.getByRole('button', { name: '只读' }));
    fireEvent.click(syncButton());
    expect(screen.getByRole('alert').textContent).toContain('先应用或还原公式');
    expect(cloudRequests()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText('公式表达式') as HTMLTextAreaElement).value).toBe('x^3');
    expect(disk.xml).toBe(xml);
  });

  it('never sends to the cloud when saving fails and restores local editing with its input retained', async () => {
    routes = (_url, options) => options.method === 'PUT' ? response({ error: '模拟磁盘不可写' }, 500) : undefined;
    const { editor } = await open();
    act(() => { editor.view.dispatch(editor.state.tr.insertText('刚刚输入', 1)); });
    fireEvent.click(syncButton());
    await screen.findByText('本地修改尚未保存，未开始同步飞书评论。');
    expect(cloudRequests()).toHaveLength(0); expect(editor.isEditable).toBe(true);
    expect(editor.getText()).toContain('刚刚输入原文内容');
    expect(disk.xml).toBe(xml);
  });

  it.each(['编辑', '只读'])('restores %s mode after a cloud failure without retrying a possibly completed write', async mode => {
    routes = url => url.startsWith('/api/cloud-sync') ? response({ error: '云端回执暂时不可用' }, 502) : undefined;
    const { editor } = await open();
    fireEvent.click(screen.getByRole('button', { name: mode }));
    fireEvent.click(syncButton());
    await screen.findByText('同步未完成：云端回执暂时不可用。请先核对目标文档与本地记录。');
    expect(editor.isEditable).toBe(mode === '编辑');
    expect(cloudRequests()).toHaveLength(1); expect(writes()).toHaveLength(0);
    expect(screen.getByText('本地意见')).toBeDefined();
    expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull();
  });

  it('keeps unexpected late document input rather than replacing it with an older sync receipt', async () => {
    const syncing = deferred<Response>();
    routes = url => url.startsWith('/api/cloud-sync') ? syncing.promise : undefined;
    const { editor } = await open();
    fireEvent.click(syncButton());
    await waitFor(() => expect(cloudRequests()).toHaveLength(1));
    expect(editor.isEditable).toBe(false);
    // An extension may still dispatch while contenteditable is disabled.
    act(() => { editor.view.dispatch(editor.state.tr.insertText('迟到输入', 1)); });
    await act(async () => { syncing.resolve(await response({ snapshot: { ...disk, revision: 'cloud-new' }, report })); });
    expect(editor.getText()).toContain('迟到输入原文内容');
    expect(screen.getByRole('alert').textContent).toContain('已保留页内输入');
    expect(screen.getByRole('button', { name: '重新载入磁盘版本' })).toBeDefined();
    expect(syncButton().disabled).toBe(true); expect(writes()).toHaveLength(0);
  });

  it('ignores an old idle poll that resolves while cloud synchronization is in progress', async () => {
    const polling = deferred<Response>(), syncing = deferred<Response>();
    let reads = 0;
    routes = (url, options) => {
      if (url.startsWith('/api/document') && options.method === 'GET' && ++reads > 1) return polling.promise;
      if (url.startsWith('/api/cloud-sync')) return syncing.promise;
    };
    const { editor } = await open();
    await waitFor(() => expect(reads).toBe(2), { timeout: 3000 });
    fireEvent.click(syncButton());
    await waitFor(() => expect(cloudRequests()).toHaveLength(1));
    await act(async () => { polling.resolve(await response({ xml: '<p>旧轮询中别的内容</p>', review: null, revision: 'stale-poll' })); });
    expect(editor.getText()).toContain('原文内容');
    await act(async () => { syncing.resolve(await response({ snapshot: { ...disk, revision: 'cloud-new' }, report })); });
    expect(editor.getText()).toContain('原文内容');
    expect(screen.queryByText('已同步本地文件中的更新。')).toBeNull();
  });

  it('shows an uncertain send receipt and blocks another sync until local state is reconciled', async () => {
    disk.review!.cloudSync = { version: 1, documentId: target.documentId, url: target.url, links: [],
      pending: { id: 'intent-one', kind: 'create', localId: 'local-one', startedAt: report.syncedAt } };
    await open();
    expect(screen.getByText(/上次同步的发送结果尚未确认/)).toBeDefined();
    expect(syncButton().disabled).toBe(true);
    fireEvent.click(syncButton());
    expect(cloudRequests()).toHaveLength(0);
  });
});
