import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,realpath,writeFile,readFile,readdir,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SyncService} from '../src/service';
import {createReview} from '../../src/core/types';
import {openLocalFile} from '../../src/server/files';
import {openProjectStore} from '../../src/server/projects';
import type {ContentCLIRunner} from '../../src/server/content-cli';
const folders:string[]=[];const url='https://example.feishu.cn/docx/Doc';
const ok=(data:unknown)=>JSON.stringify({ok:true,data});
const get=(args:readonly string[],name:string)=>args[args.indexOf(name)+1];
afterEach(async()=>{await Promise.all(folders.splice(0).map(folder=>rm(folder,{recursive:true,force:true})));});
async function fixture(xml='<title>本地稿</title><p>正文</p>'){
  const root=await realpath(await mkdtemp(join(tmpdir(),'obsidian-sync-')));folders.push(root);const path=join(root,'draft.xml');await writeFile(path,xml);
  let cloudXML='<title id="Doc">目标</title><p id="P">旧正文</p>',revision=1;
  const calls:string[][]=[];let failUpdate=false,failCreate=false;
  const runner:ContentCLIRunner=async(command,args)=>{expect(command).toBe('/configured/lark-cli');calls.push([...args]);expect(args.slice(-2)).toEqual(['--format','json']);
    if(args.includes('+fetch'))return ok({document:{document_id:'Doc',content:cloudXML,revision_id:revision,url}});
    if(args.includes('+update')){if(failUpdate)throw new Error('mock failure');cloudXML='<title id="Doc">本地稿</title><p id="newP">正文</p>';revision++;return ok({result:'success'});}
    if(args.includes('+create')){if(failCreate)throw new Error('uncertain mock create');cloudXML='<title id="Doc">本地稿</title><p id="newP">正文</p>';return ok({document:{document_id:'Doc',url}});}
    if(args.includes('+list-comments'))return ok({file_token:'Doc',file_type:'docx',items:[],has_more:false,page_token:''});
    if(args.includes('+add-comment'))return ok({comment_id:'new_comment',file_token:'Doc'});
    throw new Error('unexpected mock command');
  };
  const service=new SyncService({vaultRoot:root,catalogPath:join(root,'config/projects.json'),profile:{command:'/configured/lark-cli',args:[]},runner});
  return {service,root,path,xml,calls,get cloudXML(){return cloudXML;},set cloudXML(v:string){cloudXML=v;revision++;},set failUpdate(v:boolean){failUpdate=v;},set failCreate(v:boolean){failCreate=v;}};
}
describe('optional Obsidian sync uses the same checked protocol and files',()=>{
  it('makes no CLI calls at construction, local inspection, or pure-local registration',async()=>{const t=await fixture();expect(t.calls).toEqual([]);expect(await t.service.project(t.path)).toBeUndefined();await t.service.bind(t.path,{kind:'none'},'push');expect((await t.service.project(t.path))?.cloud).toBeUndefined();expect(t.calls).toEqual([]);expect(await readFile(t.path,'utf8')).toBe(t.xml);});
  it('binds an existing target without adopting either body',async()=>{const t=await fixture();await t.service.bind(t.path,{kind:'existing',url},'pull');expect(t.calls.every(args=>args.includes('+fetch'))).toBe(true);expect(await readFile(t.path,'utf8')).toBe(t.xml);expect(t.cloudXML).toContain('旧正文');await expect(t.service.bind(t.path,{kind:'existing',url},'pull')).rejects.toThrow('已经关联');});
  it('binds an existing cloud document after a pure-local project',async()=>{const t=await fixture();const local=await t.service.bind(t.path,{kind:'none'},'push');const result=await t.service.bind(t.path,{kind:'existing',url},'pull');expect(result.project.id).toBe(local.project.id);expect(result.project.cloud?.documentId).toBe('Doc');expect(await readFile(t.path,'utf8')).toBe(t.xml);});
  it('publishes then adopts verified cloud IDs while keeping the original archive',async()=>{const t=await fixture();await t.service.bind(t.path,{kind:'existing',url},'push');const prepared=await t.service.preview(t.path,'push');expect(t.calls.some(args=>args.includes('+update'))).toBe(false);const result=await t.service.apply(t.path,prepared);expect(result.snapshot.xml).toBe(t.cloudXML);expect(await readFile(t.path,'utf8')).toBe(t.cloudXML);expect(result.snapshot.review?.contentSync?.localXML).toBe(t.cloudXML);expect(result.snapshot.review?.contentSync?.cloudXML).toBe(t.cloudXML);expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();
    const history=join(t.root,'.review-sync-history'),entries=await readdir(history);expect(entries).toHaveLength(1);expect(await readFile(join(history,entries[0],'local.xml'),'utf8')).toBe(t.xml);expect(await readFile(join(history,entries[0],'cloud.xml'),'utf8')).toBe(t.cloudXML);
    const next=await t.service.preview(t.path,'push');expect(next.view.status).toBe('equal');await t.service.apply(t.path,next);expect(t.calls.filter(args=>args.includes('+update'))).toHaveLength(1);
  });
  it('rejects a stale local preview without losing a newer AI edit',async()=>{const t=await fixture();await t.service.bind(t.path,{kind:'existing',url},'push');const preview=await t.service.preview(t.path,'push');const newer='<p>AI newer draft</p>';await writeFile(t.path,newer);await expect(t.service.apply(t.path,preview)).rejects.toThrow('变化');expect(await readFile(t.path,'utf8')).toBe(newer);expect(t.calls.some(args=>args.includes('+update'))).toBe(false);});
  it('rejects changed cloud state between preview and confirmation',async()=>{const t=await fixture();await t.service.bind(t.path,{kind:'existing',url},'push');const preview=await t.service.preview(t.path,'push');t.cloudXML='<title id="Doc">云端新稿</title>';await expect(t.service.apply(t.path,preview)).rejects.toThrow('变化');expect(t.calls.some(args=>args.includes('+update'))).toBe(false);expect(await readFile(t.path,'utf8')).toBe(t.xml);});
  it('keeps pending publication and refuses a blind retry after an uncertain write',async()=>{const t=await fixture();await t.service.bind(t.path,{kind:'existing',url},'push');const preview=await t.service.preview(t.path,'push');t.failUpdate=true;await expect(t.service.apply(t.path,preview)).rejects.toThrow('未能完整确认');const review=JSON.parse(await readFile(t.path.replace('.xml','.review.json'),'utf8'));expect(review.contentSync.pending.direction).toBe('push');expect(await readFile(t.path,'utf8')).toBe(t.xml);await expect(t.service.preview(t.path,'push')).rejects.toThrow('上次同步');expect(t.calls.filter(args=>args.includes('+update'))).toHaveLength(1);});
  it('creates a new document once and adopts the cloud body with an original archive',async()=>{const t=await fixture();const result=await t.service.bind(t.path,{kind:'new',title:'新建测试'},'push');expect(result.project.cloud?.documentId).toBe('Doc');expect(t.calls.filter(args=>args.includes('+create'))).toHaveLength(1);expect(await readFile(t.path,'utf8')).toBe(t.cloudXML);const history=join(t.root,'.review-sync-history'),entries=await readdir(history);expect(await readFile(join(history,entries[0],'local.xml'),'utf8')).toBe(t.xml);expect(await readdir(t.root)).not.toEqual(expect.arrayContaining([expect.stringContaining('.review-create-')]));});
  it('persists an uncertain create without offering automatic retry',async()=>{const t=await fixture();t.failCreate=true;const result=await t.service.bind(t.path,{kind:'new',title:'新建测试'},'push');expect(result.warning).toContain('未确认');await expect(t.service.bind(t.path,{kind:'new',title:'新建测试'},'push')).rejects.toThrow('尚未确认');expect(t.calls.filter(args=>args.includes('+create'))).toHaveLength(1);expect(await readFile(t.path,'utf8')).toBe(t.xml);});
  it('pulls content only after confirmation, preserving local review text',async()=>{const t=await fixture();const file=await openLocalFile(t.path),review=createReview(file.name,t.xml);review.comments.push({id:'local',body:'保留本地意见',author:'我',createdAt:new Date().toISOString(),status:'open',anchor:{from:1,to:3,quote:'正文',state:'unverified'},replies:[]});await file.save(t.xml,review,(await file.read()).revision);await t.service.bind(t.path,{kind:'existing',url},'pull');const preview=await t.service.preview(t.path,'pull');expect(await readFile(t.path,'utf8')).toBe(t.xml);const applied=await t.service.apply(t.path,preview);expect(applied.snapshot.xml).toBe(t.cloudXML);expect(applied.snapshot.review?.comments[0].body).toBe('保留本地意见');expect(t.calls.some(args=>args.includes('+update'))).toBe(false);});
  it('synchronizes local comments only with verified block IDs',async()=>{const xml='<title id="Doc">文档</title><p id="P">正文</p>';const t=await fixture(xml);t.cloudXML=xml;const file=await openLocalFile(t.path),review=createReview(file.name,xml);review.comments.push({id:'c',body:'具体修改意见',author:'我',createdAt:new Date().toISOString(),status:'open',anchor:{from:5,to:7,quote:'正文',state:'attached'},replies:[]});await file.save(xml,review,(await file.read()).revision);await t.service.bind(t.path,{kind:'existing',url},'push');const result=await t.service.comments(t.path);expect(result.report.created).toBe(1);expect(result.snapshot.review?.cloudSync?.links[0].cloudId).toBe('new_comment');expect(t.calls.some(args=>args.includes('+add-comment'))).toBe(true);});
  it('rejects files outside vault and symlink escapes before calling CLI',async()=>{const t=await fixture(),outside=await realpath(await mkdtemp(join(tmpdir(),'outside-vault-')));folders.push(outside);const path=join(outside,'other.xml');await writeFile(path,'<p/>');await expect(t.service.preview(path,'push')).rejects.toThrow('当前 Obsidian');await symlink(path,join(t.root,'escape.xml'));await expect(t.service.preview(join(t.root,'escape.xml'),'push')).rejects.toThrow('当前 Obsidian');expect(t.calls).toEqual([]);});
  it('refuses work after plugin unload',async()=>{const t=await fixture();t.service.dispose();await expect(t.service.bind(t.path,{kind:'none'},'push')).rejects.toThrow('已卸载');expect(t.calls).toEqual([]);});
});

it('imports cloud threads and round-trips a local reply and resolved status through official commands',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'obsidian-comment-sync-')));folders.push(root);const path=join(root,'review.xml'),xml='<title id="Doc">文档</title><p id="P">正文</p>';await writeFile(path,xml);
  let solved=false;const calls:string[][]=[];const replies=[{reply_id:'root',user_id:'reviewer',create_time:1700000000,content:{elements:[{type:'text_run',text_run:{text:'云端修改意见'}}]}}];
  const page=(items:unknown[],extra:object={})=>ok({file_token:'Doc',file_type:'docx',items,has_more:false,page_token:'',...extra});
  const runner:ContentCLIRunner=async(_command,args)=>{calls.push([...args]);
    if(args.includes('+fetch'))return ok({document:{document_id:'Doc',content:xml,revision_id:1,url}});
    if(args.includes('+list-comments'))return page(get(args,'--comment-scope')==='partial'&&get(args,'--solved-status')===String(solved)?[{comment_id:'cloud1',is_whole:false,is_solved:solved,create_time:1700000000,quote:'正文',anchor:{block_id:'P'}}]:[]);
    if(args.includes('+list-replies'))return page(replies,{comment_id:'cloud1'});
    if(args.includes('+add-reply')){replies.push({reply_id:'sent_reply',user_id:'reviewer',create_time:1700000001,content:{elements:[{type:'text_run',text_run:{text:'本地回复'}}]}});return ok({reply_id:'sent_reply',comment_id:'cloud1',file_token:'Doc'});}
    if(args.includes('+resolve-comment')){solved=true;return ok({comment_id:'cloud1',file_token:'Doc'});}
    if(args.includes('+restore-comment')){solved=false;return ok({comment_id:'cloud1',file_token:'Doc'});}
    throw new Error('unexpected command');
  };
  const service=new SyncService({vaultRoot:root,catalogPath:join(root,'projects.json'),profile:{command:'/configured/lark-cli',args:[]},runner});await service.bind(path,{kind:'existing',url},'push');
  const imported=await service.comments(path);expect(imported.report.imported).toBe(1);expect(imported.snapshot.review?.comments[0].body).toBe('云端修改意见');
  const file=await openLocalFile(path),snapshot=await file.read(),review=structuredClone(snapshot.review!);review.comments[0].replies.push({id:'local_reply',body:'本地回复',author:'我',createdAt:new Date().toISOString()});review.comments[0].status='resolved';await file.save(xml,review,snapshot.revision);
  const sent=await service.comments(path);expect(sent.report.replies).toBe(1);expect(sent.report.resolved).toBe(1);expect(solved).toBe(true);expect(sent.snapshot.review?.cloudSync?.pending).toBeUndefined();
  await service.comments(path);expect(calls.filter(args=>args.includes('+add-reply'))).toHaveLength(1);expect(calls.filter(args=>args.includes('+resolve-comment'))).toHaveLength(1);
  const resolved=await file.read(),reopened=structuredClone(resolved.review!);reopened.comments[0].status='open';await file.save(xml,reopened,resolved.revision);
  const restored=await service.comments(path);expect(restored.report.resolved).toBe(1);expect(solved).toBe(false);expect(calls.filter(args=>args.includes('+restore-comment'))).toHaveLength(1);
  await service.comments(path);expect(calls.filter(args=>args.includes('+restore-comment'))).toHaveLength(1);
});


it('lists, opens and renames local projects without running CLI or editing the article',async()=>{
  const t=await fixture(),registered=await t.service.bind(t.path,{kind:'none'},'push');
  const entries=await t.service.listProjects();expect(entries).toHaveLength(1);expect(entries[0].vaultPath).toBe('draft.xml');
  expect(await t.service.openProject(registered.project.id)).toMatchObject({vaultPath:'draft.xml'});
  await t.service.updateProject(registered.project.id,{name:'成熟稿件',defaultDirection:'pull'});
  expect((await t.service.project(t.path))).toMatchObject({name:'成熟稿件',defaultDirection:'pull'});expect(t.calls).toEqual([]);expect(await readFile(t.path,'utf8')).toBe(t.xml);
});
it('lists outside and escaped registrations disabled and refuses local metadata mutation',async()=>{
  const t=await fixture(),outside=await realpath(await mkdtemp(join(tmpdir(),'obsidian-project-outside-')));folders.push(outside);
  const outsidePath=join(outside,'other.xml');await writeFile(outsidePath,'<p>外部文档</p>');
  await t.service.listProjects();const store=await openProjectStore(join(t.root,'config/projects.json'));
  const registered=await store.register({name:'其他库项目',localPath:outsidePath,defaultDirection:'push'});
  expect((await t.service.listProjects())[0]).toMatchObject({unavailable:expect.stringContaining('不在当前'),project:{id:registered.id}});
  await expect(t.service.openProject(registered.id)).rejects.toThrow('不在当前');await expect(t.service.updateProject(registered.id,{name:'不能改',defaultDirection:'pull'})).rejects.toThrow('不在当前');
  const local=await t.service.bind(t.path,{kind:'none'},'push');await rm(t.path);await symlink(outsidePath,t.path);
  const entry=(await t.service.listProjects()).find(item=>item.project.id===local.project.id)!;expect(entry.vaultPath).toBeUndefined();expect(entry.unavailable).toBeTruthy();
  await expect(t.service.openProject(local.project.id)).rejects.toThrow();expect(t.calls).toEqual([]);expect(await readFile(outsidePath,'utf8')).toBe('<p>外部文档</p>');
});

it('keeps exact local and cloud backup evidence before a confirmed pull',async()=>{
  const t=await fixture(),cloudBefore=t.cloudXML;await t.service.bind(t.path,{kind:'existing',url},'pull');
  const prepared=await t.service.preview(t.path,'pull');expect(await readFile(t.path,'utf8')).toBe(t.xml);
  await t.service.apply(t.path,prepared);expect(await readFile(t.path,'utf8')).toBe(cloudBefore);
  const history=join(t.root,'.review-sync-history'),entries=await readdir(history);expect(entries).toHaveLength(1);
  expect(await readFile(join(history,entries[0],'local.xml'),'utf8')).toBe(t.xml);
  expect(JSON.parse(await readFile(join(history,entries[0],'cloud.json'),'utf8')).xml).toBe(cloudBefore);
  expect(await readFile(join(history,entries[0],'cloud.xml'),'utf8')).toBe(cloudBefore);
  expect(t.calls.some(args=>args.includes('+update'))).toBe(false);
});


async function historicalSidecar(t:Awaited<ReturnType<typeof fixture>>,commentURL?:string){
  const review=createReview('draft.xml',t.xml);
  review.contentSync={version:1,documentId:'Doc',localXML:t.xml,cloudXML:t.cloudXML,cloudRevision:1,syncedAt:new Date().toISOString()};
  if(commentURL)review.cloudSync={version:1,documentId:'Doc',url:commentURL,links:[]};
  const path=t.path.replace('.xml','.review.json');await writeFile(path,JSON.stringify(review,null,2)+'\n');return {review,path,raw:await readFile(path,'utf8')};
}
it('restores saved cloud metadata into an empty catalog without CLI calls or changing source, sidecar or cloud IDs',async()=>{
  const t=await fixture(),sidecar=await historicalSidecar(t,url);expect(await t.service.project(t.path)).toBeUndefined();const saved=await t.service.existingBinding(t.path);
  expect(saved).toMatchObject({documentId:'Doc',url,pending:false});expect(t.calls).toEqual([]);
  const restored=await t.service.restoreBinding(t.path,{revision:saved!.revision,defaultDirection:'pull'});
  expect(restored.cloud).toEqual({documentId:'Doc',url});expect((await t.service.project(t.path))?.id).toBe(restored.id);
  expect(await readFile(t.path,'utf8')).toBe(t.xml);expect(await readFile(sidecar.path,'utf8')).toBe(sidecar.raw);expect(t.calls).toEqual([]);
});
it('requires a matching Docx address when content history has no URL, and refuses unverified Wiki mappings',async()=>{
  const t=await fixture(),sidecar=await historicalSidecar(t);const saved=(await t.service.existingBinding(t.path))!;
  await expect(t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push'})).rejects.toThrow('没有保存飞书地址');
  await expect(t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push',url:'https://example.feishu.cn/docx/Other'})).rejects.toThrow('ID 不一致');
  await expect(t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push',url:'https://example.feishu.cn/wiki/Wiki'})).rejects.toThrow('无法离线核对');
  const restored=await t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push',url});expect(restored.cloud?.documentId).toBe('Doc');
  expect(await readFile(sidecar.path,'utf8')).toBe(sidecar.raw);expect(t.calls).toEqual([]);
});
it('keeps an existing local project ID and pending synchronization records when restoring its known cloud binding',async()=>{
  const t=await fixture(),local=await t.service.bind(t.path,{kind:'none'},'push'),sidecar=await historicalSidecar(t,url);
  sidecar.review.contentSync!.pending={id:'uncertain',direction:'push',startedAt:new Date().toISOString(),sourceXML:t.xml};
  await writeFile(sidecar.path,JSON.stringify(sidecar.review)+'\n');const raw=await readFile(sidecar.path,'utf8'),saved=(await t.service.existingBinding(t.path))!;expect(saved.pending).toBe(true);
  const restored=await t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'pull'});expect(restored.id).toBe(local.project.id);
  expect(await readFile(sidecar.path,'utf8')).toBe(raw);await expect(t.service.preview(t.path,'push')).rejects.toThrow('尚未确认');expect(t.calls).toEqual([]);
});
it('rejects restoration when document identities conflict or a different local project already owns the cloud document',async()=>{
  const t=await fixture(),sidecar=await historicalSidecar(t,url);sidecar.review.cloudSync!.documentId='Other';sidecar.review.cloudSync!.url='https://example.feishu.cn/docx/Other';await writeFile(sidecar.path,JSON.stringify(sidecar.review));
  const conflicted=(await t.service.existingBinding(t.path))!;expect(conflicted.error).toBeTruthy();await expect(t.service.restoreBinding(t.path,{revision:conflicted.revision,defaultDirection:'push'})).rejects.toThrow('不同的飞书');
  await historicalSidecar(t,url);await t.service.listProjects();const other=join(t.root,'other.xml');await writeFile(other,'<p/>');const store=await openProjectStore(join(t.root,'config/projects.json'));
  const registered=await store.register({name:'已有项目',localPath:other,defaultDirection:'push',cloud:{documentId:'Doc',url}}),saved=(await t.service.existingBinding(t.path))!;
  await expect(t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push'})).rejects.toThrow('已经属于另一个项目');
  expect((await store.list()).map(project=>project.id)).toEqual([registered.id]);expect(await readFile(t.path,'utf8')).toBe(t.xml);expect(t.calls).toEqual([]);
});
it('rejects stale restoration after an AI modifies the sidecar and rejects outside-vault documents',async()=>{
  const t=await fixture(),sidecar=await historicalSidecar(t,url),saved=(await t.service.existingBinding(t.path))!;
  sidecar.review.document.updatedAt=new Date(Date.now()+1000).toISOString();await writeFile(sidecar.path,JSON.stringify(sidecar.review));
  await expect(t.service.restoreBinding(t.path,{revision:saved.revision,defaultDirection:'push'})).rejects.toThrow('已变化');expect(await t.service.project(t.path)).toBeUndefined();
  const outside=await fixture();await expect(t.service.existingBinding(outside.path)).rejects.toThrow('当前 Obsidian');expect(t.calls).toEqual([]);
});

it('creates and adopts a cloud document for an already registered local project',async()=>{
  const t=await fixture(),local=await t.service.bind(t.path,{kind:'none'},'push');
  const bound=await t.service.bind(t.path,{kind:'new',title:'本地项目发布'},'push');
  expect(bound.project.id).toBe(local.project.id);expect(await readFile(t.path,'utf8')).toBe(t.cloudXML);
  const snapshot=await(await openLocalFile(t.path)).read();expect(snapshot.review?.contentSync?.localXML).toBe(t.cloudXML);expect(snapshot.review?.contentSync?.pending).toBeUndefined();
  const history=join(t.root,'.review-sync-history'),entries=await readdir(history);expect(await readFile(join(history,entries[0],'local.xml'),'utf8')).toBe(t.xml);
  expect(t.calls.filter(args=>args.includes('+create'))).toHaveLength(1);
});
