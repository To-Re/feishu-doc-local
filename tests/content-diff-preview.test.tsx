// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ContentPreview, ReviewProject } from '../src/core/projects';
import { ContentSync } from '../src/ui/ContentSync';

afterEach(cleanup);
const project: ReviewProject = { id: 'sample', name: '差异验收', localPath: '/samples/doc.xml', defaultDirection: 'pull', createdAt: '2026-09-13T00:00:00Z', cloud: { documentId: 'sample', url: 'https://example.feishu.cn/docx/sample' } };
const localXML = '<p id="a">本地版本</p>\r\n<p>保留 &amp; 实体</p>';
const cloudXML = '<p id="a">飞书版本</p>\r\n<p>保留 &amp; 实体</p>';
function setup(overrides: Partial<ContentPreview> = {}, extra: Partial<React.ComponentProps<typeof ContentSync>> = {}) {
  const preview: ContentPreview = { id: 'preview', projectId: project.id, direction: 'pull', status: 'ready', localXML, cloudXML, summary: '同步预览', warnings: [], expiresAt: '2099-01-01T00:00:00Z', ...overrides };
  const onExecute = vi.fn(), onPreview = vi.fn(), onClose = vi.fn();
  const rendered = render(<ContentSync project={project} direction="pull" busy={false} disabled={false} preview={preview} stale={false} error="" message="" onDirection={vi.fn()} onPreview={onPreview} onExecute={onExecute} onClose={onClose} {...extra}/>);
  return { ...rendered, onExecute, onPreview, onClose };
}

it.each(['pull', 'push'] as const)('uses the preview direction for replacement polarity and preserves exact raw sources: %s', direction => {
  const { container, onExecute, onClose } = setup({ direction });
  const removed = container.querySelector('.xml-diff-removed code')!.textContent;
  const added = container.querySelector('.xml-diff-added code')!.textContent;
  expect(removed).toContain(direction === 'pull' ? '本地版本' : '飞书版本');
  expect(added).toContain(direction === 'pull' ? '飞书版本' : '本地版本');
  fireEvent.click(screen.getByRole('button', { name: '合并' }));
  const raw = container.querySelector('details.content-raw')!;
  expect(raw.hasAttribute('open')).toBe(false);
  fireEvent.click(screen.getByText('查看完整原文', { selector: 'summary' }));
  expect(screen.getByLabelText('本地正文源码').textContent).toBe(localXML);
  expect(screen.getByLabelText('飞书正文源码').textContent).toBe(cloudXML);
  expect(onExecute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onExecute).not.toHaveBeenCalled();
});

it('keeps resource synchronization available when XML is identical but the server requires a refresh', () => {
  const { onExecute } = setup({ cloudXML: localXML, warnings: ['白板资源需要刷新'] });
  expect(screen.getByText('正文内容相同')).toBeDefined();
  expect(screen.getByText('白板资源需要刷新')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '确认拉取' }));
  expect(onExecute).toHaveBeenCalledOnce();
});

it('shows cloud-to-local polarity for readback repair even when the selected direction is push', () => {
  const { container, onExecute } = setup({ direction: 'push', action: 'refresh-local' });
  expect(container.querySelector('.xml-diff-removed code')!.textContent).toContain('本地版本');
  expect(container.querySelector('.xml-diff-added code')!.textContent).toContain('飞书版本');
  expect(screen.getByText(/本次不写入飞书/)).toBeDefined();
  expect(screen.queryByRole('button', { name: '确认推送' })).toBeNull();
  expect(onExecute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '更新本地' }));
  expect(onExecute).toHaveBeenCalledOnce();
});

it('retains stale-preview gating while allowing display-mode changes', () => {
  const { onExecute, onPreview } = setup({}, { stale: true });
  fireEvent.click(screen.getByRole('button', { name: '合并' }));
  expect(screen.queryByRole('button', { name: '确认拉取' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新预览' }));
  expect(onPreview).toHaveBeenCalledOnce();
  expect(onExecute).not.toHaveBeenCalled();
});

it('traps forward and reverse Tab among visible controls during synchronization with raw XML collapsed', () => {
  const { container } = setup({}, { busy: true });
  const dialog = screen.getByRole('dialog', { name: '正文同步预览' });
  const first = screen.getByRole('link', { name: '正文同步飞书链接' });
  const last = container.querySelector<HTMLElement>('.content-raw > summary')!;
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  dialog.focus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
});
