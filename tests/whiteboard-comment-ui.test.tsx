// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createReview, type Snapshot } from '../src/core/types';
import { App } from '../src/ui/App';

const handle = { id: 'doc', name: 'article.xml', path: '/project/article.xml', reviewPath: '/project/article.review.json' };
const xml = '<whiteboard token="board-one"/><whiteboard token="board-two"/><p>正文原样保留</p>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><g id="t1:2"><g id="o1:1"><rect width="80" height="40"/><text>同名节点</text></g><g id="o1:2"><rect x="110" width="80" height="40"/><text>其他节点</text></g></g></svg>';
const reply = (value: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => value } as Response);
const scrollIntoView = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
let disk: Snapshot;

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  scrollIntoView.mockReset();
  const review = createReview(handle.name, xml);
  review.resources = { version: 1, items: [
    { tag: 'whiteboard', attribute: 'token', value: 'board-one', path: 'one.svg', representation: 'preview' },
    { tag: 'whiteboard', attribute: 'token', value: 'board-two', path: 'two.svg', representation: 'preview' },
  ] };
  disk = { xml, review, revision: 'r0' };
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
    if (url === '/api/session') return reply({ csrf: 'test', document: handle, nativePicker: false });
    if (url.startsWith('/api/document')) {
      if (options.method === 'PUT') {
        const value = JSON.parse(String(options.body));
        expect(value.revision).toBe(disk.revision);
        disk = { xml: value.xml, review: value.review, revision: 'r' + (Number(disk.revision.slice(1)) + 1) };
      }
      return reply(disk);
    }
    if (url.startsWith('/api/resource')) {
      const path = new URL(url, window.location.href).searchParams.get('path');
      if (path !== 'one.svg' && path !== 'two.svg') throw new Error('unexpected resource ' + path);
      return reply({ path, text: svg });
    }
    throw new Error('unexpected fetch ' + url);
  }));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
});

async function open(mode: string) {
  const mounted = render(<App/>);
  // Real resource loading and lazy SVG sanitization can exceed the default 1s
  // while the full suite initializes its independent jsdom workers in parallel.
  await waitFor(() => expect(screen.getAllByRole('button', { name: '白板组件：同名节点' })).toHaveLength(2), { timeout: 3000 });
  fireEvent.click(screen.getByRole('button', { name: mode }));
  const sameLabel = screen.getAllByRole('button', { name: '白板组件：同名节点' });
  return { mounted, first: sameLabel[0], second: sameLabel[1] };
}
function onlyFirstHighlighted(first: Element, second: Element) {
  expect(first.classList.contains('lr-whiteboard-component-commented')).toBe(true);
  expect(second.classList.contains('lr-whiteboard-component-commented')).toBe(false);
  expect(document.querySelectorAll('.lr-whiteboard-component-commented')).toHaveLength(1);
  expect(document.querySelector('.protected-block.comment-highlight')).toBeNull();
}

describe('component comments through the real App and Reader', () => {
  it.each(['编辑', '只读'])('%s clicks a cached SVG node, saves its identity, replies, resolves, restores and locates it after reopening', async mode => {
    let { mounted, first, second } = await open(mode);
    expect(screen.getByLabelText('文章正文').getAttribute('contenteditable')).toBe(mode === '只读' ? 'false' : 'true');
    // These are actual sanitized SVG nodes rendered from the resource HTTP boundary.
    expect(first.getAttribute('data-review-component-id')).toBe('o1:1');
    expect(first.closest('[data-review-board]')?.getAttribute('data-review-board')).toBe('token:board-one');
    expect(second.closest('[data-review-board]')?.getAttribute('data-review-board')).toBe('token:board-two');
    fireEvent.click(first.querySelector('text')!);
    fireEvent.click(await screen.findByRole('button', { name: '评论选中组件' }));
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '说明第一个白板的同名节点' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    await waitFor(() => expect(disk.review?.comments).toHaveLength(1), { timeout: 3000 });
    const saved = disk.review!.comments[0];
    expect(saved.anchor).toEqual({ from: 0, to: 1, quote: '【白板节点：同名节点】', state: 'attached',
      target: { kind: 'whiteboard-component', board: 'token:board-one', id: 'o1:1', label: '同名节点' } });
    expect(disk.xml).toBe(xml); expect(disk.review!.document.xml).toBe(xml);
    await waitFor(() => onlyFirstHighlighted(first, second));

    let card = screen.getByText('说明第一个白板的同名节点').closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: '回复' }));
    const replyInput = within(card).getByLabelText('回复评论');
    fireEvent.change(replyInput, { target: { value: '补充节点输入来源' } });
    fireEvent.submit(replyInput.closest('form')!);
    await waitFor(() => expect(disk.review!.comments[0].replies[0]?.body).toBe('补充节点输入来源'), { timeout: 3000 });
    fireEvent.click(within(card).getByRole('button', { name: '解决' }));
    await waitFor(() => expect(disk.review!.comments[0].status).toBe('resolved'), { timeout: 3000 });
    expect(document.querySelectorAll('.lr-whiteboard-component-commented')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '查看已解决评论' }));
    await waitFor(() => onlyFirstHighlighted(first, second));
    fireEvent.click(screen.getByRole('button', { name: '【白板节点：同名节点】' }));
    expect(first.classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(first.getAttribute('data-comment-navigation')).toBe('true');
    fireEvent.click(first.querySelector('text')!);
    expect(first.hasAttribute('data-comment-navigation')).toBe(false);
    expect(screen.getByRole('button', { name: '评论选中组件' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '隐藏已解决评论' }));
    expect(document.querySelectorAll('.lr-whiteboard-component-commented')).toHaveLength(0);
    expect(document.querySelectorAll('[data-comment-navigation].lr-whiteboard-component-selected')).toHaveLength(0);
    expect(first.classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(screen.getByRole('button', { name: '评论选中组件' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '查看已解决评论' }));
    card = screen.getByText('说明第一个白板的同名节点').closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: '重新打开' }));
    await waitFor(() => expect(disk.review!.comments[0].status).toBe('open'), { timeout: 3000 });
    await waitFor(() => onlyFirstHighlighted(first, second));

    mounted.unmount();
    ({ mounted, first, second } = await open(mode));
    await waitFor(() => onlyFirstHighlighted(first, second));
    fireEvent.click(screen.getByRole('button', { name: '查看评论' }));
    const quote = screen.getByRole('button', { name: '【白板节点：同名节点】' });
    fireEvent.click(quote);
    expect(first.classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(second.classList.contains('lr-whiteboard-component-selected')).toBe(false);
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(first);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest' });
    expect(disk.review!.comments[0].anchor.target).toEqual(saved.anchor.target);
    expect(disk.review!.comments[0].replies[0].body).toBe('补充节点输入来源');
    expect(disk.xml).toBe(xml);
    mounted.unmount();
  }, 15000);

  it('reports a missing component on reopen instead of locating the same label and id on another board', async () => {
    const { mounted, first } = await open('只读');
    fireEvent.click(first);
    fireEvent.click(await screen.findByRole('button', { name: '评论选中组件' }));
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '只属于第一个白板的节点' } });
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    await waitFor(() => expect(disk.review?.comments).toHaveLength(1), { timeout: 3000 });
    mounted.unmount();
    const priorFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (String(url).startsWith('/api/resource') && new URL(String(url), window.location.href).searchParams.get('path') === 'one.svg')
        return reply({ path: 'one.svg', text: svg.replace('id="o1:1"', 'id="o1:9"') });
      return priorFetch(url, options);
    });
    const reopened = await open('只读');
    expect(document.querySelectorAll('.lr-whiteboard-component-commented')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '查看评论' }));
    fireEvent.click(screen.getByRole('button', { name: '【白板节点：同名节点】' }));
    expect(screen.getByText('白板中已找不到这个节点，原评论与引用仍保留。')).toBeDefined();
    expect(reopened.second.classList.contains('lr-whiteboard-component-selected')).toBe(false);
    expect(disk.review!.comments[0].anchor.target?.id).toBe('o1:1');
    reopened.mounted.unmount();
  });

  it('keeps component selection exclusive across boards, hides source editing, and clears selection on ordinary text', async () => {
    const localXML = '<whiteboard id="inline-one" type="svg"><![CDATA[' + svg + ']]></whiteboard>' +
      '<whiteboard id="inline-two" type="svg"><![CDATA[' + svg + ']]></whiteboard><p>正文原样保留</p>';
    disk = { xml: localXML, review: createReview(handle.name, localXML), revision: 'r0' };
    const { mounted, first, second } = await open('编辑');
    fireEvent.click(first.querySelector('rect')!);
    await screen.findByRole('button', { name: '评论选中组件' });
    expect(first.classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'SVG 图源' })).toBeNull();
    fireEvent.click(second.querySelector('text')!);
    expect(second.classList.contains('lr-whiteboard-component-selected')).toBe(true);
    expect(first.classList.contains('lr-whiteboard-component-selected')).toBe(false);
    expect(document.querySelectorAll('.lr-whiteboard-component-selected')).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: 'SVG 图源' })).toBeNull();

    // Send an ordinary native text selection through ProseMirror's DOM observer,
    // rather than replacing or mocking Reader's selection callback.
    const article = screen.getByLabelText('文章正文'); article.focus();
    const text = screen.getByText('正文原样保留').firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 2);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    await waitFor(() => expect(document.querySelectorAll('.lr-whiteboard-component-selected')).toHaveLength(0));
    expect(screen.getByRole('button', { name: '评论选中内容' })).toBeDefined();
    expect(disk.xml).toBe(localXML); expect(disk.review!.comments).toHaveLength(0);
    mounted.unmount();
  });
});
