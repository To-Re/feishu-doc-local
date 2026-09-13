import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReview, type Anchor, type AnchorTarget, type Review } from '../src/core/types';
import { openLocalFile, validateReview } from '../src/server/files';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const xml = '<whiteboard token="public-test-board"/><p>原文</p>';
const target: AnchorTarget = { kind: 'whiteboard-component', board: 'token:public-test-board', id: 'node-review', label: '人类评审' };
const anchor: Anchor = { from: 0, to: 1, quote: '【白板节点：人类评审】', state: 'attached', target };
function reviewWithTarget(value: unknown = target): Review {
  return { ...createReview('article.xml', xml), comments: [
    { id: 'legacy', author: '我', body: '旧文本评论', createdAt: '2026-09-12T00:00:00Z', status: 'resolved', replies: [], anchor: { from: 2, to: 4, quote: '原文', state: 'attached' } },
    { id: 'component', author: '我', body: '说明此节点', createdAt: '2026-09-12T00:00:00Z', status: 'open', replies: [], anchor: { ...anchor, target: value as AnchorTarget } },
  ] };
}

describe('whiteboard component comment files', () => {
  it('accepts legacy comments and validates only the supported optional component target format', () => {
    expect(validateReview(reviewWithTarget(), 'article.xml').comments[1].anchor.target).toEqual(target);
    const legacy = reviewWithTarget(); delete legacy.comments[1].anchor.target;
    expect(validateReview(legacy, 'article.xml').comments[1].anchor).not.toHaveProperty('target');
    for (const state of ['deleted', 'unverified'] as const) {
      const review = reviewWithTarget(); review.comments[1].anchor = { ...anchor, from: 0, to: 0, state };
      expect(validateReview(review, 'article.xml').comments[1].anchor.target).toEqual(target);
    }
  });

  it.each([
    null, [], 'node-review', {},
    { ...target, kind: 'text' }, { ...target, board: undefined }, { ...target, board: '' },
    { ...target, board: ' '.repeat(5) }, { ...target, board: 'x'.repeat(4097) }, { ...target, board: 'token:a\nb' },
    { ...target, id: '' }, { ...target, id: 42 }, { ...target, id: 'node review' }, { ...target, id: 'node\u0000review' },
    { ...target, id: 'x'.repeat(513) }, { ...target, label: 1 }, { ...target, coordinates: [10, 20] },
  ])('rejects malformed component metadata without accepting guessed alternate target shapes: %#', value => {
    expect(() => validateReview(reviewWithTarget(value), 'article.xml')).toThrow(/白板节点评论/);
  });

  it('rejects attached component targets that span text or multiple atoms', () => {
    for (const to of [0, 2, 10]) {
      const review = reviewWithTarget(); review.comments[1].anchor.to = to;
      expect(() => validateReview(review, 'article.xml')).toThrow(/白板节点评论/);
    }
  });

  it('preserves node identity and legacy comments in the real sidecar across saves and a fresh reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lark-review-components-')); folders.push(folder);
    const path = join(folder, 'article.xml'); await writeFile(path, xml);
    const file = await openLocalFile(path); const before = await file.read();
    const review = reviewWithTarget(); const saved = await file.save(xml, review, before.revision);
    const raw = JSON.parse(await readFile(join(folder, 'article.review.json'), 'utf8'));
    expect(raw).toEqual(review);
    expect(raw.comments[0].anchor).not.toHaveProperty('target');
    expect(raw.comments[1].anchor.target).toEqual(target);
    expect(await (await openLocalFile(path)).read()).toEqual(saved);

    const changedXML = xml + '<p>后续修改</p>';
    const changed = { ...review, document: { ...review.document, xml: changedXML } };
    const after = await file.save(changedXML, changed, saved.revision);
    expect((await (await openLocalFile(path)).read()).review).toEqual(changed);
    expect(await readFile(path, 'utf8')).toBe(after.review!.document.xml);
  });

  it('retains target metadata when recovering an interrupted XML and sidecar write', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lark-review-components-recovery-')); folders.push(folder);
    const path = join(folder, 'article.xml'); await writeFile(path, xml);
    const file = await openLocalFile(path, { afterSource: async () => { throw new Error('test write interrupted'); } });
    const before = await file.read(); const review = reviewWithTarget();
    const changedXML = xml + '<p>新正文</p>'; review.document.xml = changedXML;
    await expect(file.save(changedXML, review, before.revision)).rejects.toThrow('test write interrupted');
    const recovered = await (await openLocalFile(path)).read();
    expect(recovered.review).toEqual(review);
    expect(recovered.review!.comments[1].anchor.target).toEqual(target);
    expect(await readFile(path, 'utf8')).toBe(recovered.review!.document.xml);
  });
});
