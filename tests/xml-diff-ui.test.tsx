// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as engine from '../src/core/xml-diff';
import { XMLDiff } from '../src/ui/XMLDiff';

const labels = { beforeLabel: '同步前 · 本地 article.xml', afterLabel: '同步后 · 飞书文档' };
const before = '<p>旧内容</p><p>相同结尾</p>';
const after = '<p>新内容</p><p>相同结尾</p>';
const panel = () => screen.getByRole('region', { name: 'XML 正文差异' });
const viewport = () => screen.getByRole('region', { name: '可滚动的正文差异' });
const displayMode = (name: '左右' | '合并') => screen.getByRole('button', { name });
const codes = (element: Element) => Array.from(element.querySelectorAll('code'), code => code.textContent);
beforeEach(() => { vi.stubGlobal('innerWidth', 1280); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('XML diff presentation', () => {
  it('shows exact destination/source labels and paired changed cells in one row and one scroll viewport', () => {
    render(<XMLDiff before={before} after={after} {...labels}/>);
    expect(displayMode('左右').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(labels.beforeLabel)).toBeDefined(); expect(screen.getByText(labels.afterLabel)).toBeDefined();
    expect(screen.getByText('+1 新增')).toBeDefined(); expect(screen.getByText('-1 删除')).toBeDefined();
    expect(screen.getByText('按 XML 块分行')).toBeDefined();
    expect(screen.getAllByRole('region', { name: '可滚动的正文差异' })).toHaveLength(1);
    const row = viewport().querySelector('[data-kind="change"]')!;
    expect(row.children).toHaveLength(2); expect(codes(row)).toEqual(['<p>旧内容</p>', '<p>新内容</p>']);
    expect(row.children[0].classList.contains('xml-diff-removed')).toBe(true);
    expect(row.children[1].classList.contains('xml-diff-added')).toBe(true);
    expect(row.children[0].querySelector('.xml-diff-sign')?.textContent).toBe('-');
    expect(row.children[1].querySelector('.xml-diff-sign')?.textContent).toBe('+');
    expect(row.children[0].querySelector('mark')?.textContent).toBe('旧');
    expect(row.children[1].querySelector('mark')?.textContent).toBe('新');
  });

  it('switches to merged removal/addition order with native keyboard controls and retains exact text', async () => {
    render(<XMLDiff before={before} after={after} {...labels}/>);
    await userEvent.tab(); expect(document.activeElement).toBe(displayMode('左右'));
    await userEvent.tab(); expect(document.activeElement).toBe(displayMode('合并'));
    await userEvent.keyboard('{Enter}');
    expect(displayMode('合并').getAttribute('aria-pressed')).toBe('true');
    expect(panel().classList.contains('xml-diff-unified')).toBe(true);
    const row = viewport().querySelector('[data-kind="change"]')!;
    expect(codes(row)).toEqual(['<p>旧内容</p>', '<p>新内容</p>']);
    expect(codes(viewport()).filter(text => text === '<p>相同结尾</p>')).toHaveLength(1);
    displayMode('左右').focus(); await userEvent.keyboard(' ');
    expect(displayMode('左右').getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults to merged view on narrow screens but respects an explicitly chosen mode after resizing', () => {
    vi.stubGlobal('innerWidth', 375);
    render(<XMLDiff before={before} after={after} {...labels}/>);
    expect(displayMode('合并').getAttribute('aria-pressed')).toBe('true');
    vi.stubGlobal('innerWidth', 1280); fireEvent.resize(window);
    expect(displayMode('左右').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(displayMode('合并'));
    vi.stubGlobal('innerWidth', 700); fireEvent.resize(window);
    vi.stubGlobal('innerWidth', 1280); fireEvent.resize(window);
    expect(displayMode('合并').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a compact identical result instead of a full page of unchanged XML', () => {
    const source = Array.from({ length: 1000 }, (_, index) => '<p>相同行 ' + index + '</p>').join('');
    render(<XMLDiff before={source} after={source} {...labels}/>);
    expect(screen.getByText('正文内容相同')).toBeDefined(); expect(screen.getByText(labels.beforeLabel)).toBeDefined();
    expect(screen.getByText(labels.afterLabel)).toBeDefined(); expect(panel().querySelectorAll('code')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '可滚动的正文差异' })).toBeNull();
  });

  it('folds a long equal run with three rows on either side, then exposes the exact hidden text by keyboard', async () => {
    const context = Array.from({ length: 10 }, (_, index) => '<p>相同段 ' + (index + 1) + '</p>').join('');
    render(<XMLDiff before={context + '<p>旧尾段</p>'} after={context + '<p>新尾段</p>'} {...labels}/>);
    expect(codes(viewport())).not.toContain('<p>相同段 4</p>');
    expect(codes(viewport())).toContain('<p>相同段 3</p>'); expect(codes(viewport())).toContain('<p>相同段 8</p>');
    const expand = screen.getByRole('button', { name: '展开 4 行相同内容' });
    expand.focus(); await userEvent.keyboard('{Enter}');
    expect(codes(viewport())).toContain('<p>相同段 4</p>'); expect(codes(viewport())).toContain('<p>相同段 7</p>');
    expect(screen.queryByRole('button', { name: /展开/ })).toBeNull(); expect(document.activeElement).toBe(viewport());
  });

  it('renders XML, script-like text and entity syntax literally without creating active elements', () => {
    const dangerous = '<svg onload="alert(1)"><script>alert(2)</script></svg><img src="https://invalid.test/pixel" onerror="alert(3)"/><p>&lt;literal&gt; &amp; untouched</p>';
    const { container } = render(<XMLDiff before="<p>before</p>" after={dangerous} {...labels}/>);
    expect(container.querySelector('script,svg,img,iframe')).toBeNull();
    expect(Array.from(container.querySelectorAll('.xml-diff-added code'), element => element.textContent).join('')).toBe(dangerous);
    expect(container.innerHTML).toContain('&lt;script&gt;'); expect(container.innerHTML).toContain('&amp;lt;literal&amp;gt;');
  });

  it('keeps empty insertion/deletion counterparts rather than pairing content with the wrong side', () => {
    const { rerender } = render(<XMLDiff before="" after="<p>新增</p>" {...labels}/>);
    let row = viewport().querySelector('[data-kind="change"]')!;
    expect(codes(row)).toEqual(['', '<p>新增</p>']); expect(row.children[0].classList.contains('xml-diff-empty')).toBe(true);
    rerender(<XMLDiff before="<p>删除</p>" after="" {...labels}/>);
    row = viewport().querySelector('[data-kind="change"]')!;
    expect(codes(row)).toEqual(['<p>删除</p>', '']); expect(row.children[1].classList.contains('xml-diff-empty')).toBe(true);
  });

  it('states an engine limit without false zero-change counts or a fabricated truncated diff', () => {
    const oversized = '<p>' + 'x'.repeat(1_000_001) + '</p>';
    render(<XMLDiff before={oversized} after="<p>changed</p>" {...labels}/>);
    expect(screen.getByRole('status').textContent).toContain('1,000,000');
    expect(screen.getByRole('status').textContent).toContain('原文');
    expect(screen.queryByLabelText('改动行数')).toBeNull(); expect(panel().querySelectorAll('code')).toHaveLength(0);
    expect(screen.queryByText('正文内容相同')).toBeNull();
  });

  it('retains every complete row when only inline detail is limited', () => {
    const longBefore = '<p>' + 'a'.repeat(5000) + '</p>', longAfter = '<p>' + 'b'.repeat(5000) + '</p>';
    render(<XMLDiff before={longBefore} after={longAfter} {...labels}/>);
    expect(screen.getByRole('status').textContent).toContain('原文');
    expect(codes(viewport())).toEqual([longBefore, longAfter]); expect(screen.getByLabelText('改动行数')).toBeDefined();
  });

  it('bounds rendered rows while making later dense changes reachable, and resets paging for new inputs', () => {
    // The UI paging contract is independent of the engine time budget. Other cases use the real engine.
    const rows: engine.DiffRow[] = Array.from({ length: 901 }, (_, index) => ({ kind: 'change',
      before: { number: index + 1, text: '<p>before ' + index + '</p>', parts: [{ text: '<p>before ' + index + '</p>', changed: true }] },
      after: { number: index + 1, text: '<p>after ' + index + '</p>', parts: [{ text: '<p>after ' + index + '</p>', changed: true }] },
    }));
    const build = vi.spyOn(engine, 'buildXMLDiff').mockReturnValueOnce({ rows, added: 901, removed: 901, identical: false, limited: false });
    const { rerender } = render(<XMLDiff before="first-before" after="first-after" {...labels}/>);
    expect(viewport().querySelectorAll('[data-diff-row]')).toHaveLength(400);
    expect(codes(viewport())).not.toContain('<p>after 900</p>');
    fireEvent.click(screen.getByRole('button', { name: '下一段' }));
    expect(viewport().querySelectorAll('[data-diff-row]')).toHaveLength(400);
    fireEvent.click(screen.getByRole('button', { name: '下一段' }));
    expect(viewport().querySelectorAll('[data-diff-row]')).toHaveLength(101); expect(codes(viewport())).toContain('<p>after 900</p>');
    expect((screen.getByRole('button', { name: '下一段' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '上一段' })); expect(codes(viewport())).toContain('<p>after 400</p>');
    build.mockRestore(); rerender(<XMLDiff before={before} after={after} {...labels}/>);
    expect(screen.queryByRole('navigation', { name: '差异分段' })).toBeNull(); expect(codes(viewport())).toContain('<p>新内容</p>');
  });

  it('resets expanded context for a new comparison without changing the chosen display mode', () => {
    const context = Array.from({ length: 10 }, (_, index) => '<p>相同 ' + index + '</p>').join('');
    const { rerender } = render(<XMLDiff before={context + '<p>A</p>'} after={context + '<p>B</p>'} {...labels}/>);
    fireEvent.click(displayMode('合并')); fireEvent.click(screen.getByRole('button', { name: '展开 4 行相同内容' }));
    expect(screen.queryByRole('button', { name: /展开/ })).toBeNull();
    rerender(<XMLDiff before={context + '<p>A</p>'} after={context + '<p>C</p>'} {...labels}/>);
    expect(within(panel()).getByRole('button', { name: '展开 4 行相同内容' })).toBeDefined();
    expect(displayMode('合并').getAttribute('aria-pressed')).toBe('true');
  });

  it('scrolls and focuses the difference start only after explicit paging, leaving initial and replacement previews alone', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      const rows: engine.DiffRow[] = Array.from({ length: 401 }, (_, index) => ({ kind: 'change',
        after: { number: index + 1, text: '<p>' + index + '</p>', parts: [{ text: '<p>' + index + '</p>', changed: true }] },
      }));
      const build = vi.spyOn(engine, 'buildXMLDiff').mockReturnValueOnce({ rows, added: 401, removed: 0, identical: false, limited: false });
      const { rerender } = render(<XMLDiff before="first" after="second" {...labels}/>);
      expect(scrollIntoView).not.toHaveBeenCalled();
      viewport().scrollTop = 250;
      fireEvent.click(screen.getByRole('button', { name: '下一段' }));
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
      expect(scrollIntoView.mock.contexts[0]).toBe(viewport());
      expect(viewport().scrollTop).toBe(0); expect(document.activeElement).toBe(viewport());
      fireEvent.click(screen.getByRole('button', { name: '上一段' }));
      expect(scrollIntoView).toHaveBeenCalledTimes(2); expect(viewport().scrollTop).toBe(0);
      build.mockRestore(); rerender(<XMLDiff before={before} after={after} {...labels}/>);
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('identifies changed spaces, tabs and CRLF without changing code text or the copied source range', () => {
    const left = '<p>前</p> \t\r\n<p>后</p>', right = '<p>前</p>\n<p>后</p>';
    render(<XMLDiff before={left} after={right} {...labels}/>);
    const whitespace = viewport().querySelector('.xml-diff-removed .xml-diff-whitespace')!;
    expect(whitespace).not.toBeNull(); expect(whitespace.textContent).toBe(' \t\r');
    expect(whitespace.getAttribute('data-whitespace')).toBe('·⇥␍');
    expect(whitespace.getAttribute('aria-label')).toBe('空白改动：空格 × 1，制表符 × 1，回车 × 1');
    const removed = whitespace.closest('code')!;
    expect(removed.textContent).toBe(' \t\r\n');
    const range = document.createRange(); range.selectNodeContents(removed);
    expect(range.toString()).toBe(' \t\r\n');
    expect(viewport().querySelector('.xml-diff-equal .xml-diff-whitespace')).toBeNull();
  });
});
