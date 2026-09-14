import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,writeFile,readFile,readdir,rm,unlink,symlink,chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReview,type Review} from '../src/core/types';
import type {CloudComment,CloudTransport} from '../src/core/cloud-types';
import {openLocalFile} from '../src/server/files';
import {saveContentEvidence} from '../src/server/content-sync';
import {prepareContentRestore,applyContentRestore} from '../src/server/content-history';
import {syncCloudComments} from '../src/server/cloud-sync';

const folders:string[]=[];
const oldXML='<title id="Doc">测试稿</title><p id="P">旧正文</p>',newXML=oldXML.replace('旧正文','当前正文');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHXsAAAAASUVORK5CYII=','base64');
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
const comment=(id:string)=>({id,body:`意见 ${id}`,author:'我',createdAt:'2026-09-14T00:00:00Z',status:'open' as const,anchor:{from:1,to:2,quote:'旧',state:'attached' as const},replies:[]});
async function setup(options:{resources?:boolean;review?:Review|null}={}){
  const folder=await realpath(await mkdtemp(join(tmpdir(),'review-history-')));folders.push(folder);
  const path=join(folder,'article.xml'),history=join(folder,'history');
  const xml=oldXML+(options.resources?'<img path="@./original.png"/><whiteboard token="board"/>':'');
  await writeFile(path,xml);const file=await openLocalFile(path);
  const review=options.review===undefined?createReview('article.xml',xml):options.review;
  if(review){
    if(options.review===undefined)review.comments=[comment('old')];
    if(options.resources){review.resources={version:1,items:[{tag:'whiteboard',attribute:'token',value:'board',path:'board.png',representation:'preview'}]};await writeFile(join(folder,'original.png'),png);await writeFile(join(folder,'board.png'),png);}
    await file.save(xml,review,(await file.read()).revision);
  }
  const before=await file.read(),evidence=await saveContentEvidence(history,before,undefined,path);
  const currentReview=structuredClone(before.review||createReview('article.xml',newXML));currentReview.document.xml=newXML;
  currentReview.comments.push(comment('new'));
  currentReview.contentSync={version:1,documentId:'Doc',localXML:newXML,cloudXML:newXML,cloudRevision:2,syncedAt:'2026-09-14T01:00:00Z'};
  currentReview.operations.push({id:'sync',type:'content.pull',author:'我',at:'2026-09-14T01:00:00Z',summary:`从飞书拉取正文与资源；双方备份：${evidence}`});
  const current=await file.save(newXML,currentReview,before.revision);
  return {folder,path,file,history,evidence,before,current};
}

describe('local snapshot restoration with real files and no CLI',()=>{
  it('previews without writes, restores archived comments/resources and can undo using the newly archived current version',async()=>{
    const t=await setup({resources:true}),files=await readdir(t.history);
    const prepared=await prepareContentRestore(t.file,t.current.revision,t.history);
    expect(prepared.view).toMatchObject({localPath:t.path,snapshotPath:t.evidence,localXML:newXML,snapshotXML:t.before.xml});
    expect(await t.file.read()).toEqual(t.current);expect(await readdir(t.history)).toEqual(files);
    const result=await applyContentRestore(t.file,prepared,t.history);
    expect(result.snapshot.xml).toBe(t.before.xml);expect(result.snapshot.review?.comments).toHaveLength(1);
    expect(result.snapshot.review?.comments[0]).toMatchObject({id:'old',anchor:{state:'unverified'}});
    expect(result.snapshot.review?.resources).toEqual(t.before.review?.resources);
    expect(result.snapshot.review?.contentSync).toEqual(t.current.review?.contentSync);
    expect(await readFile(join(t.folder,'original.png'))).toEqual(png);expect(await readFile(join(t.folder,'board.png'))).toEqual(png);
    const backup=(await readdir(t.history)).find(name=>!files.includes(name))!;
    expect(await readFile(join(t.history,backup,'local.xml'),'utf8')).toBe(t.current.xml);
    expect(JSON.parse(await readFile(join(t.history,backup,'local.review.json'),'utf8'))).toEqual(t.current.review);
    const reopened=await openLocalFile(t.path),undo=await prepareContentRestore(reopened,result.snapshot.revision,t.history);
    expect(undo.view.snapshotPath).toBe(join(t.history,backup));
    const undone=await applyContentRestore(reopened,undo,t.history);
    expect(undone.snapshot.xml).toBe(t.current.xml);expect(undone.snapshot.review?.comments.map(c=>c.id)).toEqual(['old','new']);
    expect(undone.snapshot.review?.contentSync).toEqual(t.current.review?.contentSync);
  });

  it('can restore an original without a review sidecar without dropping current cloud baselines',async()=>{
    const t=await setup({review:null}),preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    const restored=await applyContentRestore(t.file,preview,t.history);
    expect(restored.snapshot.xml).toBe(t.before.xml);expect(restored.snapshot.review?.comments).toEqual([]);
    expect(restored.snapshot.review?.contentSync).toEqual(t.current.review?.contentSync);
  });

  it('can restore a web snapshot in Obsidian and undo from the web using only explicitly configured history roots',async()=>{
    const t=await setup(),obsidianHistory=join(t.folder,'.review-sync-history');
    const obsidianPreview=await prepareContentRestore(t.file,t.current.revision,obsidianHistory,[t.history]);
    expect(obsidianPreview.view.snapshotPath).toBe(t.evidence);
    const obsidianRestored=await applyContentRestore(t.file,obsidianPreview,obsidianHistory,[t.history]);
    expect(obsidianRestored.snapshot.xml).toBe(t.before.xml);
    expect(await readdir(t.history)).toHaveLength(1);expect(await readdir(obsidianHistory)).toHaveLength(1);
    const reopened=await openLocalFile(t.path);
    const webPreview=await prepareContentRestore(reopened,obsidianRestored.snapshot.revision,t.history,[obsidianHistory]);
    expect(webPreview.view.snapshotPath.startsWith(obsidianHistory+'/')).toBe(true);
    const webRestored=await applyContentRestore(reopened,webPreview,t.history,[obsidianHistory]);
    expect(webRestored.snapshot.xml).toBe(t.current.xml);expect(webRestored.snapshot.review?.comments.map(item=>item.id)).toEqual(['old','new']);
    expect(await readdir(t.history)).toHaveLength(2);expect(await readdir(obsidianHistory)).toHaveLength(1);
    expect((await prepareContentRestore(reopened,webRestored.snapshot.revision,obsidianHistory,[t.history])).view.snapshotPath.startsWith(t.history+'/')).toBe(true);
  });

  it('does not read a recorded history root that is absent from the host allowlist, including after preview',async()=>{
    const t=await setup(),otherActive=join(t.folder,'another-config'),unrelated=join(t.folder,'unrelated');
    await expect(prepareContentRestore(t.file,t.current.revision,otherActive,[unrelated])).rejects.toMatchObject({code:'HISTORY_PATH'});
    const preview=await prepareContentRestore(t.file,t.current.revision,otherActive,[t.history]);
    await expect(applyContentRestore(t.file,preview,otherActive,[unrelated])).rejects.toMatchObject({code:'HISTORY_PATH'});
    expect(await t.file.read()).toEqual(t.current);expect(await readdir(t.history)).toHaveLength(1);
  });

  it('uses the current document receipt, never a newer unrelated snapshot in the shared directory',async()=>{
    const t=await setup();const otherFolder=join(t.folder,'other');await mkdir(otherFolder);
    const otherPath=join(otherFolder,'article.xml');await writeFile(otherPath,'<p>另一份文档</p>');const other=await openLocalFile(otherPath);
    const unrelated=await saveContentEvidence(t.history,await other.read(),undefined,otherPath);
    const preview=await prepareContentRestore(t.file,t.current.revision,t.history);expect(preview.view.snapshotPath).toBe(t.evidence);
    const review=structuredClone(t.current.review!);review.operations.at(-1)!.summary=`从飞书拉取正文与资源；双方备份：${unrelated}`;
    const changed=await t.file.save(t.current.xml,review,t.current.revision);
    await expect(prepareContentRestore(t.file,changed.revision,t.history)).rejects.toMatchObject({code:'HISTORY_INVALID'});
    expect(await t.file.read()).toEqual(changed);
  });

  it('does not search a shared history directory when the current document has no recorded snapshot',async()=>{
    const t=await setup(),review=structuredClone(t.current.review!);review.operations=[];
    const current=await t.file.save(t.current.xml,review,t.current.revision);
    await expect(prepareContentRestore(t.file,current.revision,t.history)).rejects.toMatchObject({code:'HISTORY_NOT_FOUND'});
  });

  it('supports legacy snapshots only through the current operation receipt and discloses the missing resource history hashes',async()=>{
    const t=await setup({resources:true});await unlink(join(t.evidence,'manifest.json'));
    const preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    expect(preview.view.warnings.some(text=>text.includes('早期快照'))).toBe(true);
    const restored=await applyContentRestore(t.file,preview,t.history);expect(restored.snapshot.xml).toBe(t.before.xml);
  });

  it.each(['missing-xml','changed-xml','invalid-review','invalid-manifest'] as const)('refuses a %s snapshot without changing the current document',async kind=>{
    const t=await setup();
    if(kind==='missing-xml')await unlink(join(t.evidence,'local.xml'));
    if(kind==='changed-xml')await writeFile(join(t.evidence,'local.xml'),'<p>被改动的快照</p>');
    if(kind==='invalid-review')await writeFile(join(t.evidence,'local.review.json'),'not json');
    if(kind==='invalid-manifest')await writeFile(join(t.evidence,'manifest.json'),'{}');
    await expect(prepareContentRestore(t.file,t.current.revision,t.history)).rejects.toMatchObject({code:kind==='missing-xml'?'HISTORY_NOT_FOUND':'HISTORY_INVALID'});
    expect(await t.file.read()).toEqual(t.current);
  });

  it.each(['local.xml','local.review.json','manifest.json','directory'] as const)('rejects a symlinked %s snapshot component',async component=>{
    const t=await setup();
    if(component==='directory'){
      const clone=join(t.folder,'copied-snapshot');await mkdir(clone);
      for(const name of await readdir(t.evidence))await writeFile(join(clone,name),await readFile(join(t.evidence,name)));
      await rm(t.evidence,{recursive:true});await symlink(clone,t.evidence);
    }else{
      const source=join(t.folder,component);await writeFile(source,await readFile(join(t.evidence,component)));
      await unlink(join(t.evidence,component));await symlink(source,join(t.evidence,component));
    }
    await expect(prepareContentRestore(t.file,t.current.revision,t.history)).rejects.toMatchObject({code:'HISTORY_PATH'});
    expect(await t.file.read()).toEqual(t.current);
  });

  it('rejects a receipt pointing outside the approved history root',async()=>{
    const t=await setup(),review=structuredClone(t.current.review!);review.operations.at(-1)!.summary=`从飞书拉取正文与资源；双方备份：${join(t.folder,'not-history')}`;
    const current=await t.file.save(t.current.xml,review,t.current.revision);
    await expect(prepareContentRestore(t.file,current.revision,t.history)).rejects.toMatchObject({code:'HISTORY_PATH'});
  });

  it.each(['xml','comments','expired','archive'] as const)('refuses confirmation after %s changes',async kind=>{
    const t=await setup(),preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    if(kind==='xml')await writeFile(t.path,'<p>预览后的修改</p>');
    if(kind==='comments'){const review=structuredClone(t.current.review!);review.comments.push(comment('later'));await t.file.save(t.current.xml,review,t.current.revision);}
    if(kind==='expired')preview.view.expiresAt=new Date(Date.now()-1).toISOString();
    if(kind==='archive')await writeFile(join(t.evidence,'local.xml'),'<p>快照被改</p>');
    const before=await t.file.read(),files=await readdir(t.history);
    await expect(applyContentRestore(t.file,preview,t.history)).rejects.toMatchObject({code:kind==='archive'?'HISTORY_INVALID':'CONFLICT'});
    expect(await t.file.read()).toEqual(before);expect(await readdir(t.history)).toEqual(files);
  });

  it.each(['missing','changed','symlink'] as const)('refuses to restore %s historical resources',async kind=>{
    const t=await setup({resources:true}),path=join(t.folder,'board.png');
    if(kind==='missing')await unlink(path);
    if(kind==='changed')await writeFile(path,Buffer.concat([png,Buffer.from('changed bytes')]));
    if(kind==='symlink'){await unlink(path);await symlink(join(t.folder,'original.png'),path);}
    await expect(prepareContentRestore(t.file,t.current.revision,t.history)).rejects.toMatchObject({code:kind==='symlink'?'INVALID_PATH':'HISTORY_RESOURCE'});
    expect(await t.file.read()).toEqual(t.current);
  });

  it('checks legacy resource bytes again at confirmation',async()=>{
    const t=await setup({resources:true});await unlink(join(t.evidence,'manifest.json'));
    const preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    await writeFile(join(t.folder,'board.png'),Buffer.concat([png,Buffer.from('changed bytes')]));
    await expect(applyContentRestore(t.file,preview,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    expect(await t.file.read()).toEqual(t.current);
  });

  it.each(['content','comments'] as const)('blocks restoration while %s synchronization is pending',async kind=>{
    const t=await setup(),review=structuredClone(t.current.review!);
    if(kind==='content')review.contentSync!.pending={id:'pending',direction:'push',startedAt:'2026-09-14T01:00:00Z',sourceXML:newXML};
    else review.cloudSync={version:1,documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',links:[],pending:{id:'pending',kind:'create',localId:'old',body:'意见',startedAt:'2026-09-14T01:00:00Z'}};
    const current=await t.file.save(t.current.xml,review,t.current.revision);
    await expect(prepareContentRestore(t.file,current.revision,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(await t.file.read()).toEqual(current);
  });

  it('does not overwrite if backing up the current version fails',async()=>{
    const t=await setup(),preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    await chmod(t.history,0o500);
    try{await expect(applyContentRestore(t.file,preview,t.history)).rejects.toMatchObject({code:'EACCES'});}
    finally{await chmod(t.history,0o700);}
    expect(await t.file.read()).toEqual(t.current);expect(await readdir(t.history)).toHaveLength(1);
  });

  it('does not restore a historical pending cloud operation or bypass an active synchronization lock',async()=>{
    const t=await setup(),preview=await prepareContentRestore(t.file,t.current.revision,t.history);
    await writeFile(t.file.reviewPath+'.sync.lock','another synchronization owns this document');
    await expect(applyContentRestore(t.file,preview,t.history)).rejects.toMatchObject({code:'CLOUD_BUSY'});
    await unlink(t.file.reviewPath+'.sync.lock');
    const archived=structuredClone(t.before);archived.review!.contentSync={version:1,documentId:'Doc',localXML:oldXML,cloudXML:'',cloudRevision:1,syncedAt:'2026-09-14T00:00:00Z',pending:{id:'old-pending',direction:'push',startedAt:'2026-09-14T00:00:00Z',sourceXML:oldXML}};
    const evidence=await saveContentEvidence(t.history,archived,undefined,t.path),review=structuredClone(t.current.review!);
    review.operations.push({id:'unsafe-snapshot',type:'content.push',author:'我',at:'2026-09-14T01:00:00Z',summary:`同步存档；双方备份：${evidence}`});
    const current=await t.file.save(t.current.xml,review,t.current.revision);
    await expect(prepareContentRestore(t.file,current.revision,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(await t.file.read()).toEqual(current);
  });

  it('keeps sent comment/reply identities and current status so a later explicit comment sync does not replay writes',async()=>{
    const remote:CloudComment={id:'cloud-comment',body:'意见 old',author:'我',createdAt:'2026-09-14T00:00:00Z',status:'resolved',quote:'旧',blockId:'P',replies:[{id:'cloud-reply',body:'已发送回复',author:'我',createdAt:'2026-09-14T00:00:00Z'}]};
    const review=createReview('article.xml',oldXML);review.comments=[{...comment('old'),replies:[{id:'reply',body:'已发送回复',author:'我',createdAt:'2026-09-14T00:00:00Z'}]}];
    review.cloudSync={version:1,documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',links:[{localId:'old',cloudId:remote.id,body:'意见 old',cloudBody:'意见 old',status:'open',replies:{reply:{cloudId:'cloud-reply',body:'已发送回复'}},remote:{...remote,status:'open'}}]};
    const t=await setup({review}),latest=structuredClone(t.current.review!);latest.comments[0].status='resolved';latest.cloudSync!.links[0].status='resolved';latest.cloudSync!.links[0].remote=remote;
    const current=await t.file.save(t.current.xml,latest,t.current.revision);
    const restored=await applyContentRestore(t.file,await prepareContentRestore(t.file,current.revision,t.history),t.history);
    expect(restored.snapshot.review?.cloudSync).toEqual(current.review?.cloudSync);expect(restored.snapshot.review?.comments[0].status).toBe('resolved');
    const transport:CloudTransport={read:vi.fn(async()=>({documentId:'Doc',xml:oldXML,comments:[remote]})),create:vi.fn(),reply:vi.fn(),resolve:vi.fn()};
    await syncCloudComments(t.file,restored.snapshot.revision,{localPath:t.path,documentId:'Doc',url:review.cloudSync.url,transport});
    expect(transport.create).not.toHaveBeenCalled();expect(transport.reply).not.toHaveBeenCalled();expect(transport.resolve).not.toHaveBeenCalled();
  });

  it('refuses to restore an old sent comment when current receipts no longer prove its identity',async()=>{
    const review=createReview('article.xml',oldXML),remote:CloudComment={id:'sent',body:'意见 old',author:'我',createdAt:'2026-09-14T00:00:00Z',status:'open',quote:'旧',blockId:'P',replies:[]};
    review.comments=[comment('old')];review.cloudSync={version:1,documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',links:[{localId:'old',cloudId:'sent',body:'意见 old',cloudBody:'意见 old',status:'open',replies:{},remote}]};
    const t=await setup({review}),latest=structuredClone(t.current.review!);latest.cloudSync!.links=[];
    const current=await t.file.save(t.current.xml,latest,t.current.revision);
    await expect(prepareContentRestore(t.file,current.revision,t.history)).rejects.toMatchObject({code:'HISTORY_SYNC_STATE'});
    expect(await t.file.read()).toEqual(current);
  });
});
