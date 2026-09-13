// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/ui/App';
import { createReview } from '../src/core/types';

// These tests exercise App's asynchronous save/load state independently of DOM editing.
vi.mock('../src/ui/Reader', async () => {
  const React = await import('react');
  type Props = React.ComponentProps<typeof import('../src/ui/Reader').Reader>;
  return { FormulaEditor:()=>null,Reader: (props: Props) => React.createElement('div', {},
    React.createElement('button', {
      onClick: () => props.onEdit(props.xml.replace('</p>', 'x</p>'), props.comments, props.getDraft()),
    }, '测试编辑正文'),
    React.createElement('button', {
      onClick: () => props.onSelection({ from: 1, to: 2, quote: 'A', state: 'attached' }),
    }, '测试选择正文')) };
});

const first = { id: 'a', name: 'a.xml', path: '/tmp/a.xml', reviewPath: '/tmp/a.review.json' };
const second = { id: 'b', name: 'b.xml', path: '/tmp/b.xml', reviewPath: '/tmp/b.review.json' };
const snapshot = (xml = '<p>A</p>', revision = 'r0') => ({ xml, revision, review: createReview('a.xml', xml) });
const response = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('autosave and external load races', () => {
  it('retains edits made during a pre-switch save and refuses switching documents', async () => {
    vi.useFakeTimers();
    const saving = deferred<Response>();
    const writes: Array<{ xml: string; review: ReturnType<typeof createReview> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url === '/api/session') return response({ csrf: 'test', document: first, nativePicker: true });
      if (init.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return writes.length === 1 ? saving.promise : response({ ...snapshot(writes.at(-1)!.xml, 'r2'), review: writes.at(-1)!.review });
      }
      if (url === '/api/pick') return response(second);
      return response(url.endsWith('id=b') ? snapshot('<p>B</p>', 'rb') : snapshot());
    }));
    await act(async () => { render(<App/>); });
    fireEvent.click(screen.getByText('测试编辑正文'));
    fireEvent.click(screen.getByText('切换文档'));
    expect(writes).toHaveLength(1);
    expect(writes[0].xml).toBe('<p>Ax</p>');
    fireEvent.click(screen.getByText('测试编辑正文'));
    await act(async () => {
      saving.resolve(response({ ...snapshot('<p>Ax</p>', 'r1'), review: writes[0].review }));
    });
    expect(screen.queryByText('b.xml')).toBeNull();
    expect(screen.getByText('最新输入还在保存，请等保存完成后再切换文档。')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(writes.map(write => write.xml)).toEqual(['<p>Ax</p>', '<p>Axx</p>']);
  });

  it('keeps a comment draft started while an idle polling request is in flight', async () => {
    vi.useFakeTimers();
    const polling = deferred<Response>();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/session') return response({ csrf: 'test', document: first, nativePicker: true });
      reads += 1;
      return reads === 1 ? response(snapshot()) : polling.promise;
    }));
    await act(async () => { render(<App/>); });
    await act(async () => { vi.advanceTimersByTime(1800); });
    expect(reads).toBe(2);
    fireEvent.click(screen.getByText('测试选择正文'));
    fireEvent.click(screen.getByText('评论选中内容'));
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '这段需要补证据' } });
    await act(async () => { polling.resolve(response(snapshot('<p>Z</p>', 'r2'))); });
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('这段需要补证据');
  });
});
