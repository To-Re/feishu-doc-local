// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DraftStore, validateRecovery } from '../src/drafts';
import type { EditorRecovery } from '../../src/browser/host';
import { createReview } from '../../src/core/types';

beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
const path='articles/稿件.xml';
function draft(overrides:Partial<EditorRecovery>={}):EditorRecovery{return{format:'feishu-editor-draft',version:1,path,xml:'<p>有效正文</p>',review:createReview('稿件.xml','<p>有效正文</p>'),revision:'r1',dirty:true,pending:null,comment:'未发评论',replies:{reply:'未发回复'},invalidSource:{value:'<p>未闭合',error:'XML'},formula:[['formula',{value:'x+1',revision:'x'}]],whiteboard:[],...overrides};}

it('normal reopening creates a separate session and only explicit selection restores a draft',async()=>{
  const save=vi.fn(async(_value:unknown)=>{}),store=new DraftStore(save),first=await store.open(path);await first.write(draft());first.close();
  const normal=await store.open(path);expect(normal.recovery).toBeNull();expect(normal.id).not.toBe(first.id);await normal.write(null);normal.close();
  const restored=await store.open(path,first.id);expect(restored.recovery).toEqual(draft({review:restored.recovery!.review}));
  expect(store.list()).toHaveLength(1);await expect(store.open(path,first.id)).rejects.toThrow('另一页签');restored.close();
});
it('same-document view sessions cannot clear each other and close forbids late writes',async()=>{
  const store=new DraftStore(async()=>{}),a=await store.open(path),b=await store.open(path);
  await Promise.all([a.write(draft({comment:'A'})),b.write(draft({comment:'B'}))]);await a.write(null);a.close();
  expect(store.list().map(record=>record.id)).toEqual([b.id]);expect((await store.get(b.id)).comment).toBe('B');await expect(a.write(draft())).rejects.toThrow('已关闭');
});
it('failed storage leaves the last durable record and later writes can retry',async()=>{
  let fail=false;const store=new DraftStore(async()=>{if(fail)throw new Error('磁盘已满');}),session=await store.open(path);
  await session.write(draft({comment:'已保留'}));fail=true;await expect(session.write(null)).rejects.toThrow('磁盘已满');expect((await store.get(session.id)).comment).toBe('已保留');
  fail=false;await session.write(draft({comment:'重试成功'}));expect((await store.get(session.id)).comment).toBe('重试成功');
});
it('validates all UI recovery fields while preserving malformed original records',async()=>{
  const save=vi.fn(async(_value:unknown)=>{}),store=new DraftStore(save),value=draft();store.load({version:1,drafts:{bad:{path,updatedAt:1,value:{...value,replies:[]}}}});
  await expect(store.open(path,'bad')).rejects.toThrow('格式无效');expect(store.list()).toHaveLength(1);expect(save).not.toHaveBeenCalled();
  for(const invalid of [{pending:{from:-1,to:0,quote:'',state:'attached'}},{formula:[['x',{value:1,revision:'a'}]]},{invalidSource:{value:1,error:'x'}},{dirty:'yes'}])await expect(validateRecovery({...value,...invalid},path)).rejects.toThrow();
});
it('moves all closed sessions together and keeps prior paths and source drafts intact',async()=>{
  const save=vi.fn(async(_value:unknown)=>{}),store=new DraftStore(save),a=await store.open(path),b=await store.open(path);await a.write(draft());await b.write(draft({comment:'B'}));
  await expect(store.relocate(path,'moved/新稿.xml')).rejects.toThrow('全部页签');a.close();b.close();await store.relocate(path,'moved/新稿.xml');
  const recovered=await store.open('moved/新稿.xml',a.id);expect(recovered.recovery!.path).toBe('moved/新稿.xml');expect(recovered.recovery!.review.document.name).toBe('新稿.xml');
  expect(recovered.recovery!.invalidSource).toEqual(draft().invalidSource);expect(recovered.recovery!.formula).toEqual(draft().formula);
  expect(save.mock.calls.at(-1)![0]).toMatchObject({drafts:{[a.id]:{previousPaths:[path]}}});
});
it('cannot discard a live draft; explicit discard removes only recovery metadata',async()=>{
  const store=new DraftStore(async()=>{}),session=await store.open(path);await session.write(draft());await expect(store.discard(session.id)).rejects.toThrow('仍在编辑');
  session.close();await store.discard(session.id);expect(store.list()).toEqual([]);
});
it('rejects cross-document recovery and unsafe paths without consuming the record',async()=>{
  const store=new DraftStore(async()=>{}),session=await store.open(path);await session.write(draft());session.close();
  await expect(store.open('other.xml',session.id)).rejects.toThrow('不匹配');await expect(store.open('../private.xml')).rejects.toThrow('库内');
  expect(store.list()).toHaveLength(1);
});
