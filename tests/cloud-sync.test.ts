import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openLocalFile} from '../src/server/files';
import {syncCloudComments} from '../src/server/cloud-sync';
import {createReview,type ReviewComment} from '../src/core/types';
import type {CloudComment,CloudSnapshot,CloudTransport} from '../src/core/cloud-types';
import {indexCloudBlocks} from '../src/core/cloud-blocks';

const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
const xml='<title id="docA">测试</title><p id="p1">前文😀</p><whiteboard id="board-block" token="board-token"/><p id="p2">后文</p>';
const timestamp='2026-09-12T00:00:00Z';
function cloudComment(id='remote'):CloudComment{return {id,body:'云端意见',author:'飞书用户',createdAt:timestamp,status:'open',quote:'本地初稿',boardToken:'board-token',blockId:'board-block',replies:[],raw:{parent_type:'WHITEBOARD_BLOCK'}};}
function localComment(id='local'):ReviewComment {const board=indexCloudBlocks(xml).find(block=>block.id==='board-block')!;return {id,body:'本地意见',author:'我',createdAt:timestamp,status:'open',replies:[],anchor:{from:board.from,to:board.to,quote:'【白板节点：本地初稿】',state:'attached',target:{kind:'whiteboard-component',board:'token:board-token',id:'o1:1',label:'本地初稿'}}};}
async function setup(initial:CloudComment[]=[],local:ReviewComment[]=[]){
  const folder=await mkdtemp(join(tmpdir(),'review-sync-'));folders.push(folder);
  const path=join(folder,'article.xml');await writeFile(path,xml);
  const file=await openLocalFile(path);const review=createReview('article.xml',xml);review.comments=local;
  await file.save(xml,review,(await file.read()).revision);
  const remote:CloudSnapshot={documentId:'docA',xml,comments:structuredClone(initial)};
  const calls:string[]=[];let sequence=0;
  const transport:CloudTransport={
    async read(){calls.push('read');return structuredClone(remote);},
    async create(blockId,body){calls.push('create');const id='created-'+(++sequence);remote.comments.push({...cloudComment(id),body,blockId});return {id};},
    async reply(id,body){calls.push('reply');const replyId='reply-'+(++sequence);remote.comments.find(c=>c.id===id)!.replies.push({id:replyId,body,author:'我',createdAt:timestamp});return {id:replyId};},
    async resolve(id,solved){calls.push('resolve');remote.comments.find(c=>c.id===id)!.status=solved?'resolved':'open';},
  };
  const connection={localPath:file.path,documentId:'docA',url:'https://example.feishu.cn/docx/docA',transport};
  const run=async()=>syncCloudComments(file,(await file.read()).revision,connection);
  const edit=async(fn:(r:ReturnType<typeof createReview>)=>void)=>{const s=await file.read(),r=structuredClone(s.review!);fn(r);return file.save(s.xml,r,s.revision);};
  return {file,path,remote,calls,transport,connection,run,edit};
}

describe('durable whole-board comment sync',()=>{
  it('pulls native component comments to their board and pushes local component context once without changing XML',async()=>{
    const t=await setup([cloudComment()],[localComment()]);const result=await t.run();
    expect(result.report.issues).toEqual([]);expect(result.report.created).toBe(1);
    expect(t.remote.comments[1]).toMatchObject({blockId:'board-block',body:'针对图中「本地初稿」：\n本地意见'});
    const imported=result.snapshot.review!.comments.find(c=>c.id.startsWith('cloud:'))!;
    expect(imported.anchor).not.toHaveProperty('target');expect(imported.anchor.quote).toBe('【白板】本地初稿');
    const board=indexCloudBlocks(xml).find(b=>b.id==='board-block')!;expect(imported.anchor.from).toBe(board.from);
    const again=await t.run();expect(again.report.created).toBe(0);expect(again.report.imported).toBe(0);
    expect(t.calls.filter(c=>c==='create')).toHaveLength(1);expect(await readFile(t.path,'utf8')).toBe(xml);
    expect(again.snapshot.review!.cloudSync!.links).toHaveLength(2);
  });
  it('syncs replies and resolved/restored states without re-creating or echoing imported replies',async()=>{
    const remote=cloudComment();remote.replies.push({id:'cloud-r1',body:'云端回复',author:'飞书用户',createdAt:timestamp});
    const t=await setup([remote]);await t.run();
    await t.edit(r=>{r.comments[0].replies.push({id:'my-r',body:'本地答复',author:'我',createdAt:timestamp});r.comments[0].status='resolved';});
    const saved=await t.run();expect(saved.report.replies).toBe(1);expect(saved.report.resolved).toBe(1);
    expect(t.remote.comments[0].status).toBe('resolved');expect(t.remote.comments[0].replies).toHaveLength(2);
    await t.run();expect(t.calls.filter(c=>c==='reply')).toHaveLength(1);
    t.remote.comments[0].status='open';t.remote.comments[0].replies.push({id:'cloud-r2',body:'再补一句',author:'飞书用户',createdAt:timestamp});
    const pulled=await t.run();expect(pulled.snapshot.review!.comments[0].status).toBe('open');expect(pulled.snapshot.review!.comments[0].replies).toHaveLength(3);
    expect(t.calls.filter(c=>c==='resolve')).toHaveLength(1);
  });
  it('durably records an uncertain create and never resends on a new run or process',async()=>{
    const t=await setup([],[localComment()]);const create=t.transport.create;
    t.transport.create=async(...args)=>{await create(...args);throw new Error('response lost');};
    const result=await t.run();expect(result.report.issues.join()).toContain('未确认');expect(result.snapshot.review!.cloudSync!.pending?.kind).toBe('create');
    expect(t.remote.comments).toHaveLength(1);
    const reopened=await openLocalFile(t.path);const again=await syncCloudComments(reopened,(await reopened.read()).revision,t.connection);
    expect(again.report.issues.join()).toContain('不会重复发送');expect(t.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it('refuses stale revisions and partial cloud reads before making any write',async()=>{
    const t=await setup([],[localComment()]);await expect(syncCloudComments(t.file,'old',t.connection)).rejects.toThrow(/变化/);
    const before=await readFile(t.file.reviewPath,'utf8');t.transport.read=async()=>{throw new Error('page two failed');};
    await expect(t.run()).rejects.toThrow(/未完整读到/);expect(t.calls).toEqual([]);expect(await readFile(t.file.reviewPath,'utf8')).toBe(before);
  });
  it('uses a shared on-disk lock across file handles to refuse duplicate concurrent runs',async()=>{
    const t=await setup([],[localComment()]);let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const read=t.transport.read;t.transport.read=async()=>{entered();await gate;return read();};
    const first=t.run();await ready;
    const other=await openLocalFile(t.path);await expect(syncCloudComments(other,(await other.read()).revision,t.connection)).rejects.toThrow(/正在同步/);
    release();await first;expect(t.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it('preserves external file edits made during a cloud write and stops the remainder',async()=>{
    const t=await setup([],[localComment(),localComment('second')]);const create=t.transport.create;
    t.transport.create=async(...args)=>{const result=await create(...args);await t.edit(r=>{r.comments[0].body='同步中追加的新意见';});return result;};
    const result=await t.run();expect(result.report.created).toBe(1);expect(result.report.issues.join()).toContain('同步期间');
    expect(result.snapshot.review!.comments[0].body).toBe('同步中追加的新意见');expect(result.snapshot.review!.cloudSync!.links[0].body).toBe('本地意见');
    expect(t.calls.filter(c=>c==='create')).toHaveLength(1);expect(result.snapshot.review!.cloudSync!.pending).toBeUndefined();
  });
  it('retains deleted or unmapped comments without guessing another board or recreating remote comments',async()=>{
    const bad=localComment();bad.anchor.state='unverified';const t=await setup([cloudComment()],[bad]);
    const result=await t.run();expect(result.report.created).toBe(0);expect(result.report.issues).not.toHaveLength(0);
    await t.edit(r=>{r.comments=r.comments.filter(c=>c.id==='local');});
    await t.run();expect(t.calls).not.toContain('create');expect((await t.file.read()).review!.comments).toHaveLength(1);
  });
  it('rejects a different document binding even when block ids and labels are identical',async()=>{
    const t=await setup([],[localComment()]);t.remote.documentId='other';await expect(t.run()).rejects.toThrow(/关联目标/);
    expect(t.calls).toEqual(['read']);
  });
});
