import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {applyContent,prepareContent} from '../src/server/content-sync';
import {createReviewProject} from '../src/server/project-create';
import {bindReviewProject} from '../src/server/project-bind';
import {openProjectStore} from '../src/server/projects';
import {openLocalFile} from '../src/server/files';
import {createReview,type Review} from '../src/core/types';
import type {ReviewProject} from '../src/core/projects';
import type {ContentDocument,ContentTransport,ContentUpdateInput} from '../src/server/content-cli';

const folders:string[]=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHXsAAAAASUVORK5CYII=','base64');
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function setup(xml='<p id="P">旧文</p>',review?:Review){
  const folder=await realpath(await mkdtemp(join(tmpdir(),'review-content-sync-')));folders.push(folder);
  const path=join(folder,'article.xml');await writeFile(path,xml);const file=await openLocalFile(path);
  if(review)await file.save(xml,review,(await file.read()).revision);
  const project:ReviewProject={id:'project',name:'测试',localPath:path,defaultDirection:'pull',cloud:{documentId:'Doc',url:'https://example.feishu.cn/docx/Doc'},createdAt:'2026-09-12T00:00:00Z'};
  return {folder,path,file,project,history:join(folder,'history')};
}
function cloud(xml:string){
  let current:ContentDocument={documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',revision:1,xml};
  const updates:ContentUpdateInput[]=[];
  const transport:ContentTransport={
    fetch:vi.fn(async()=>structuredClone(current)),
    create:vi.fn(async()=>{throw new Error('not part of synchronization');}),
    update:vi.fn(async input=>{updates.push(input);current={...current,xml:await readFile(input.contentPath!,'utf8'),revision:current.revision+1};}),
    download:vi.fn(async input=>{await writeFile(input.outputPath,png,{flag:'wx'});return {path:input.outputPath};}),
  };
  return {transport,updates,get current(){return current;},set current(value:ContentDocument){current=value;}};
}
function reviewed(xml:string){
  const review=createReview('article.xml',xml);
  review.comments.push({id:'comment',body:'意见',author:'我',createdAt:'2026-09-12T00:00:00Z',status:'open',anchor:{from:1,to:3,quote:'旧文',state:'attached'},replies:[]});
  return review;
}
function baseline(review:Review,xml=review.document.xml){
  review.contentSync={version:1,documentId:'Doc',localXML:review.document.xml,cloudXML:xml,cloudRevision:1,syncedAt:'2026-09-12T00:00:00Z'};
  return review;
}

describe('content synchronization uses real files and checked cloud receipts',()=>{
  it('archives the original before pulling and can restore its comments and retained local resources',async()=>{
    const xml='<p id="P">旧文</p><img path="@./original.png"/><whiteboard id="B" token="oldBoard"/>',review=reviewed(xml);
    review.resources={version:1,items:[{tag:'whiteboard',attribute:'token',value:'oldBoard',path:'old-board.png',representation:'preview'}]};
    const t=await setup(xml,review),c=cloud('<p id="P">新文</p><img token="newImage"/><whiteboard id="B" token="oldBoard"/>');
    const oldBoard=Buffer.concat([png,Buffer.from('original board preview')]);
    await writeFile(join(t.folder,'original.png'),png);await writeFile(join(t.folder,'old-board.png'),oldBoard);
    const before=await t.file.read(),prepared=await prepareContent(t.file,t.project,before.revision,'pull',c.transport);
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history,{directoryPrefix:'feishu-assets-'});
    expect(prepared.view.warnings.join(' ')).toContain('请确认首次同步');
    expect(result.warnings.join(' ')).not.toContain('请确认首次同步');
    expect(result.snapshot.xml).toBe(c.current.xml);expect(c.transport.update).not.toHaveBeenCalled();
    expect(result.snapshot.review?.comments[0]).toMatchObject({id:'comment',body:'意见',anchor:{state:'unverified'}});
    const evidence=join(t.history,(await readdir(t.history))[0]);
    const archivedXML=await readFile(join(evidence,'local.xml'),'utf8');
    const archivedReview=JSON.parse(await readFile(join(evidence,'local.review.json'),'utf8')) as Review;
    expect(archivedXML).toBe(before.xml);expect(archivedReview).toEqual(before.review);
    expect(await readFile(join(t.folder,'original.png'))).toEqual(png);
    expect(await readFile(join(t.folder,'old-board.png'))).toEqual(oldBoard);
    const nextResources=result.snapshot.review!.resources!.items;
    expect(nextResources.every(item=>item.path.startsWith('feishu-assets-'))).toBe(true);
    expect(await readFile(join(t.folder,nextResources.find(item=>item.tag==='whiteboard')!.path))).toEqual(png);
    expect(result.snapshot.review?.operations.at(-1)?.summary).toContain(evidence);
    // Verify the archived files independently through the validated local writer.
    const restored=await t.file.save(archivedXML,archivedReview,result.snapshot.revision);
    const reopened=await openLocalFile(t.path),restoredDisk=await reopened.read();
    expect(restoredDisk).toEqual(restored);expect(restoredDisk.xml).toBe(before.xml);expect(restoredDisk.review).toEqual(before.review);
    expect((await reopened.asset('original.png')).data).toEqual(png);
    expect((await reopened.asset(restoredDisk.review!.resources!.items[0].path)).data).toEqual(oldBoard);
  });

  it.each(['pull','push'] as const)('refuses %s before changing either side when the original snapshot cannot be created',async direction=>{
    const xml='<p id="P">旧文</p>',t=await setup(xml,reviewed(xml)),c=cloud('<p id="P">云端修改</p><img token="newImage"/>');
    const before=await t.file.read(),rawReview=await readFile(t.file.reviewPath,'utf8');
    const prepared=await prepareContent(t.file,t.project,before.revision,direction,c.transport);
    await writeFile(t.history,'this path is a file, so snapshot creation must fail');
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history,{adoptPublished:true})).rejects.toMatchObject({code:'EEXIST'});
    expect(await t.file.read()).toEqual(before);expect(await readFile(t.file.reviewPath,'utf8')).toBe(rawReview);
    expect(c.transport.update).not.toHaveBeenCalled();expect(c.transport.download).not.toHaveBeenCalled();
    expect((await t.file.read()).review?.contentSync?.pending).toBeUndefined();
    expect((await readdir(t.folder)).some(name=>name.endsWith('.sync.lock'))).toBe(false);
  });

  it('explicitly adopts a successful publication with resources and complete recoverable old versions',async()=>{
    const xml='<p>旧文</p><p>本地完整段落</p>',review=reviewed(xml),t=await setup(xml,review),c=cloud('<p id="Old">云端旧稿</p>');
    const before=await t.file.read(),cloudBefore=structuredClone(c.current),normalized='<p id="New">旧文</p><img token="image"/>';
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:normalized};});
    const prepared=await prepareContent(t.file,t.project,before.revision,'push',c.transport);
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history,{adoptPublished:true,directoryPrefix:'feishu-assets-'});
    expect(result.snapshot.xml).toBe(normalized);expect(await readFile(t.path,'utf8')).toBe(normalized);
    expect(result.snapshot.review?.contentSync).toMatchObject({localXML:normalized,cloudXML:normalized,cloudRevision:2});
    expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();
    expect(result.snapshot.review?.comments[0]).toMatchObject({body:'意见',anchor:{state:'unverified'}});
    const resource=result.snapshot.review!.resources!.items[0];expect(resource.path).toMatch(/^feishu-assets-/);
    expect(await readFile(join(t.folder,resource.path))).toEqual(png);
    const evidence=join(t.history,(await readdir(t.history))[0]);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    expect(JSON.parse(await readFile(join(evidence,'local.review.json'),'utf8'))).toEqual(before.review);
    expect(JSON.parse(await readFile(join(evidence,'cloud.json'),'utf8'))).toEqual(cloudBefore);
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8'))).toEqual(c.current);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(normalized);
    const again=await prepareContent(t.file,t.project,result.snapshot.revision,'push',c.transport);
    expect(again.view.status).toBe('equal');expect(c.transport.update).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid-readback','download','local-edit','cloud-edit','asset-edit','readback-failure'] as const)('retains original evidence and blocks repeat publishing when automatic adoption fails: %s',async failure=>{
    const xml='<p>旧文</p><img path="@./asset.png"/>',t=await setup(xml,reviewed(xml)),c=cloud('<p id="Old">旧稿</p>');
    await writeFile(join(t.folder,'asset.png'),png);
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:failure==='invalid-readback'?'<p>broken':'<p id="New">旧文</p><img token="image"/>'};});
    c.transport.download=vi.fn(async input=>{
      if(failure==='download')throw new Error('resource unavailable');
      await writeFile(input.outputPath,png,{flag:'wx'});
      if(failure==='local-edit')await writeFile(t.path,'<p>后来的本地修改</p>');
      if(failure==='cloud-edit')c.current={...c.current,revision:3,xml:'<p>后来的云端修改</p>'};
      if(failure==='asset-edit')await writeFile(join(t.folder,'asset.png'),Buffer.concat([png,Buffer.from('new bytes')]));
      if(failure==='readback-failure')c.transport.fetch=vi.fn(async()=>{throw new Error('readback unavailable');});
      return {path:input.outputPath};
    });
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history,{adoptPublished:true})).rejects.toMatchObject({code:failure==='local-edit'?'CONFLICT':'SYNC_PENDING'});
    const current=await t.file.read();
    expect(current.xml).toBe(failure==='local-edit'?'<p>后来的本地修改</p>':xml);
    expect(current.review?.contentSync?.pending).toMatchObject({direction:'push',sourceXML:xml});
    expect(await readFile(join(t.history,(await readdir(t.history))[0],'local.xml'),'utf8')).toBe(xml);
    await expect(prepareContent(t.file,t.project,current.revision,'push',c.transport)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(c.transport.update).toHaveBeenCalledTimes(1);
  });

  it.each(['create','bind'] as const)('opts into the same archived readback adoption when %s creates a cloud document',async kind=>{
    const xml='<p>旧文</p>',t=await setup(xml,reviewed(xml)),c=cloud('<p id="New">旧文</p><img token="image"/>');
    const store=await openProjectStore(join(t.folder,'projects.json'));
    c.transport.create=vi.fn(async()=>({documentId:'Doc',url:c.current.url,warnings:[]}));
    let result;
    if(kind==='create')result=await createReviewProject({name:'新项目',local:{kind:'existing',path:t.path},cloud:{kind:'new',title:'新云稿'},defaultDirection:'push'},store,c.transport,t.history,{adoptPublished:true,directoryPrefix:'feishu-assets-'});
    else {
      const project=await store.register({name:'本地稿',localPath:t.path,defaultDirection:'push'});
      result=await bindReviewProject({revision:(await t.file.read()).revision,cloud:{kind:'new',title:'新云稿'},defaultDirection:'push'},project,t.file,store,c.transport,t.history,{adoptPublished:true,directoryPrefix:'feishu-assets-'});
    }
    const saved=await t.file.read();expect(saved.xml).toBe(c.current.xml);expect(saved.review?.contentSync?.pending).toBeUndefined();
    expect(saved.review?.comments[0].anchor.state).toBe('unverified');expect(saved.review?.resources?.items[0].path).toMatch(/^feishu-assets-/);
    expect(result.project.cloud?.documentId).toBe('Doc');expect(c.transport.create).toHaveBeenCalledTimes(1);expect(c.transport.update).not.toHaveBeenCalled();
    const evidence=join(t.history,(await readdir(t.history))[0]);expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    expect(JSON.parse(await readFile(join(evidence,'created.json'),'utf8')).documentId).toBe('Doc');
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8'))).toEqual(c.current);
  });

  it('keeps an acknowledged cloud create pending if adoption cannot download resources and refuses another create',async()=>{
    const xml='<p>旧文</p>',t=await setup(xml),c=cloud('<img token="image"/>'),store=await openProjectStore(join(t.folder,'projects.json'));
    c.transport.create=vi.fn(async()=>({documentId:'Doc',url:c.current.url,warnings:[]}));
    c.transport.download=vi.fn(async()=>{throw new Error('download unavailable');});
    const input={name:'新项目',local:{kind:'existing',path:t.path},cloud:{kind:'new',title:'云稿'},defaultDirection:'push'};
    const result=await createReviewProject(input,store,c.transport,t.history,{adoptPublished:true});
    expect(result.warning).toContain('勿重复新建');expect(result.project.cloud?.documentId).toBe('Doc');
    const saved=await t.file.read();expect(saved.xml).toBe(xml);expect(saved.review?.contentSync?.pending).toMatchObject({direction:'create',sourceXML:xml});
    await expect(createReviewProject(input,store,c.transport,t.history,{adoptPublished:true})).rejects.toMatchObject({code:'DUPLICATE_PROJECT'});
    expect(c.transport.create).toHaveBeenCalledTimes(1);
  });

  it('allows a first equal pull to finish missing baseline and resource metadata',async()=>{
    const xml='<p id="P">旧文</p>',t=await setup(xml,reviewed(xml)),c=cloud(xml);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    expect(prepared.view.status).toBe('ready');
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(result.snapshot.review?.contentSync).toMatchObject({documentId:'Doc',localXML:xml,cloudXML:xml});
    expect(result.snapshot.review?.comments[0].anchor.state).toBe('attached');
    expect(c.transport.update).not.toHaveBeenCalled();
    const evidence=(await readdir(t.history))[0];expect(await readFile(join(t.history,evidence,'local.xml'),'utf8')).toBe(xml);
  });
  it('stages a first push without changing local IDs and adopts only after a second explicit confirmation',async()=>{
    const xml='<p>旧文</p>',review=reviewed(xml),t=await setup(xml,review),c=cloud('<p id="old-cloud">旧目标</p>');
    const next='<p id="new-cloud">旧文</p>';
    c.transport.update=vi.fn(async input=>{
      const durable=JSON.parse(await readFile(t.file.reviewPath,'utf8')) as Review;
      expect(durable.document.xml).toBe(xml);expect(durable.comments).toEqual(review.comments);
      expect(durable.contentSync?.pending?.sourceXML).toBe(xml);expect(input.command).toBe('overwrite');
      c.current={...c.current,revision:2,xml:next};
    });
    const before=await t.file.read(),beforeSidecar=await readFile(t.file.reviewPath,'utf8');
    const publishing=await prepareContent(t.file,t.project,before.revision,'push',c.transport);
    expect(await t.file.read()).toEqual(before);expect(await readFile(t.file.reviewPath,'utf8')).toBe(beforeSidecar);
    expect(c.transport.update).not.toHaveBeenCalled();
    const result=await applyContent(t.file,t.project,publishing,c.transport,t.history);
    expect(result.snapshot.xml).toBe(xml);expect(result.snapshot.review?.comments).toEqual(review.comments);
    expect(result.snapshot.review?.contentSync).toMatchObject({documentId:'Doc',localXML:xml,cloudXML:next,cloudRevision:2});
    expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();
    expect(JSON.parse(await readFile(t.file.reviewPath,'utf8')).comments).toEqual(review.comments);
    expect(result.warnings.some(value=>value.includes('无法可靠确认'))).toBe(false);
    expect(c.transport.update).toHaveBeenCalledTimes(1);expect(c.transport.download).not.toHaveBeenCalled();
    const staged=await t.file.read(),stagedSidecar=await readFile(t.file.reviewPath,'utf8');
    const adopting=await prepareContent(t.file,t.project,staged.revision,'push',c.transport);
    expect(adopting.view).toMatchObject({action:'refresh-local',localXML:xml,cloudXML:next});
    expect(await t.file.read()).toEqual(staged);expect(await readFile(t.file.reviewPath,'utf8')).toBe(stagedSidecar);
    const adopted=await applyContent(t.file,t.project,adopting,c.transport,t.history);
    expect(adopted.snapshot.xml).toBe(next);expect(adopted.snapshot.review?.comments[0].anchor.state).toBe('unverified');
    expect(adopted.snapshot.review?.contentSync).toMatchObject({localXML:next,cloudXML:next});
    expect(c.transport.update).toHaveBeenCalledTimes(1);
  });
  it('refreshes an already equal cloud body without publishing or attaching duplicate paragraphs by text',async()=>{
    const xml='<p>重复</p><p>重复</p>',review=reviewed(xml);
    review.comments.push({...review.comments[0],id:'second',anchor:{from:5,to:7,quote:'重复',state:'attached'}});
    const t=await setup(xml,review),next='<p id="first">重复</p><p id="second">重复</p>',c=cloud(next);
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(result.snapshot.xml).toBe(next);expect(result.snapshot.review?.comments).toEqual(review.comments.map(c=>({...c,anchor:{...c.anchor,state:'unverified'}})));
    expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('keeps an ordinary first pull conservative for otherwise identical no-ID local comments',async()=>{
    const xml='<p>旧文</p>',t=await setup(xml,reviewed(xml)),c=cloud('<p id="new-cloud">旧文</p>');
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport),c.transport,t.history);
    expect(result.snapshot.review?.comments[0].anchor.state).toBe('unverified');
    expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('preserves local comments and cloud-comment state while staging a publication',async()=>{
    const xml='<p>旧文</p>',review=reviewed(xml);
    review.cloudSync={version:1,documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',links:[]};
    const t=await setup(xml,review),c=cloud('<p id="old-cloud">旧目标</p>');
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:'<p id="new-cloud">旧文</p>'};});
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(result.snapshot.xml).toBe(xml);expect(result.snapshot.review?.comments).toEqual(review.comments);
    expect(result.snapshot.review?.cloudSync).toEqual(review.cloudSync);
  });
  it('preserves local component anchors when the staged cloud board receives a new identity',async()=>{
    const xml='<whiteboard token="oldBoard"/>',review=createReview('article.xml',xml);
    review.comments.push({...reviewed('<p/>').comments[0],anchor:{from:0,to:1,quote:'原组件',state:'attached',target:{kind:'whiteboard-component',board:'token:oldBoard',id:'shape'}}});
    const t=await setup(xml,review),c=cloud('<p id="old-cloud">旧目标</p>');
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:'<whiteboard id="new-block" token="newBoard"/>'};});
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(result.snapshot.xml).toBe(xml);expect(result.snapshot.review?.comments[0].anchor).toEqual(review.comments[0].anchor);
    expect(result.snapshot.review?.contentSync?.cloudXML).toBe(c.current.xml);expect(c.transport.download).not.toHaveBeenCalled();
  });
  it('does not mark stale sidecar positions reliable merely because their first-push cloud receipt matches',async()=>{
    const old='<p>旧文</p>',xml='<p>前缀旧文</p>',t=await setup(old,reviewed(old)),c=cloud('<p id="old-cloud">旧目标</p>');
    await writeFile(t.path,xml);
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:'<p id="new-cloud">前缀旧文</p>'};});
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(result.snapshot.review?.comments[0].anchor.state).toBe('unverified');
    expect(result.snapshot.xml).toBe(xml);expect(result.snapshot.review?.comments[0]).toMatchObject({id:'comment',body:'意见',anchor:{quote:'旧文'}});
  });
  it('rebases a stale sidecar onto externally edited XML before saving push intent',async()=>{
    const old='<p id="P">旧文</p>',next='<p id="P">新文</p>',t=await setup(old,baseline(reviewed(old))),c=cloud(old);
    await writeFile(t.path,next);
    c.transport.update=vi.fn(async input=>{
      const durable=JSON.parse(await readFile(t.file.reviewPath,'utf8')) as Review;
      expect(durable.document.xml).toBe(next);expect(durable.contentSync?.pending?.sourceXML).toBe(next);
      expect(durable.comments[0].anchor.state).toBe('unverified');
      expect(input).toMatchObject({documentId:'Doc',command:'block_replace',blockId:'P',revision:1});
      c.current={...c.current,revision:2,xml:next};
    });
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(c.transport.update).toHaveBeenCalledTimes(1);expect(result.snapshot.xml).toBe(next);expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();
    expect(result.snapshot.review?.comments[0].anchor.state).toBe('unverified');
    expect((await readdir(t.folder)).some(name=>name.startsWith('.review-publish-'))).toBe(false);
  });
  it('does not invalidate valid local anchors just because a published block is replaced in the cloud',async()=>{
    const old='<p id="P">旧文</p>',next='<p id="P">新文</p>',review=baseline(reviewed(next),old);review.contentSync!.localXML=old;review.comments[0].anchor.quote='新文';
    const t=await setup(next,review),c=cloud(old);
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:next};});
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(c.transport.update).toHaveBeenCalledTimes(1);
    expect(result.snapshot.xml).toBe(next);expect(result.snapshot.review?.comments).toEqual(review.comments);
  });
  it('refreshes unchanged-token whiteboards and invalidates component positions on an explicit pull',async()=>{
    const xml='<whiteboard id="B" token="board"/>',review=baseline(createReview('article.xml',xml));
    review.comments.push({...reviewed('<p/>').comments[0],anchor:{from:0,to:1,quote:'组件',state:'attached',target:{kind:'whiteboard-component',board:'token:board',id:'shape'}}});
    review.resources={version:1,items:[{tag:'whiteboard',attribute:'token',value:'board',path:'old.png',representation:'preview'}]};
    const t=await setup(xml,review),c=cloud(xml);await writeFile(join(t.folder,'old.png'),png);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    expect(prepared.view.status).toBe('ready');
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(c.transport.download).toHaveBeenCalledTimes(1);expect(result.snapshot.xml).toBe(xml);
    expect(result.snapshot.review?.resources?.items[0].path).not.toBe('old.png');
    expect(result.snapshot.review?.comments[0].anchor.state).toBe('unverified');
  });
  it('adopts changed cloud identities on an otherwise equal pull without reattaching old comments',async()=>{
    const old='<p id="P">旧文</p>',next='<p id="New">旧文</p>',t=await setup(old,baseline(reviewed(old))),c=cloud(next);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    expect(prepared.view.status).toBe('ready');
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(result.snapshot.xml).toBe(next);expect(result.snapshot.review?.comments[0].anchor.state).toBe('unverified');
  });
  it('pull can recover missing local assets because it never publishes their bytes',async()=>{
    const t=await setup('<img path="@missing.png"/>'),c=cloud('<p id="P">云稿</p>');
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    expect(prepared.assets).toEqual({});
    expect((await applyContent(t.file,t.project,prepared,c.transport,t.history)).snapshot.xml).toBe(c.current.xml);
  });
  it('allows explicit pull after an acknowledged local path to cloud token normalization',async()=>{
    const local='<img path="@./asset.png"/>',remote='<img id="CloudImageBlock" token="cloudImage"/>',review=baseline(createReview('article.xml',local),remote);
    const t=await setup(local,review),c=cloud(remote);await writeFile(join(t.folder,'asset.png'),png);
    const pull=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    expect(pull.view.status).toBe('ready');
    const result=await applyContent(t.file,t.project,pull,c.transport,t.history);
    expect(result.snapshot.xml).toBe(remote);expect(result.snapshot.review?.resources?.items[0]).toMatchObject({tag:'img',attribute:'token',value:'cloudImage'});
    expect(c.transport.download).toHaveBeenCalledTimes(1);expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('repairs an acknowledged but divergent baseline by refreshing local XML and resources without any cloud write',async()=>{
    const xml='<p id="P">旧文</p><whiteboard type="mermaid">graph LR\nA--&gt;B</whiteboard>',remote='<p id="P">旧文</p><whiteboard id="B" token="board"/>';
    const review=baseline(reviewed(xml),remote),t=await setup(xml,review),c=cloud(remote);
    const download=c.transport.download;c.transport.download=vi.fn(async input=>{
      const current=await t.file.read();expect(current.xml).toBe(xml);expect(current.review?.contentSync?.pending).toBeUndefined();
      return download(input);
    });
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    expect(prepared.view).toMatchObject({direction:'push',action:'refresh-local',status:'ready',localXML:xml,cloudXML:remote});
    expect(prepared.view.summary).toContain('不改动飞书');expect(prepared.view.warnings.join(' ')).not.toContain('覆盖');
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(result.snapshot.xml).toBe(remote);expect(result.snapshot.review?.contentSync).toMatchObject({localXML:remote,cloudXML:remote});
    expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();expect(result.snapshot.review?.comments[0].anchor.state).toBe('attached');
    expect(result.snapshot.review?.resources?.items[0]).toMatchObject({tag:'whiteboard',value:'board',representation:'preview'});
    expect(result.snapshot.review?.operations.at(-1)?.type).toBe('content.pull');
    expect(c.transport.update).not.toHaveBeenCalled();expect(c.transport.download).toHaveBeenCalledTimes(1);
    const again=await prepareContent(t.file,t.project,result.snapshot.revision,'push',c.transport);
    expect(again.view.status).toBe('equal');expect(again.view.action).toBeUndefined();
    const evidence=join(t.history,(await readdir(t.history))[0]);expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
  });
  it.each(['download','local-edit','asset-edit'] as const)('does not overwrite a legacy local baseline when refresh fails during %s',async failure=>{
    const xml='<p id="P">旧文</p><img path="@./asset.png"/>',remote='<p id="P">旧文</p><img token="image"/>',review=baseline(reviewed(xml),remote);
    review.contentSync!.localAssets={'asset.png':createHash('sha256').update(png).digest('hex')};
    const t=await setup(xml,review),c=cloud(remote),asset=join(t.folder,'asset.png');await writeFile(asset,png);
    const before=await readFile(t.file.reviewPath,'utf8');
    c.transport.download=vi.fn(async input=>{
      if(failure==='download')throw new Error('download interrupted');
      await writeFile(input.outputPath,png);
      if(failure==='local-edit')await writeFile(t.path,xml+'<p>并发修改</p>');
      else await writeFile(asset,Buffer.concat([png,Buffer.from('changed')]));
      return {path:input.outputPath};
    });
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    expect(prepared.view.action).toBe('refresh-local');
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toThrow();
    expect(await readFile(t.path,'utf8')).toBe(failure==='local-edit'?xml+'<p>并发修改</p>':xml);
    expect(await readFile(t.file.reviewPath,'utf8')).toBe(before);expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('retains push intent and the cloud receipt when the local file changes during publication',async()=>{
    const xml='<whiteboard type="mermaid">graph LR\nA--&gt;B</whiteboard>',t=await setup(xml),c=cloud('<p id="P">旧稿</p>');
    const remote='<whiteboard id="B" token="board"/>';
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:remote};await writeFile(t.path,xml+'<p>并发修改</p>');});
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    const current=await t.file.read();expect(current.xml).toBe(xml+'<p>并发修改</p>');
    expect(current.review?.contentSync?.pending).toMatchObject({direction:'push',sourceXML:xml});expect(c.transport.update).toHaveBeenCalledTimes(1);
    expect(c.transport.download).not.toHaveBeenCalled();
    const evidence=join(t.history,(await readdir(t.history))[0]);
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8')).xml).toBe(remote);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(remote);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    await expect(prepareContent(t.file,t.project,current.revision,'push',c.transport)).rejects.toMatchObject({code:'SYNC_PENDING'});
  });
  it('refuses cloud or local changes after preview without writing or clearing the changed data',async()=>{
    const t=await setup(),c=cloud('<p id="P">云稿</p>');
    let prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    c.current={...c.current,revision:2};
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    await writeFile(t.path,'<p>外部新稿</p>');
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    expect(await readFile(t.path,'utf8')).toBe('<p>外部新稿</p>');expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('preserves downloaded-time local edits and does not overwrite them',async()=>{
    const t=await setup(),c=cloud('<img token="image"/>');
    c.transport.download=vi.fn(async input=>{await writeFile(input.outputPath,png);await writeFile(t.path,'<p>下载期间修改</p>');return {path:input.outputPath};});
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'pull',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    expect(await readFile(t.path,'utf8')).toBe('<p>下载期间修改</p>');
  });
  it('writes once on an uncertain receipt and blocks a subsequent automatic attempt',async()=>{
    const xml='<p id="P">本地</p>',t=await setup(xml),c=cloud('<p id="P">云稿</p>');
    c.transport.update=vi.fn(async()=>{throw new Error('response lost after a possible write');});
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    const snapshot=await t.file.read();expect(snapshot.xml).toBe(xml);expect(snapshot.review?.contentSync?.pending).toMatchObject({direction:'push',sourceXML:xml});
    await expect(prepareContent(t.file,t.project,snapshot.revision,'push',c.transport)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(c.transport.update).toHaveBeenCalledTimes(1);
  });
  it('checks document identity again immediately before the first cloud write',async()=>{
    const t=await setup(),c=cloud('<p id="P">云稿</p>');let fetches=0;
    c.transport.fetch=vi.fn(async()=>({...c.current,documentId:++fetches===3?'Other':'Doc'}));
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(c.transport.update).not.toHaveBeenCalled();
  });
  it('does not publish an asset changed while awaiting the last cloud revision check',async()=>{
    const t=await setup('<img id="I" path="@./asset.png"/>'),c=cloud('<img id="I" token="oldImage"/>');
    const asset=join(t.folder,'asset.png');await writeFile(asset,png);let fetches=0;
    c.transport.fetch=vi.fn(async()=>{if(++fetches===3)await writeFile(asset,Buffer.concat([png,Buffer.from('changed')]));return {...c.current};});
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    expect(c.transport.update).not.toHaveBeenCalled();expect((await t.file.read()).review?.contentSync?.pending).toBeDefined();
  });
  it('preserves valid positions in the local draft after a cloud overwrite',async()=>{
    const old='<title>旧标题</title><p id="P">旧文</p>',next=old.replace('旧标题','新标题'),review=baseline(reviewed(next),old);
    review.contentSync!.localXML=old;review.comments[0].anchor={from:6,to:8,quote:'旧文',state:'attached'};
    const t=await setup(next,review),c=cloud(old);
    c.transport.update=vi.fn(async input=>{expect(input.command).toBe('overwrite');c.current={...c.current,revision:2,xml:next};});
    const result=await applyContent(t.file,t.project,await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport),c.transport,t.history);
    expect(c.transport.update).toHaveBeenCalledTimes(1);expect(result.snapshot.xml).toBe(next);expect(result.snapshot.review?.comments).toEqual(review.comments);
  });
  it.each(['exact','normalized','missing-paragraph'] as const)('preserves the original and both complete backups when the cloud readback is %s',async kind=>{
    const xml='<p>旧文<!-- keep this --></p><p>这一整段不能丢</p><img path="@./asset.png"/>',review=reviewed(xml);
    review.resources={version:1,items:[{tag:'img',attribute:'token',value:'previousPreview',path:'asset.png',representation:'original'}]};
    const t=await setup(xml,review),c=cloud('<p id="old">远端旧稿</p>');await writeFile(join(t.folder,'asset.png'),png);
    const remote=kind==='exact'?xml:kind==='normalized'?'<p id="P">旧文</p><p id="Q">这一整段不能丢</p><img token="image"/>':'<p id="P">旧文</p><img token="image"/>';
    const before=await t.file.read();
    c.transport.update=vi.fn(async()=>{c.current={...c.current,revision:2,xml:remote};});
    c.transport.download=vi.fn(async()=>{throw new Error('cloud previews are unavailable');});
    const prepared=await prepareContent(t.file,t.project,before.revision,'push',c.transport);
    expect(await t.file.read()).toEqual(before);expect(c.transport.update).not.toHaveBeenCalled();
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(result.snapshot.xml).toBe(xml);expect(await readFile(t.path,'utf8')).toBe(xml);
    expect(result.snapshot.review?.comments).toEqual(before.review?.comments);expect(result.snapshot.review?.resources).toEqual(before.review?.resources);
    expect(result.snapshot.review?.contentSync).toMatchObject({localXML:xml,cloudXML:remote,cloudRevision:2,localAssets:{'asset.png':createHash('sha256').update(png).digest('hex')}});
    expect(result.snapshot.review?.contentSync?.pending).toBeUndefined();expect(c.transport.download).not.toHaveBeenCalled();
    const evidence=join(t.history,(await readdir(t.history))[0]);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    expect(JSON.parse(await readFile(join(evidence,'local.review.json'),'utf8'))).toEqual(before.review);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(remote);
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8'))).toEqual(c.current);
    expect(result.snapshot.review?.operations.at(-1)?.summary).toContain(evidence);
    if(kind!=='exact')expect(result.warnings.some(w=>w.includes('差异')&&w.includes(evidence))).toBe(true);
    const staged=await t.file.read(),again=await prepareContent(t.file,t.project,staged.revision,'push',c.transport);
    expect(await t.file.read()).toEqual(staged);expect(c.transport.update).toHaveBeenCalledTimes(1);
    if(kind==='exact'){expect(again.view.status).toBe('equal');expect(again.view.action).toBeUndefined();}
    else {
      expect(again.view).toMatchObject({action:'refresh-local',localXML:xml,cloudXML:remote});
      await expect(applyContent(t.file,t.project,again,c.transport,t.history)).rejects.toThrow('cloud previews are unavailable');
      expect(await t.file.read()).toEqual(staged);expect((await t.file.read()).review?.contentSync?.pending).toBeUndefined();
      expect(c.transport.update).toHaveBeenCalledTimes(1);
    }
  });
  it('publishes same-path asset changes once and remembers the exact local asset baseline',async()=>{
    const xml='<img id="I" path="@./asset.png"/>',remote='<img id="I" token="oldImage"/>',review=baseline(createReview('article.xml',xml),remote);
    review.contentSync!.localAssets={'asset.png':createHash('sha256').update(png).digest('hex')};
    const t=await setup(xml,review),c=cloud(remote),asset=join(t.folder,'asset.png');await writeFile(asset,png);
    expect((await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport)).view).toMatchObject({status:'ready',action:'refresh-local'});
    const changed=Buffer.concat([png,Buffer.from('new image revision')]);await writeFile(asset,changed);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);expect(prepared.view.status).toBe('ready');
    c.transport.update=vi.fn(async input=>{expect(input.command).toBe('block_replace');c.current={...c.current,revision:2,xml:'<img id="NewI" token="newImage"/>'};});
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(result.snapshot.xml).toBe(xml);expect(result.snapshot.review?.contentSync?.localAssets).toEqual({'asset.png':createHash('sha256').update(changed).digest('hex')});
    expect(result.snapshot.review?.resources).toEqual(review.resources);expect(c.transport.download).not.toHaveBeenCalled();
    const unchanged=await prepareContent(t.file,t.project,result.snapshot.revision,'push',c.transport);
    expect(unchanged.view).toMatchObject({status:'ready',action:'refresh-local'});
    expect((await t.file.read()).xml).toBe(xml);expect(c.transport.update).toHaveBeenCalledTimes(1);
    const adopted=await applyContent(t.file,t.project,unchanged,c.transport,t.history);
    expect(adopted.snapshot.xml).toBe(c.current.xml);expect(adopted.snapshot.review?.contentSync?.localAssets).toEqual({});
    expect(adopted.snapshot.review?.resources?.items[0]).toMatchObject({tag:'img',attribute:'token',value:'newImage'});
    expect(c.transport.download).toHaveBeenCalledTimes(1);expect(c.transport.update).toHaveBeenCalledTimes(1);
  });
  it('requires a warned full replacement when the asset baseline is absent and XML planning is empty',async()=>{
    // Defensive transport fixture: real clouds normally replace path with token.
    const xml='<img id="I" path="@./asset.png"/>',t=await setup(xml,baseline(createReview('article.xml',xml))),c=cloud(xml);
    await writeFile(join(t.folder,'asset.png'),png);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    expect(prepared.view.status).toBe('ready');expect(prepared.view.warnings.some(w=>w.includes('完整正文'))).toBe(true);
    c.transport.update=vi.fn(async input=>{expect(input.command).toBe('overwrite');c.current={...c.current,revision:2};});
    const result=await applyContent(t.file,t.project,prepared,c.transport,t.history);
    expect(c.transport.update).toHaveBeenCalledTimes(1);expect(result.snapshot.review?.contentSync?.localAssets?.['asset.png']).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects an asset changed after preview before creating any push intent',async()=>{
    const xml='<img id="I" path="@./asset.png"/>',t=await setup(xml),c=cloud('<img id="I" token="oldImage"/>');
    await writeFile(join(t.folder,'asset.png'),png);
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await writeFile(join(t.folder,'asset.png'),Buffer.concat([png,Buffer.from('new')]));
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'CONFLICT'});
    expect(c.transport.update).not.toHaveBeenCalled();expect((await t.file.read()).review).toBeNull();
  });
  it('does not label an asset changed during the cloud call as the published baseline',async()=>{
    const xml='<img id="I" path="@./asset.png"/>',t=await setup(xml),c=cloud('<img id="I" token="oldImage"/>');await writeFile(join(t.folder,'asset.png'),png);
    c.transport.update=vi.fn(async()=>{await writeFile(join(t.folder,'asset.png'),Buffer.concat([png,Buffer.from('new')]));c.current={...c.current,revision:2,xml:'<img id="NewI" token="newImage"/>'};});
    const prepared=await prepareContent(t.file,t.project,(await t.file.read()).revision,'push',c.transport);
    await expect(applyContent(t.file,t.project,prepared,c.transport,t.history)).rejects.toMatchObject({code:'SYNC_PENDING'});
    const saved=await t.file.read();expect(saved.review?.contentSync?.pending).toBeDefined();expect(saved.review?.contentSync?.localAssets).toBeUndefined();
    expect(c.transport.update).toHaveBeenCalledTimes(1);
  });
});
