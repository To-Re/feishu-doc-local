import type { Review } from '../core/types';
import { isAnchorTarget } from '../core/anchors';
import { isResourceMapping } from '../core/resources';
import { isCloudSyncState } from '../core/cloud-state';
import { isContentSyncState } from '../core/content-state';

export interface PendingBrowserWrite {
  id: string; beforeXML: string; beforeHash: string; afterHash: string; startedAt: string;
  createdDocument?: true;
}
export type StoredBrowserReview = Review & { pendingWrite?: PendingBrowserWrite };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Browser-side full validation before any write. Preserve unknown fields,
 * including cloud identities, so local editing never silently strips them. */
export async function validateBrowserReview(value: unknown, name: string): Promise<StoredBrowserReview> {
  const invalid = (message = '评论文件格式不正确，原文件未被覆盖。'): never => { throw new Error(message); };
  if (!object(value) || value.format !== 'lark-review' || value.version !== 1) invalid();
  const v = value as Record<string, any>, d = v.document;
  if (!object(d) || d.name !== name || !text(d.baselineXML) || !text(d.xml) || !date(d.updatedAt) || !Array.isArray(v.comments) || !Array.isArray(v.operations)) invalid();
  const ids = new Set<string>();
  for (const c of v.comments) {
    if (!object(c) || !text(c.id) || !c.id || ids.has(c.id) || !text(c.author) || !text(c.body) || !date(c.createdAt) || !['open', 'resolved'].includes(c.status) || !object(c.anchor) || !Array.isArray(c.replies)) invalid();
    ids.add(c.id);
    const a = c.anchor;
    if (!integer(a.from) || !integer(a.to) || a.to < a.from || !text(a.quote) || !['attached', 'deleted', 'unverified'].includes(a.state)) invalid();
    if (a.target !== undefined && (!isAnchorTarget(a.target) || (a.state === 'attached' && a.to !== a.from + 1))) invalid();
    const replies = new Set<string>();
    for (const r of c.replies) {
      if (!object(r) || !text(r.id) || !r.id || replies.has(r.id) || !text(r.author) || !text(r.body) || !date(r.createdAt)) invalid();
      replies.add(r.id);
    }
  }
  for (const op of v.operations) if (!object(op) || !text(op.id) || !text(op.type) || !text(op.author) || !date(op.at) || !text(op.summary)) invalid();
  if (v.result !== undefined && (!object(v.result) || !text(v.result.author) || !text(v.result.summary) || !date(v.result.appliedAt))) invalid();
  if (v.cloudSync !== undefined && !isCloudSyncState(v.cloudSync)) invalid();
  if (v.contentSync !== undefined && !isContentSyncState(v.contentSync)) invalid();
  if (v.resources !== undefined) {
    if (!object(v.resources) || v.resources.version !== 1 || !Array.isArray(v.resources.items) || v.resources.items.length > 10000) invalid();
    const keys = new Set<string>();
    for (const item of v.resources.items) {
      if (!isResourceMapping(item)) invalid();
      const key = JSON.stringify([item.tag, item.attribute, item.value]);
      if (keys.has(key)) invalid();
      keys.add(key);
    }
  }
  const p = v.pendingWrite;
  if (p !== undefined && (!object(p) || !text(p.id) || !p.id || !text(p.beforeXML) || !date(p.startedAt) ||
    (p.createdDocument !== undefined && p.createdDocument !== true) ||
    p.beforeHash !== await sha256(p.beforeXML) || p.afterHash !== await sha256(d.xml))) invalid('未完成保存的恢复信息不正确，请保留原文件。');
  return value as StoredBrowserReview;
}
