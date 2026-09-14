import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,relative} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {createLocalServer} from '../src/server/server';
import {openProjectStore} from '../src/server/projects';
import type {ContentDocument,ContentTransport} from '../src/server/content-cli';
import {createReview,type Review} from '../src/core/types';

const folders:string[]=[],servers:Server[]=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHXsAAAAASUVORK5CYII=','base64');
afterEach(async()=>{
  for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
  for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});
});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(cloudAvailable=true){
  const root=await realpath(await mkdtemp(join(tmpdir(),'review-bind-http-')));folders.push(root);
  const site=join(root,'site');await mkdir(site);await writeFile(join(site,'index.html'),'<main>Review</main>');
  const path=join(root,'article.xml'),xml='<title>本地稿</title><p>本地正文</p>',review=createReview('article.xml',xml);
  review.comments=[{id:'local-comment',author:'人类',body:'保留这个意见',createdAt:'2026-09-13T00:00:00Z',status:'open',
    anchor:{from:6,to:8,quote:'本地',state:'attached'},replies:[{id:'local-reply',author:'人类',body:'还要保留回复',createdAt:'2026-09-13T00:01:00Z'}]}];
  await writeFile(path,xml);await writeFile(join(root,'article.review.json'),JSON.stringify(review,null,1));
  const catalog=join(root,'projects.json'),store=await openProjectStore(catalog),calls:string[]=[];
  const remote=new Map<string,ContentDocument>([['DocA',{documentId:'DocA',url:'https://www.feishu.cn/docx/DocA',revision:4,xml:'<title id="DocA">云稿</title><p id="a">云端正文</p>'}],
    ['DocB',{documentId:'DocB',url:'https://www.feishu.cn/docx/DocB',revision:2,xml:'<p id="b">另一份</p>'}]]);
  let count=0;
  const transport:ContentTransport={
    async fetch(ref){calls.push('fetch');const id=ref.includes('/wiki/')?'DocA':ref.split('/').pop()!;const value=remote.get(id);if(!value)throw new Error('missing cloud');return structuredClone(value);},
    async create({title,contentPath}){calls.push('create');const documentId='Created'+(++count),url='https://www.feishu.cn/docx/'+documentId;
      const body=await readFile(contentPath,'utf8');remote.set(documentId,{documentId,url,revision:1,xml:'<title id="'+documentId+'">'+title+'</title>'+body.replace('<p>','<p id="created-p">')});
      return {documentId,url,warnings:['访问权需要自行核对']};},
    async update(){calls.push('update');throw new Error('binding must not update existing cloud');},
    async download(){calls.push('download');throw new Error('fixture has no cloud media');}
  };
  const server=await createLocalServer(site,path,{picker:async()=>{calls.push('picker');return null;},
    projects:{store,historyRoot:join(root,'history'),...(cloudAvailable?{transport}:{})},
    projectSettings:{defaultSharedPath:catalog,read:async()=>({shared:false,path:catalog}),setShared:async()=>{calls.push('settings');return {shared:true,path:catalog};}}});
  servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const get=async(route:string)=>{const response=await fetch(base+route);return {status:response.status,value:await response.json()};};
  const session=(await get('/api/session')).value,id=session.project.id;
  const send=async(route:string,input:unknown,method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};};
  const snapshot=async()=>(await get('/api/document?id='+session.document.id)).value;
  const bind=async(cloud:unknown={kind:'existing',url:'https://www.feishu.cn/docx/DocA'},revision?:string)=>send('/api/projects/'+id+'/bind',
    {revision:revision??(await snapshot()).revision,cloud,defaultDirection:'push'});
  return {root,path,xml,review,catalog,store,remote,transport,calls,get,send,session,id,snapshot,bind};
}

describe('attach Feishu to an existing local project through HTTP',()=>{
  it('verifies an existing Wiki endpoint and preserves project, file, comments and all sidecar bytes',async()=>{
    const f=await fixture(),sidecar=await readFile(f.session.document.reviewPath,'utf8'),before=await f.snapshot();
    const result=await f.bind({kind:'existing',url:'https://www.feishu.cn/wiki/WikiA'});
    expect(result.status).toBe(200);expect(result.value.session.project).toMatchObject({id:f.id,localPath:f.path,name:'article',defaultDirection:'push',cloud:{documentId:'DocA'}});
    expect(result.value.session.document.id).toBe(f.session.document.id);expect(result.value.projects).toHaveLength(1);
    expect(result.value.snapshot).toEqual(before);expect(await readFile(f.path,'utf8')).toBe(f.xml);
    expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(sidecar);expect(f.calls).toEqual(['fetch']);
    const preview=await f.send('/api/projects/'+f.id+'/preview',{revision:before.revision,direction:'push'});
    expect(preview.status).toBe(200);expect(preview.value.status).toBe('conflict');expect(preview.value.localXML).toBe(f.xml);
    expect(f.calls).toEqual(['fetch','fetch']);
  });
  it('rejects every subsequent bind without another fetch or create, even for the same document',async()=>{
    const f=await fixture();expect((await f.bind()).status).toBe(200);
    for(const cloud of [{kind:'existing',url:'https://www.feishu.cn/docx/DocA'},{kind:'existing',url:'https://www.feishu.cn/docx/DocB'},{kind:'new',title:'不会新建'}])
      expect((await f.bind(cloud)).value.code).toBe('CLOUD_BINDING');
    expect(f.calls).toEqual(['fetch']);
  });
  it('rejects stale input before making a cloud request',async()=>{
    const f=await fixture(),before=await f.snapshot();await writeFile(f.path,f.xml+'<p>外部修改</p>');
    expect((await f.bind(undefined,before.revision)).value.code).toBe('CONFLICT');expect(f.calls).toEqual([]);
  });
  it('rejects an external edit during endpoint verification without writing registration or sidecar',async()=>{
    const f=await fixture(),fetch=f.transport.fetch,sidecar=await readFile(f.session.document.reviewPath,'utf8');
    f.transport.fetch=async ref=>{const result=await fetch(ref);await writeFile(f.path,f.xml+'<p>并发修改</p>');return result;};
    expect((await f.bind()).value.code).toBe('CONFLICT');expect((await f.store.get(f.id))!.cloud).toBeUndefined();
    expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(sidecar);
  });
  it.each(['content','comment'] as const)('rejects a sidecar binding to a different document: %s',async kind=>{
    const f=await fixture(),r:Review=structuredClone(f.review);
    if(kind==='content')r.contentSync={version:1,documentId:'DocB',localXML:f.xml,cloudXML:f.xml,cloudRevision:1,syncedAt:new Date().toISOString()};
    else r.cloudSync={version:1,documentId:'DocB',url:'https://www.feishu.cn/docx/DocB',links:[]};
    await writeFile(f.session.document.reviewPath,JSON.stringify(r));const before=await readFile(f.session.document.reviewPath,'utf8');
    expect((await f.bind()).value.code).toBe('CLOUD_BINDING');expect((await f.bind({kind:'new',title:'不能新建'})).value.code).toBe('CLOUD_BINDING');
    expect(f.calls).not.toContain('create');expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(before);
  });
  it('refuses a pending create before fetching and retains its intent',async()=>{
    const f=await fixture(),r=structuredClone(f.review);r.contentSync={version:1,documentId:'',localXML:f.xml,cloudXML:'',cloudRevision:0,syncedAt:new Date().toISOString(),
      pending:{id:'pending',direction:'create',startedAt:new Date().toISOString(),sourceXML:f.xml}};
    await writeFile(f.session.document.reviewPath,JSON.stringify(r));expect((await f.bind()).value.code).toBe('SYNC_PENDING');expect(f.calls).toEqual([]);
  });
  it('rejects another project owning the cloud document at the catalog transaction',async()=>{
    const f=await fixture(),other=join(f.root,'other.xml');await writeFile(other,'<p>另一份</p>');
    await f.store.register({name:'other',localPath:other,defaultDirection:'pull',cloud:{documentId:'DocA',url:'https://www.feishu.cn/docx/DocA'}});
    const before=await readFile(f.session.document.reviewPath,'utf8');expect((await f.bind()).value.code).toBe('PROJECT_DUPLICATE');
    expect((await f.store.get(f.id))!.cloud).toBeUndefined();expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(before);
  });
  it('does not overwrite a concurrent catalog binding even after a list refresh',async()=>{
    const f=await fixture(),fetch=f.transport.fetch;
    f.transport.fetch=async ref=>{const value=await fetch(ref),other=await openProjectStore(f.catalog);
      await other.update(f.id,{cloud:{documentId:'DocB',url:'https://www.feishu.cn/docx/DocB'}});await f.store.list();return value;};
    expect((await f.bind()).value.code).toBe('CLOUD_BINDING');expect((await f.store.get(f.id))!.cloud?.documentId).toBe('DocB');
  });
  it('creates once from the mature local draft and keeps the existing project and comment identities',async()=>{
    const f=await fixture();const result=await f.bind({kind:'new',title:'本地稿'});
    expect(result.status).toBe(200);expect(result.value.warning).toContain('访问权');expect(result.value.session.project.id).toBe(f.id);
    expect(result.value.session.project.localPath).toBe(f.path);expect(result.value.session.project.cloud.documentId).toBe('Created1');
    expect(result.value.projects).toHaveLength(1);expect(result.value.snapshot.review.contentSync.pending).toBeUndefined();
    expect(result.value.snapshot.review.contentSync.documentId).toBe('Created1');expect(result.value.snapshot.review.comments[0]).toMatchObject({id:'local-comment',body:'保留这个意见',replies:f.review.comments[0].replies});
    expect(result.value.snapshot.review.comments[0].anchor).toEqual({...f.review.comments[0].anchor,state:'unverified'});
    expect(result.value.snapshot.xml).toBe(f.remote.get('Created1')!.xml);
    expect(result.value.snapshot.review.contentSync).toMatchObject({localXML:f.remote.get('Created1')!.xml,cloudXML:f.remote.get('Created1')!.xml});
    expect(f.calls).not.toContain('download');
    expect(result.value.snapshot.xml).toContain('本地正文');expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
    const dirs=await readdir(join(f.root,'sync-history'));expect(dirs).toHaveLength(1);expect(await readFile(join(f.root,'sync-history',dirs[0],'local.xml'),'utf8')).toBe(f.xml);
  });
  it('adopts a normalized create readback immediately through HTTP and archives the complete original draft',async()=>{
    const f=await fixture(),create=f.transport.create,xml=f.xml+'<p>这段本地说明不能丢</p><img path="@./asset.png"/>';
    const review=structuredClone(f.review);review.document.xml=xml;
    review.resources={version:1,items:[{tag:'img',attribute:'token',value:'localPreview',path:'asset.png',representation:'original'}]};
    await writeFile(f.path,xml);await writeFile(f.session.document.reviewPath,JSON.stringify(review));await writeFile(join(f.root,'asset.png'),png);
    const before=await f.snapshot();
    f.transport.create=async input=>{
      const result=await create(input);
      f.remote.get(result.documentId)!.xml='<title id="Created1">本地稿</title><whiteboard token="board"/><img token="image"/>';
      return result;
    };
    f.transport.download=async input=>{f.calls.push('download');await writeFile(input.outputPath,png);return {path:input.outputPath};};
    const result=await f.bind({kind:'new',title:'本地稿'}),remote=f.remote.get('Created1')!.xml;
    expect(result.status).toBe(200);expect(result.value.snapshot.xml).toBe(remote);expect(await readFile(f.path,'utf8')).toBe(remote);
    expect(result.value.snapshot.review.contentSync).toMatchObject({documentId:'Created1',localXML:remote,cloudXML:remote,localAssets:{}});
    expect(result.value.snapshot.review.contentSync.pending).toBeUndefined();
    expect(result.value.snapshot.review.comments[0]).toEqual({...review.comments[0],anchor:{...review.comments[0].anchor,state:'unverified'}});
    expect(result.value.snapshot.review.resources.items).toHaveLength(2);
    for(const item of result.value.snapshot.review.resources.items)expect(await readFile(join(f.root,item.path))).toEqual(png);
    const evidence=join(f.root,'sync-history',(await readdir(join(f.root,'sync-history')))[0]);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    expect(JSON.parse(await readFile(join(evidence,'local.review.json'),'utf8'))).toEqual(before.review);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(remote);
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8'))).toEqual(f.remote.get('Created1'));
    expect(result.value.snapshot.review.operations.at(-1).summary).toContain(evidence);
    expect(result.value.warning).not.toContain('决定是否采用');expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
    const staged=await f.snapshot(),stagedSidecar=await readFile(f.session.document.reviewPath,'utf8');
    const preview=await f.send('/api/projects/'+f.id+'/preview',{revision:staged.revision,direction:'push'});
    expect(preview.status).toBe(200);expect(preview.value).toMatchObject({status:'equal',localXML:remote,cloudXML:remote});
    expect(await f.snapshot()).toEqual(staged);expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(stagedSidecar);
    expect(f.calls.filter(c=>c==='download')).toHaveLength(2);
    expect(f.calls.filter(c=>c==='create')).toHaveLength(1);expect(f.calls).not.toContain('update');
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    expect(JSON.parse(await readFile(join(evidence,'local.review.json'),'utf8'))).toEqual(before.review);
  });
  it('archives an exactly matching create receipt and conservatively retains no-ID comments for review',async()=>{
    const f=await fixture(),create=f.transport.create;
    f.transport.create=async input=>{const created=await create(input);f.remote.get(created.documentId)!.xml=f.xml;return created;};
    const result=await f.bind({kind:'new',title:'本地稿'});
    expect(result.status).toBe(200);expect(result.value.snapshot.xml).toBe(f.xml);
    expect(result.value.snapshot.review.comments).toEqual(f.review.comments.map(comment=>({...comment,anchor:{...comment.anchor,state:'unverified'}})));
    expect(result.value.snapshot.review.resources).toEqual({version:1,items:[]});
    expect(result.value.snapshot.review.contentSync).toMatchObject({localXML:f.xml,cloudXML:f.xml,localAssets:{}});
    expect(result.value.snapshot.review.contentSync.pending).toBeUndefined();expect(f.calls).not.toContain('download');
    const evidence=join(f.root,'sync-history',(await readdir(join(f.root,'sync-history')))[0]);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(f.xml);expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(f.xml);
    expect(result.value.snapshot.review.operations.at(-1).summary).toContain(evidence);
  });
  it.each(['local-edit','asset-edit'] as const)('retains create intent and receipts if %s happens during cloud readback',async failure=>{
    const f=await fixture(),create=f.transport.create,fetch=f.transport.fetch,xml=f.xml+'<img path="@./asset.png"/>';
    const review=structuredClone(f.review);review.document.xml=xml;
    await writeFile(f.path,xml);await writeFile(f.session.document.reviewPath,JSON.stringify(review));await writeFile(join(f.root,'asset.png'),png);
    f.transport.create=async input=>{const result=await create(input);f.remote.get(result.documentId)!.xml='<title id="Created1">本地稿</title><whiteboard token="board"/>';return result;};
    f.transport.fetch=async ref=>{
      const result=await fetch(ref);
      if(failure==='local-edit')await writeFile(f.path,xml+'<p>并发修改</p>');
      else await writeFile(join(f.root,'asset.png'),Buffer.concat([png,Buffer.from('changed')]));
      return result;
    };
    // Downloads succeed so this case exercises the final revision guard, not a downloader failure.
    f.transport.download=async input=>{f.calls.push('download');await writeFile(input.outputPath,png);return {path:input.outputPath};};
    const result=await f.bind({kind:'new',title:'本地稿'});
    expect(result.status).toBe(200);expect(result.value.warning).toContain('勿重复');
    expect(await readFile(f.path,'utf8')).toBe(failure==='local-edit'?xml+'<p>并发修改</p>':xml);
    const sidecar=JSON.parse(await readFile(f.session.document.reviewPath,'utf8'));
    expect(sidecar.contentSync).toMatchObject({documentId:'Created1',pending:{direction:'create',sourceXML:xml}});
    expect(sidecar.comments).toEqual(review.comments);expect((await f.store.get(f.id))!.cloud?.documentId).toBe('Created1');
    const evidence=join(f.root,'sync-history',(await readdir(join(f.root,'sync-history')))[0]);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe(f.remote.get('Created1')!.xml);
    expect(JSON.parse(await readFile(join(evidence,'cloud-after.json'),'utf8')).xml).toBe(f.remote.get('Created1')!.xml);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(xml);
    if(failure==='local-edit')expect(f.calls).toContain('download');else expect(f.calls).not.toContain('download');
    expect((await f.bind({kind:'new',title:'本地稿'})).status).toBe(409);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it('keeps the acknowledged cloud identity and original draft when automatic adoption cannot download resources',async()=>{
    const f=await fixture(),create=f.transport.create;
    f.transport.create=async input=>{const result=await create(input);f.remote.get(result.documentId)!.xml='<img token="image"/>';return result;};
    const result=await f.bind({kind:'new',title:'本地稿'});
    expect(result.status).toBe(200);expect(result.value.warning).toContain('勿重复');
    expect(result.value.snapshot.xml).toBe(f.xml);expect(result.value.session.project.cloud.documentId).toBe('Created1');
    expect(result.value.snapshot.review.contentSync.pending).toMatchObject({direction:'create',sourceXML:f.xml});
    const evidence=join(f.root,'sync-history',(await readdir(join(f.root,'sync-history')))[0]);
    expect(await readFile(join(evidence,'local.xml'),'utf8')).toBe(f.xml);
    expect(await readFile(join(evidence,'cloud.xml'),'utf8')).toBe('<img token="image"/>');
    expect(f.calls.filter(c=>c==='download')).toHaveLength(1);
    expect((await f.bind({kind:'new',title:'本地稿'})).status).toBe(409);
    const preview=await f.send('/api/projects/'+f.id+'/preview',{revision:result.value.snapshot.revision,direction:'push'});
    expect(preview.value.code).toBe('SYNC_PENDING');expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it.each(['create','fetch'] as const)('leaves durable intent after an uncertain %s and never creates twice',async failure=>{
    const f=await fixture(),create=f.transport.create;
    if(failure==='create')f.transport.create=async input=>{await create(input);throw new Error('receipt lost');};
    else f.transport.fetch=async()=>{throw new Error('readback unavailable');};
    const result=await f.bind({kind:'new',title:'本地稿'});expect(result.status).toBe(200);expect(result.value.warning).toContain('勿重复');
    expect(result.value.snapshot.review.contentSync.pending.direction).toBe('create');
    expect(result.value.snapshot.review.contentSync.documentId).toBe(failure==='create'?'':'Created1');
    expect((await f.bind({kind:'new',title:'本地稿'})).status).toBe(409);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
    expect(await readFile(f.path,'utf8')).toBe(f.xml);
  });
  it('validates missing local assets before writing intent or invoking cloud create',async()=>{
    const f=await fixture();await writeFile(f.path,f.xml+'<img path="@missing.png"/>');const before=await readFile(f.session.document.reviewPath,'utf8');
    expect((await f.bind({kind:'new',title:'本地稿'})).status).toBeGreaterThanOrEqual(400);expect(f.calls).toEqual([]);
    expect(await readFile(f.session.document.reviewPath,'utf8')).toBe(before);
  });
  it('respects a review synchronization lock held by another process',async()=>{
    const f=await fixture(),lock=f.session.document.reviewPath+'.sync.lock';await writeFile(lock,'held');
    expect((await f.bind()).value.code).toBe('CLOUD_BUSY');expect(f.calls).toEqual([]);
    expect(await readFile(lock,'utf8')).toBe('held');expect((await f.store.get(f.id))!.cloud).toBeUndefined();
  });
  it('retains the created identity and pending state when the new document readback has a different identity',async()=>{
    const f=await fixture();f.transport.fetch=async()=>structuredClone(f.remote.get('DocB')!);
    const result=await f.bind({kind:'new',title:'本地稿'});expect(result.status).toBe(200);expect(result.value.warning).toContain('勿重复');
    expect(result.value.snapshot.review.contentSync.documentId).toBe('Created1');expect(result.value.snapshot.review.contentSync.pending.direction).toBe('create');
    expect(result.value.session.project.cloud.documentId).toBe('Created1');expect(await readFile(f.path,'utf8')).toBe(f.xml);
    expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it('blocks saves, switching, creation, shared-directory changes and a second bind while binding',async()=>{
    const f=await fixture(),entered=deferred(),release=deferred(),fetch=f.transport.fetch;
    f.transport.fetch=async ref=>{entered.resolve();await release.promise;return fetch(ref);};
    const before=await f.snapshot(),pending=f.bind(undefined,before.revision);await entered.promise;
    try{
      const requests:[string,unknown,string?][]=[['/api/projects/'+f.id+'/open',{}],['/api/open',{path:f.path}],['/api/pick',{}],
        ['/api/project-settings',{shared:true}],['/api/projects',{name:'new',local:{kind:'new',path:join(f.root,'new.xml')},cloud:{kind:'none'},defaultDirection:'pull'}],
        ['/api/document?id='+f.session.document.id,{xml:f.xml,review:f.review,revision:before.revision},'PUT'],
        ['/api/projects/'+f.id+'/bind',{revision:before.revision,cloud:{kind:'new',title:'no'},defaultDirection:'push'}]];
      for(const [route,input,method] of requests)expect((await f.send(route,input,method)).status).toBe(409);
    }finally{release.resolve();}
    expect((await pending).status).toBe(200);expect(f.calls).toEqual(['fetch']);
  });
  it('rejects malformed or injected bind parameters and missing CLI configuration',async()=>{
    const f=await fixture(false),revision=(await f.snapshot()).revision;
    expect((await f.bind()).value.code).toBe('CLOUD_UNAVAILABLE');
    for(const input of [{revision,cloud:{kind:'none'},defaultDirection:'push'},{revision,cloud:{kind:'new',title:''},defaultDirection:'push'},
      {revision,cloud:{kind:'existing',url:'x'},defaultDirection:'push',command:'/bin/sh'}])
      expect((await f.send('/api/projects/'+f.id+'/bind',input)).value.code).toBe('INVALID_REQUEST');
    expect(f.calls).toEqual([]);
  });
  it('exposes the home path and only expands the exact ~/ prefix when creating a local project',async()=>{
    const f=await fixture(false),path=join(f.root,'tilde.xml');expect(f.session.homeDirectory).toBe(homedir());
    const result=await f.send('/api/projects',{name:'tilde',local:{kind:'new',path:'~/'+relative(homedir(),path)},cloud:{kind:'none'},defaultDirection:'pull'});
    expect(result.status).toBe(200);expect(result.value.session.project.localPath).toBe(path);
    for(const invalid of ['~someone/doc.xml','$HOME/doc.xml'])expect((await f.send('/api/projects',
      {name:'bad',local:{kind:'new',path:invalid},cloud:{kind:'none'},defaultDirection:'pull'})).value.code).toBe('INVALID_REQUEST');
  });
});
