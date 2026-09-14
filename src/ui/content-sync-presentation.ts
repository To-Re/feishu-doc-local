import type { ContentPreview } from '../core/projects';

/** Describe the operation that will run, including a completed push's local-only repair. */
export function contentSyncPresentation(preview: Pick<ContentPreview, 'direction' | 'action'>) {
  if (preview.action === 'refresh-local') return {
    operation: '推送已完成 · 更新本地副本',
    description: '飞书已包含这份内容。本次将飞书版本更新到本地，旧稿会存档；本次不写入飞书。',
    confirm: '更新本地副本',
    updatesLocal: true,
    beforeLabel: '更新前 · 本地正文',
    afterLabel: '更新后 · 采用飞书正文',
  };
  if (preview.direction === 'pull') return {
    operation: '拉取 · 飞书 → 本地',
    description: '用飞书正文和资源更新本地文档，旧稿会存档。',
    confirm: '确认拉取',
    updatesLocal: true,
    beforeLabel: '拉取前 · 本地正文',
    afterLabel: '拉取后 · 采用飞书正文',
  };
  return {
    operation: '推送 · 本地 → 飞书',
    description: '用本地正文更新飞书文档。推送完成后更新本地副本，旧稿会存档。',
    confirm: '确认推送',
    updatesLocal: false,
    beforeLabel: '推送前 · 飞书正文',
    afterLabel: '推送后 · 采用本地正文',
  };
}
