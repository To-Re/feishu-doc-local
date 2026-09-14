import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReview, type Review, type ReviewComment } from '../src/core/types';
import type { CloudComment, CloudSnapshot, CloudTransport } from '../src/core/cloud-types';
import { indexCloudBlocks } from '../src/core/cloud-blocks';
import { openLocalFile } from '../src/server/files';
import { syncCloudComments } from '../src/server/cloud-sync';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const timestamp = '2026-09-12T00:00:00.000Z';
const xml = '<title id="docA">测试</title><whiteboard id="board_block" token="new_board"/>';
const native = (extra: Partial<CloudComment> = {}): CloudComment => ({ id: 'cloud_comment', body: '意见', author: '飞书用户', createdAt: timestamp, status: 'open', quote: '白板', blockId: 'board_block', boardToken: 'new_board', whole: false, replies: [], ...extra });
async function setup(initial: CloudComment[] = [], locals: ReviewComment[] = [], documentXML=xml) {
  const folder = await mkdtemp(join(tmpdir(), 'review-cloud-audit-')); folders.push(folder);
  const path = join(folder, 'draft.xml'); await writeFile(path, documentXML);
  const file = await openLocalFile(path), review = createReview('draft.xml', documentXML); review.comments = locals;
  await file.save(documentXML, review, (await file.read()).revision);
  const remote: CloudSnapshot = { documentId: 'docA', xml:documentXML, comments: structuredClone(initial) };
  const calls: string[] = [];
  const transport: CloudTransport = {
    async read() { return structuredClone(remote); },
    async create(blockId, body) { calls.push('create'); remote.comments.push(native({ id: 'created', blockId, body })); return { id: 'created' }; },
    async reply(commentId, body) {
      calls.push('reply'); const thread = remote.comments.find(c => c.id === commentId)!;
      // Official drive +add-reply explicitly excludes whole and solved threads.
      if (thread.whole || thread.status === 'resolved') throw new Error('API rejects replies for this comment state');
      thread.replies.push({ id: 'sent_reply', body, author: '我', createdAt: timestamp }); return { id: 'sent_reply' };
    },
    async resolve(commentId, solved) { calls.push(solved ? 'resolve' : 'restore'); remote.comments.find(c => c.id === commentId)!.status = solved ? 'resolved' : 'open'; },
  };
  const connection = { localPath: file.path, documentId: 'docA', url: 'https://example.feishu.cn/docx/docA', transport };
  const run = async () => syncCloudComments(file, (await file.read()).revision, connection);
  const edit = async (mutate: (review: Review) => void) => { const before = await file.read(), next = structuredClone(before.review!); mutate(next); await file.save(before.xml, next, before.revision); };
  return { file, remote, calls, run, edit };
}

describe('cloud sync independent protocol and identity audit', () => {
  it('keeps the exact quote attached when the cloud block reference names its callout ancestor', async () => {
    const textXML='<title id="docA">测试</title><callout id="callout"><p id="paragraph">使用方法：用每节内容检查。</p></callout>';
    const t=await setup([native({quote:'方法：用每节',blockId:'callout',boardToken:undefined,status:'resolved'})],[],textXML);
    const paragraph=indexCloudBlocks(textXML).find(block=>block.id==='paragraph')!;
    const first=await t.run(),again=await t.run();
    expect(first.report.issues).toEqual([]);expect(again.report.issues).toEqual([]);
    expect(first.snapshot.review!.comments[0].anchor).toEqual({from:paragraph.from+3,to:paragraph.from+9,quote:'方法：用每节',state:'attached'});
    expect(again.snapshot.review!.comments[0]).toEqual(first.snapshot.review!.comments[0]);
    expect(t.calls).toEqual([]);
  });

  it('repairs a saved broad import on sync while retaining refreshed raw data, replies and resolved status', async () => {
    const textXML='<title id="docA">测试</title><callout id="callout"><p id="paragraph">检查标题层级与字号关系。</p></callout>';
    const t=await setup([native({quote:'题层级与',blockId:'callout',boardToken:undefined,status:'resolved',raw:{generation:1},
      replies:[{id:'remote-reply',body:'保留云端回复',author:'作者',createdAt:timestamp}]})],[],textXML);
    const first=await t.run(),exact=first.snapshot.review!.comments[0].anchor;
    const callout=indexCloudBlocks(textXML).find(block=>block.id==='callout')!;
    await t.edit(review=>{review.comments[0].anchor={...exact,from:callout.from+1,to:callout.to-1};});
    t.remote.comments[0].raw={generation:2,relation:{metadata:'preserve me'}};
    const result=await t.run(),saved=await t.file.read();
    expect(result.report.issues).toEqual([]);
    expect(saved.review!.comments[0]).toEqual(first.snapshot.review!.comments[0]);
    expect(saved.review!.cloudSync!.links[0].remote).toEqual(t.remote.comments[0]);
    expect(saved.xml).toBe(textXML);expect(t.calls).toEqual([]);
  });

  it('does not accept a matching ancestor quote when the remote block identity changed', async () => {
    const textXML='<title id="docA">测试</title><callout id="callout"><p id="paragraph">方法：用每节内容检查。</p></callout>';
    const t=await setup([native({quote:'方法：用每节',blockId:'callout',boardToken:undefined})],[],textXML);
    await t.run();t.remote.xml=textXML.replace('id="callout"','id="replacement"');
    const result=await t.run();
    expect(result.snapshot.review!.comments[0].anchor.state).toBe('unverified');
    expect(result.report.issues.join()).toContain('位置待确认');expect(t.calls).toEqual([]);
  });

  it('does not send an old component comment to a replacement board that now occupies the same block', async () => {
    const block = indexCloudBlocks(xml).find(b => b.id === 'board_block')!;
    const comment: ReviewComment = { id: 'old_node', body: '针对旧画板的意见', author: '我', createdAt: timestamp, status: 'open', replies: [],
      anchor: { from: block.from, to: block.to, quote: '旧节点', state: 'attached', target: { kind: 'whiteboard-component', board: 'token:old_board', id: 'node_1' } } };
    const t = await setup([], [comment]); const result = await t.run();
    expect(t.calls).toEqual([]);
    expect(result.report.created).toBe(0);
    expect(result.report.issues.length).toBeGreaterThan(0);
    expect(result.snapshot.review!.comments[0].body).toBe(comment.body);
  });

  it('restores a resolved thread before sending the local reply added while reopening it', async () => {
    const t = await setup([native({ status: 'resolved' })]); await t.run();
    await t.edit(review => { review.comments[0].status = 'open'; review.comments[0].replies.push({ id: 'local_reply', body: '重新打开并补充', author: '我', createdAt: timestamp }); });
    const result = await t.run();
    expect(t.calls).toEqual(['restore', 'reply']);
    expect(result.snapshot.review!.cloudSync!.pending).toBeUndefined();
    expect(t.remote.comments[0].status).toBe('open');
    expect(t.remote.comments[0].replies.map(reply => reply.body)).toEqual(['重新打开并补充']);
  });

  it('keeps replies to whole-document comments local without creating a permanently uncertain write', async () => {
    const t = await setup([native({ whole: true, boardToken: undefined, blockId: undefined })]); await t.run();
    await t.edit(review => { review.comments[0].replies.push({ id: 'local_reply', body: '全文评论的补充', author: '我', createdAt: timestamp }); });
    const result = await t.run();
    expect(t.calls).toEqual([]);
    expect(result.snapshot.review!.cloudSync!.pending).toBeUndefined();
    expect(result.report.issues.length).toBeGreaterThan(0);
    expect(result.snapshot.review!.comments[0].replies[0].body).toBe('全文评论的补充');
  });

  it('invalidates an already imported board comment when the local resource is replaced at the same block position', async () => {
    const t = await setup([native()]); await t.run();
    const before = await t.file.read(), changedXML = before.xml.replace('token="new_board"', 'token="replacement_board"');
    const review = structuredClone(before.review!); review.document.xml = changedXML;
    // A source attribute transaction preserves the atom offset and attached state.
    await t.file.save(changedXML, review, before.revision);
    const result = await t.run();
    expect(t.calls).toEqual([]);
    expect(result.snapshot.review!.comments[0].anchor.state).toBe('unverified');
    expect(result.snapshot.review!.comments[0].body).toBe('意见');
    expect(result.snapshot.xml).toBe(changedXML);
  });

  it.each(['toString', '__proto__'])('treats opaque local reply ID %s as data and records exactly one durable mapping', async localReplyId => {
    const t = await setup([native()]); await t.run();
    await t.edit(review => { review.comments[0].replies.push({ id: localReplyId, body: '合法的本地回复标识', author: '我', createdAt: timestamp }); });
    const first = await t.run();
    expect(t.calls).toEqual(['reply']);
    const mapping = first.snapshot.review!.cloudSync!.links[0].replies;
    expect(Object.hasOwn(mapping, localReplyId)).toBe(true);
    expect(mapping[localReplyId]).toEqual({ cloudId: 'sent_reply', body: '合法的本地回复标识' });
    const again = await t.run();
    expect(t.calls).toEqual(['reply']);
    expect(again.snapshot.review!.comments[0].replies).toHaveLength(1);
    expect(t.remote.comments[0].replies).toHaveLength(1);
  });
});
