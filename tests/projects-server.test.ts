import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {createLocalServer} from '../src/server/server';
import {openProjectStore} from '../src/server/projects';
import type {ContentTransport,ContentDocument} from '../src/server/content-cli';
import {createReview,type Snapshot} from '../src/core/types';

const folders:string[]=[],servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function fixture(cloudAvailable=true){
  const root=await realpath(await mkdtemp(join(tmpdir(),'review-project-http-')));folders.push(root);
  const site=join(root,'site');await mkdir(site);await writeFile(join(site,'index.html'),'<main>Review</main>');
  const file=join(root,'initial.xml');await writeFile(file,'<title>本地初稿</title><p id="a">本地正文</p>');
  const catalog=join(root,'projects.json'),store=await openProjectStore(catalog);
  const remote=new Map<string,ContentDocument>([['DocA',{documentId:'DocA',url:'https://www.feishu.cn/docx/DocA',revision:1,xml:'<title>云端 A</title><p id="a">云端 A 正文</p>'}],
    ['DocB',{documentId:'DocB',url:'https://www.feishu.cn/docx/DocB',revision:1,xml:'<title>云端 B</title><p id="b">云端 B 正文</p>'}]]);
  const calls:string[]=[],commentTargets:string[]=[];let createCount=0;
  const transport:ContentTransport={
    async fetch(ref){calls.push('fetch:'+ref);const id=ref.includes('wiki')?'DocA':ref.split('/').pop()!;const doc=remote.get(id);if(!doc)throw new Error('missing cloud');return structuredClone(doc);},
    async create({contentPath,title}){calls.push('create');const documentId='Created'+(++createCount),url='https://www.feishu.cn/docx/'+documentId;remote.set(documentId,{documentId,url,revision:1,xml:await readFile(contentPath,'utf8')});return {documentId,url,warnings:['访问权需在飞书中核对']};},
    async update(input){calls.push('update:'+input.documentId);const doc=remote.get(input.documentId)!;const xml=await readFile(input.contentPath!,'utf8');
      if(input.command==='overwrite')doc.xml=xml;
      else if(input.command==='append')doc.xml+=xml;
      else {const re=new RegExp('<p id="'+input.blockId+'">.*?</p>');doc.xml=doc.xml.replace(re,xml.replace('<p>','<p id="'+input.blockId+'">'));}
      doc.revision++;
    },
    async download({outputPath}){calls.push('download');await writeFile(outputPath,Buffer.from([137,80,78,71,13,10,26,10,0]));return {path:outputPath};}
  };
  const server=await createLocalServer(site,file,{projects:{store,historyRoot:join(root,'history'),...(cloudAvailable?{transport,comments:(project)=>project.cloud?{
    ...project.cloud,localPath:project.localPath,transport:{
      async read(){commentTargets.push(project.cloud!.documentId);return {documentId:project.cloud!.documentId,xml:remote.get(project.cloud!.documentId)!.xml,comments:[]};},
      async create(){throw new Error('not expected');},async reply(){throw new Error('not expected');},async resolve(){throw new Error('not expected');}
    }}:undefined}:{})}});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const get=async(path:string)=>{const response=await fetch(url+path);return {status:response.status,value:await response.json()};};
  const session=(await get('/api/session')).value;
  const send=async(path:string,input:unknown,method='POST')=>{const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};};
  const create=(name:string,cloud='DocA',kind:'new'|'existing'='new',path=join(root,name+'.xml'))=>send('/api/projects',{name,local:{kind,path},cloud:cloud?{kind:'existing',url:'https://www.feishu.cn/docx/'+cloud}:{kind:'none'},defaultDirection:'pull'});
  return {root,file,catalog,store,remote,calls,transport,commentTargets,get,send,create,session};
}

describe('multi-project actual HTTP and filesystem journeys',()=>{
  it('bootstraps one project, creates pure local files and persists registration across store instances',async()=>{
    const f=await fixture(false);expect(f.session.project.localPath).toBe(f.file);expect(f.session.cloud).toBeUndefined();
    const a=await f.create('纯本地','');expect(a.status).toBe(200);expect(a.value.snapshot.xml).toContain('<title>纯本地</title>');
    expect(a.value.session.project.cloud).toBeUndefined();expect(f.calls).toEqual([]);
    expect((await stat(a.value.session.document.path)).mode&0o777).toBe(0o600);
    expect((await (await openProjectStore(f.catalog)).list()).map(p=>p.id)).toContain(a.value.session.project.id);
    expect((await f.get('/api/projects')).value.cloudAvailable).toBe(false);
  });
  it('imports a remote new local project with a sidecar baseline, then switches body/comment target/resources together',async()=>{
    const f=await fixture();f.remote.get('DocA')!.xml+='<img src="imageA"/>';
    const a=(await f.create('A')).value,b=(await f.create('B','DocB')).value;
    expect(a.snapshot.review.contentSync.documentId).toBe('DocA');expect(a.snapshot.review.resources.items).toHaveLength(1);
    expect((await f.get('/api/session')).value.cloud.documentId).toBe('DocB');
    const opened=await f.send('/api/projects/'+a.session.project.id+'/open',{});
    expect(opened.value.session.document.path).toBe(join(f.root,'A.xml'));expect(opened.value.snapshot.xml).toContain('云端 A 正文');
    expect(opened.value.session.cloud.documentId).toBe('DocA');
    await f.send('/api/cloud-sync?id='+a.session.document.id,{revision:opened.value.snapshot.revision});
    expect(f.commentTargets).toEqual(['DocA']);
    expect(b.snapshot.review.contentSync.documentId).toBe('DocB');
    expect(await readFile(f.file,'utf8')).toContain('本地正文');
  });
  it('only binds existing endpoints until an explicit preview and sync; Wiki binds the underlying Docx identity',async()=>{
    const f=await fixture(),path=join(f.root,'existing.xml'),xml='<title>独立稿</title><p>保留人工内容</p>';
    await writeFile(path,xml);
    const result=await f.send('/api/projects',{name:'已有稿',local:{kind:'existing',path},cloud:{kind:'existing',url:'https://www.feishu.cn/wiki/WikiA?from=share'},defaultDirection:'push'});
    expect(result.status).toBe(200);expect(result.value.session.project.cloud.documentId).toBe('DocA');expect(result.value.snapshot.review).toBeNull();
    expect(await readFile(path,'utf8')).toBe(xml);expect(f.calls.filter(c=>c.startsWith('update'))).toEqual([]);
    const preview=await f.send('/api/projects/'+result.value.session.project.id+'/preview',{revision:result.value.snapshot.revision,direction:'push'});
    expect(preview.value.status).toBe('conflict');expect(preview.value.localXML).toBe(xml);expect(preview.value.cloudXML).toContain('云端 A');
    expect(f.calls.filter(c=>c.startsWith('update'))).toEqual([]);
  });
  it('rejects duplicate local/cloud bindings and wrong-project preview tokens without writing either endpoint',async()=>{
    const f=await fixture(),a=(await f.create('A')).value,b=(await f.create('B','DocB')).value;
    expect((await f.create('duplicate','DocA')).status).toBe(409);
    expect((await f.create('again','', 'existing',a.session.document.path)).status).toBe(409);
    const p=(await f.send('/api/projects/'+a.session.project.id+'/preview',{revision:a.snapshot.revision,direction:'push'})).value;
    expect((await f.send('/api/projects/'+b.session.project.id+'/sync',{previewId:p.id})).status).toBe(409);
    expect(f.calls.filter(c=>c.startsWith('update'))).toEqual([]);
  });
  it('saves local edit, previews, pushes one changed block and independently reads the final disk and cloud',async()=>{
    const f=await fixture(),a=(await f.create('A')).value,id=a.session.project.id;
    const xml=a.snapshot.xml.replace('云端 A 正文','人类审阅后改稿'),review=structuredClone(a.snapshot.review);review.document.xml=xml;
    const saved=await f.send('/api/document?id='+a.session.document.id,{xml,review,revision:a.snapshot.revision},'PUT');expect(saved.status).toBe(200);
    const p=await f.send('/api/projects/'+id+'/preview',{revision:saved.value.revision,direction:'push'});expect(p.value.status).toBe('ready');
    const applied=await f.send('/api/projects/'+id+'/sync',{previewId:p.value.id});expect(applied.status).toBe(200);
    expect(f.remote.get('DocA')!.xml).toContain('人类审阅后改稿');expect(await readFile(a.session.document.path,'utf8')).toBe(f.remote.get('DocA')!.xml);
    const disk=JSON.parse(await readFile(a.session.document.reviewPath,'utf8'));expect(disk.contentSync.pending).toBeUndefined();expect(disk.contentSync.cloudRevision).toBe(2);
    expect((await f.send('/api/projects/'+id+'/sync',{previewId:p.value.id})).status).toBe(409);
    const equal=await f.send('/api/projects/'+id+'/preview',{revision:applied.value.snapshot.revision,direction:'push'});expect(equal.value.status).toBe('equal');
    expect(f.calls.filter(c=>c.startsWith('update'))).toEqual(['update:DocA']);
  });
  it('blocks stale preview after external cloud or local edits, then pulls only after a fresh preview',async()=>{
    const f=await fixture(),a=(await f.create('A')).value,id=a.session.project.id;
    f.remote.get('DocA')!.xml+='<p>云端独立新增</p>';f.remote.get('DocA')!.revision++;
    const p=(await f.send('/api/projects/'+id+'/preview',{revision:a.snapshot.revision,direction:'pull'})).value;
    f.remote.get('DocA')!.xml+='<p>又有新改动</p>';f.remote.get('DocA')!.revision++;
    expect((await f.send('/api/projects/'+id+'/sync',{previewId:p.id})).status).toBe(409);
    expect(await readFile(a.session.document.path,'utf8')).toBe(a.snapshot.xml);
    const fresh=(await f.send('/api/projects/'+id+'/preview',{revision:a.snapshot.revision,direction:'pull'})).value;
    const result=await f.send('/api/projects/'+id+'/sync',{previewId:fresh.id});expect(result.status).toBe(200);expect(result.value.snapshot.xml).toContain('又有新改动');
    const next=(await f.send('/api/projects/'+id+'/preview',{revision:result.value.snapshot.revision,direction:'pull'})).value;
    await writeFile(a.session.document.path,'<p>AI 外部修改</p>');
    expect((await f.send('/api/projects/'+id+'/sync',{previewId:next.id})).status).toBe(409);expect(await readFile(a.session.document.path,'utf8')).toBe('<p>AI 外部修改</p>');
  });
  it('leaves an uncertain cloud write pending and refuses a blind retry',async()=>{
    const f=await fixture(),a=(await f.create('A')).value,id=a.session.project.id;
    const xml=a.snapshot.xml.replace('云端 A 正文','改稿');const review=structuredClone(a.snapshot.review);review.document.xml=xml;
    const s=(await f.send('/api/document?id='+a.session.document.id,{xml,review,revision:a.snapshot.revision},'PUT')).value;
    const p=(await f.send('/api/projects/'+id+'/preview',{revision:s.revision,direction:'push'})).value;
    const update=f.transport.update;f.transport.update=async input=>{await update(input);throw new Error('receipt lost');};
    expect((await f.send('/api/projects/'+id+'/sync',{previewId:p.id})).status).toBe(502);
    const disk=(await f.get('/api/document?id='+a.session.document.id)).value;expect(disk.review.contentSync.pending.direction).toBe('push');
    expect((await f.send('/api/projects/'+id+'/preview',{revision:disk.revision,direction:'push'})).value.code).toBe('SYNC_PENDING');
    expect(f.calls.filter(c=>c.startsWith('update'))).toHaveLength(1);
  });
  it('creates a cloud document once, preserves permission warning and records its resolved binding',async()=>{
    const f=await fixture();
    const result=await f.send('/api/projects',{name:'新稿',local:{kind:'new',path:join(f.root,'new.xml')},cloud:{kind:'new',title:'新稿'},defaultDirection:'push'});
    expect(result.status).toBe(200);expect(result.value.session.project.cloud.documentId).toBe('Created1');expect(result.value.warning).toContain('访问权');
    expect(result.value.snapshot.review.contentSync.pending).toBeUndefined();expect(result.value.snapshot.review.contentSync.documentId).toBe('Created1');
    expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
    expect((await f.store.get(result.value.session.project.id))!.cloud?.documentId).toBe('Created1');
  });
  it('does not lose or recreate a cloud project when creation returned an uncertain result',async()=>{
    const f=await fixture(),create=f.transport.create;f.transport.create=async input=>{await create(input);throw new Error('lost');};
    const input={name:'未确认',local:{kind:'new',path:join(f.root,'uncertain.xml')},cloud:{kind:'new',title:'未确认'},defaultDirection:'push'};
    const result=await f.send('/api/projects',input);expect(result.status).toBe(200);expect(result.value.warning).toContain('勿重复');
    expect(result.value.snapshot.review.contentSync.pending.direction).toBe('create');expect((await f.store.list()).length).toBe(2);
    expect((await f.send('/api/projects',input)).status).toBe(409);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
  });
  it('rejects injected CLI fields, existing sidecar collisions, and cloud creation without a configured profile',async()=>{
    const f=await fixture(false),path=join(f.root,'reserved.xml');await writeFile(join(f.root,'reserved.review.json'),'KEEP');
    expect((await f.create('reserved','', 'new',path)).status).toBe(409);expect(await readFile(join(f.root,'reserved.review.json'),'utf8')).toBe('KEEP');
    expect((await f.create('cloud')).status).toBe(400);
    expect((await f.send('/api/projects',{name:'x',local:{kind:'new',path:join(f.root,'x.xml')},cloud:{kind:'none'},defaultDirection:'pull',command:'/bin/sh'})).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  it('opening an unregistered local file never inherits the previous cloud target',async()=>{
    const f=await fixture();await f.create('A');const path=join(f.root,'loose.xml');await writeFile(path,'<p>独立内容</p>');
    const result=await f.send('/api/open',{path});expect(result.status).toBe(200);
    const s=(await f.get('/api/session')).value;expect(s.document.path).toBe(path);expect(s.cloud).toBeUndefined();expect(s.project).toBeUndefined();
    const snapshot=(await f.get('/api/document?id='+s.document.id)).value;
    expect((await f.send('/api/cloud-sync?id='+s.document.id,{revision:snapshot.revision})).status).toBe(403);
  });
  it('refuses creating a new cloud document from a local file already linked by comment sync',async()=>{
    const f=await fixture(),path=join(f.root,'legacy-comments.xml'),xml='<title>旧云稿</title><p>原始内容保留</p>';
    await writeFile(path,xml);
    const review=createReview('legacy-comments.xml',xml);
    review.cloudSync={version:1,documentId:'DocB',url:'https://www.feishu.cn/docx/DocB',links:[]};
    const sidecar=join(f.root,'legacy-comments.review.json');await writeFile(sidecar,JSON.stringify(review));
    const before=await readFile(sidecar,'utf8'),count=(await f.store.list()).length;
    const result=await f.send('/api/projects',{name:'误建',local:{kind:'existing',path},cloud:{kind:'new',title:'不应该创建'},defaultDirection:'push'});
    expect(result.status).toBe(409);expect(result.value.code).toBe('CLOUD_BINDING');
    expect(f.calls).not.toContain('create');expect((await f.store.list()).length).toBe(count);
    expect(await readFile(path,'utf8')).toBe(xml);expect(await readFile(sidecar,'utf8')).toBe(before);
  });
  it('validates missing local assets before registering a project or creating a cloud document',async()=>{
    const f=await fixture(),path=join(f.root,'missing-asset.xml'),xml='<title>先验素材</title><img path="@does-not-exist.png"/>';
    await writeFile(path,xml);const count=(await f.store.list()).length;
    const result=await f.send('/api/projects',{name:'缺失素材',local:{kind:'existing',path},cloud:{kind:'new',title:'预检失败不能创建'},defaultDirection:'push'});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await f.store.list()).length).toBe(count);expect(f.calls).not.toContain('create');
    expect(await readFile(path,'utf8')).toBe(xml);
    await expect(readFile(join(f.root,'missing-asset.review.json'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('keeps comment synchronization compatible when an existing Wiki binding resolves to the same Docx project',async()=>{
    const f=await fixture(),path=join(f.root,'wiki-legacy.xml');
    f.remote.get('DocA')!.xml=f.remote.get('DocA')!.xml.replace('<title>','<title id="DocA">');
    const xml=f.remote.get('DocA')!.xml;await writeFile(path,xml);
    const review=createReview('wiki-legacy.xml',xml);
    review.cloudSync={version:1,documentId:'DocA',url:'https://www.feishu.cn/wiki/WikiA',links:[]};
    await writeFile(join(f.root,'wiki-legacy.review.json'),JSON.stringify(review));
    const result=await f.create('旧Wiki绑定','DocA','existing',path);expect(result.status).toBe(200);
    expect(result.value.session.project.cloud.documentId).toBe('DocA');
    const sync=await f.send('/api/cloud-sync?id='+result.value.session.document.id,{revision:result.value.snapshot.revision});
    expect(sync.status).toBe(200);expect(f.commentTargets).toEqual(['DocA']);
    expect(await readFile(path,'utf8')).toBe(xml);
  });
});
