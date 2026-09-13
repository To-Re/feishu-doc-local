import {afterEach,describe,expect,it,vi} from 'vitest';
import {link,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SyncService} from '../src/service';
import {createContentCLI,type ContentCLIRunner} from '../../src/server/content-cli';
import {openLocalFile} from '../../src/server/files';
import {openProjectStore} from '../../src/server/projects';
import {prepareCloudImport,importCloudDocument} from '../src/import';
import {createReview} from '../../src/core/types';

const url='https://example.feishu.cn/docx/Doc',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHXsAAAAASUVORK5CYII=','base64');
const folders:string[]=[],ok=(data:unknown)=>JSON.stringify({ok:true,data});
const get=(args:readonly string[],name:string)=>args[args.indexOf(name)+1];
afterEach(async()=>{vi.useRealTimers();await Promise.all(folders.splice(0).map(folder=>rm(folder,{recursive:true,force:true})));});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'obsidian-cloud-import-')));folders.push(root);
  let xml='<title id="Doc">导入标题</title><p id="P">已有云端正文</p>',revision=1,documentId='Doc',fetches=0;
  const hooks:{fetch?:(count:number)=>Promise<void>;download?:()=>Promise<void>}={},calls:string[][]=[];
  const profile={command:'/configured/lark-cli',args:[]};
  const runner:ContentCLIRunner=async(command,args)=>{
    expect(command).toBe(profile.command);calls.push([...args]);expect(args.slice(-2)).toEqual(['--format','json']);
    if(args.includes('+fetch')){fetches++;await hooks.fetch?.(fetches);return ok({document:{document_id:documentId,url:`https://example.feishu.cn/docx/${documentId}`,content:xml,revision_id:revision}});}
    if(args.includes('+media-download')){
      await hooks.download?.();const output=get(args,'--output'),bytes=get(args,'--token')==='Attachment'?Buffer.from('附件正文'):png;
      await writeFile(output,bytes,{flag:'wx'});return ok({saved_path:output,size_bytes:bytes.length,content_type:get(args,'--token')==='Attachment'?'text/plain':'image/png'});
    }
    throw new Error('Import must not issue a cloud write');
  };
  const service=new SyncService({vaultRoot:root,catalogPath:join(root,'projects.json'),profile,runner});
  return {root,service,hooks,calls,runner,profile,get xml(){return xml;},set xml(value:string){xml=value;},set revision(value:number){revision=value;},set documentId(value:string){documentId=value;}};
}
const missing=async(path:string)=>expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'});

describe('explicit cloud import to a new Obsidian document',()=>{
  it('previews without document writes and imports original IDs, resources and a shared baseline',async()=>{
    const t=await fixture();await mkdir(join(t.root,'Notes'));
    t.xml+='<img id="Image" token="Photo"/><figure><source id="File" token="Attachment" name="notes.txt"/></figure><whiteboard id="Board" token="Drawing"/>';
    const prepared=await t.service.prepareImport({url,path:'Notes/imported.xml'});
    expect(prepared).toMatchObject({title:'导入标题',xml:t.xml,documentId:'Doc',vaultPath:'Notes/imported.xml'});
    expect(Object.isFrozen(prepared)).toBe(true);expect(Object.isFrozen(prepared.warnings)).toBe(true);
    expect(await readdir(join(t.root,'Notes'))).toEqual([]);expect(t.calls).toHaveLength(1);
    await expect(t.service.importDocument({...prepared})).rejects.toThrow('预览无效');
    const result=await t.service.importDocument(prepared),path=join(t.root,result.vaultPath),snapshot=await (await openLocalFile(path,{readOnly:true})).read();
    expect(snapshot.xml).toBe(t.xml);expect(snapshot.review?.document.baselineXML).toBe(t.xml);
    expect(snapshot.review?.contentSync).toMatchObject({documentId:'Doc',localXML:t.xml,cloudXML:t.xml,cloudRevision:1});
    expect(snapshot.review?.resources?.items).toHaveLength(3);
    for(const item of snapshot.review!.resources!.items){
      expect(item.path).toMatch(/^feishu-assets-[^/]+\//);expect((await lstat(join(t.root,'Notes',item.path))).nlink).toBe(1);
      expect(await readFile(join(t.root,'Notes',item.path))).toEqual(item.value==='Attachment'?Buffer.from('附件正文'):png);
    }
    expect(result.project).toMatchObject({cloud:{documentId:'Doc',url},defaultDirection:'pull',localPath:path});
    expect(await t.service.openProject(result.project.id)).toMatchObject({vaultPath:'Notes/imported.xml'});
    expect(await readFile(join(result.evidencePath,'cloud.xml'),'utf8')).toBe(t.xml);
    expect(t.calls.every(args=>args.includes('+fetch')||args.includes('+media-download'))).toBe(true);
    await expect(t.service.importDocument(prepared)).rejects.toThrow('已使用');
  });
  it.each(['xml','sidecar','symlink','hardlink','directory','fifo'])('rejects an existing %s without reading the cloud or replacing it',async kind=>{
    const t=await fixture(),path=join(t.root,'new.xml'),sidecar=join(t.root,'new.review.json'),sentinel=join(t.root,'original.txt');await writeFile(sentinel,'existing private content');
    if(kind==='xml')await writeFile(path,'existing XML');
    if(kind==='sidecar')await writeFile(sidecar,'existing sidecar');
    if(kind==='symlink')await symlink(sentinel,path);
    if(kind==='hardlink')await link(sentinel,path);
    if(kind==='directory')await mkdir(path);
    if(kind==='fifo')execFileSync('mkfifo',[path]);
    await expect(t.service.prepareImport({url,path:'new.xml'})).rejects.toThrow('已存在');expect(t.calls).toEqual([]);
    expect(await readFile(sentinel,'utf8')).toBe('existing private content');
    if(kind==='sidecar'){expect(await readFile(sidecar,'utf8')).toBe('existing sidecar');await missing(path);}
    if(kind==='xml')expect(await readFile(path,'utf8')).toBe('existing XML');
  });
  it.each(['../escape.xml','/absolute.xml','nested/../escape.xml','nested\\file.xml','.obsidian/file.xml','.hidden.xml','nested//file.xml','x/./file.xml','new.txt',' new.xml','x:stream.xml'])('rejects unsafe destination %s before CLI',async path=>{
    const t=await fixture();await expect(t.service.prepareImport({url,path})).rejects.toThrow();expect(t.calls).toEqual([]);
  });
  it('rejects missing and symlinked parent directories before CLI, including an in-vault alias',async()=>{
    const t=await fixture();await mkdir(join(t.root,'real'));await symlink(join(t.root,'real'),join(t.root,'alias'));
    for(const path of ['missing/new.xml','alias/new.xml'])await expect(t.service.prepareImport({url,path})).rejects.toThrow();
    expect(t.calls).toEqual([]);expect(await readdir(join(t.root,'real'))).toEqual([]);
  });
  it('rejects a cloud document already registered with another XML, including after preview',async()=>{
    const t=await fixture(),prepared=await t.service.prepareImport({url,path:'new.xml'}),existing=join(t.root,'existing.xml');
    await writeFile(existing,'<p>已有本地稿</p>');await t.service.bind(existing,{kind:'existing',url},'pull');
    await expect(t.service.importDocument(prepared)).rejects.toThrow('已经属于另一个项目');
    await expect(t.service.prepareImport({url,path:'another.xml'})).rejects.toThrow('已经属于另一个项目');
    await missing(join(t.root,'new.xml'));await missing(join(t.root,'another.xml'));
    expect(await readFile(existing,'utf8')).toBe('<p>已有本地稿</p>');
  });
  it.each(['revision','xml','wiki-identity','expired'])('rejects a stale %s preview before creating the document',async kind=>{
    const t=await fixture();vi.useFakeTimers({toFake:['Date']});
    const prepared=await t.service.prepareImport({url:kind==='wiki-identity'?'https://example.feishu.cn/wiki/Wiki':url,path:'new.xml'});
    if(kind==='revision')t.revision=2;if(kind==='xml')t.xml='<p id="P">new cloud XML</p>';if(kind==='wiki-identity')t.documentId='Other';if(kind==='expired')vi.advanceTimersByTime(300_001);
    await expect(t.service.importDocument(prepared)).rejects.toThrow(kind==='expired'?'过期':'变化');
    await missing(join(t.root,'new.xml'));await missing(join(t.root,'new.review.json'));
  });
  it.each(['xml','sidecar'])('preserves a %s created while the confirmation re-fetch is running',async kind=>{
    const t=await fixture(),prepared=await t.service.prepareImport({url,path:'new.xml'}),target=join(t.root,kind==='xml'?'new.xml':'new.review.json');
    t.hooks.fetch=async count=>{if(count===2)await writeFile(target,'User-created content');};
    await expect(t.service.importDocument(prepared)).rejects.toThrow('已存在');expect(await readFile(target,'utf8')).toBe('User-created content');
    await missing(join(t.root,kind==='xml'?'new.review.json':'new.xml'));
  });
  it('rejects a parent folder replacement during fetch without writing into its replacement',async()=>{
    const t=await fixture();await mkdir(join(t.root,'Notes'));const prepared=await t.service.prepareImport({url,path:'Notes/new.xml'});
    t.hooks.fetch=async count=>{if(count===2){await rename(join(t.root,'Notes'),join(t.root,'old'));await mkdir(join(t.root,'Notes'));}};
    await expect(t.service.importDocument(prepared)).rejects.toThrow('目录已变化');expect(await readdir(join(t.root,'Notes'))).toEqual([]);
  });
  it.each(['@private.txt','@../secret.txt','@/absolute.txt'])('rejects cloud resource path %s instead of reading local vault content',async resourcePath=>{
    const t=await fixture();await writeFile(join(t.root,'private.txt'),'private');t.xml+=`<source token="Attachment" path="${resourcePath}"/>`;
    await expect(t.service.prepareImport({url,path:'new.xml'})).rejects.toThrow('本地资源 path');expect(t.calls).toHaveLength(1);await missing(join(t.root,'new.xml'));
  });
  it('keeps cloud recovery evidence after a resource failure, without registering or creating a document',async()=>{
    const t=await fixture();t.xml+='<img token="Photo"/>';const prepared=await t.service.prepareImport({url,path:'new.xml'});
    t.hooks.download=async()=>{throw new Error('Mock download failure');};
    await expect(t.service.importDocument(prepared)).rejects.toThrow('恢复记录');await missing(join(t.root,'new.xml'));await missing(join(t.root,'new.review.json'));
    expect(await t.service.listProjects()).toEqual([]);
    const evidence=(await readdir(t.root)).find(path=>path.startsWith('.review-import-'))!;
    expect(await readFile(join(t.root,evidence,'cloud.xml'),'utf8')).toBe(t.xml);expect(JSON.parse(await readFile(join(t.root,evidence,'error.json'),'utf8')).message).toBeTruthy();
  });
  it('checks cloud changes again after resource downloads and keeps newer target files',async()=>{
    const t=await fixture();t.xml+='<img token="Photo"/>';const prepared=await t.service.prepareImport({url,path:'new.xml'});
    t.hooks.download=async()=>{t.revision=2;};
    await expect(t.service.importDocument(prepared)).rejects.toThrow('资源下载期间飞书文档已变化');await missing(join(t.root,'new.xml'));
  });
  it.each(['preview','confirm','download'])('stops before document writes when unloaded during %s',async stage=>{
    const t=await fixture();if(stage==='download')t.xml+='<img token="Photo"/>';
    if(stage==='preview'){t.hooks.fetch=async()=>{t.service.dispose();};await expect(t.service.prepareImport({url,path:'new.xml'})).rejects.toThrow('已卸载');}
    else{
      const prepared=await t.service.prepareImport({url,path:'new.xml'});
      if(stage==='confirm')t.hooks.fetch=async()=>{t.service.dispose();};else t.hooks.download=async()=>{t.service.dispose();};
      await expect(t.service.importDocument(prepared)).rejects.toThrow('已卸载');
    }
    await missing(join(t.root,'new.xml'));await missing(join(t.root,'new.review.json'));
  });
  it('preserves user modifications and durable recovery evidence when registration fails after file creation',async()=>{
    const t=await fixture(),realStore=await openProjectStore(join(t.root,'projects.json')),path=join(t.root,'new.xml');
    const store={...realStore,register:async()=>{await writeFile(path,'<p>User edit during registration</p>');throw new Error('Catalog conflict');}};
    const transport=createContentCLI(t.profile,t.runner),plan=await prepareCloudImport(t.root,{url,path:'new.xml'},store,transport,()=>{});
    await expect(importCloudDocument(plan,store,transport,()=>{})).rejects.toThrow('恢复记录');
    expect(await readFile(path,'utf8')).toBe('<p>User edit during registration</p>');
    expect(JSON.parse(await readFile(join(t.root,'new.review.json'),'utf8')).contentSync.documentId).toBe('Doc');
    expect(await realStore.list()).toEqual([]);
  });
  it('uses visible resource caches when pulling into an existing Obsidian project with a hidden image cache',async()=>{
    const t=await fixture();t.xml+='<img token="Photo"/>';const path=join(t.root,'existing.xml');await writeFile(path,t.xml);
    await mkdir(join(t.root,'.review-assets-old'));await writeFile(join(t.root,'.review-assets-old','photo.png'),png);
    const file=await openLocalFile(path),review=createReview(file.name,t.xml);
    review.resources={version:1,items:[{tag:'img',attribute:'token',value:'Photo',path:'.review-assets-old/photo.png',representation:'original'}]};
    review.contentSync={version:1,documentId:'Doc',cloudXML:t.xml,localXML:t.xml,cloudRevision:1,syncedAt:new Date().toISOString()};
    await file.save(t.xml,review,(await file.read()).revision);await t.service.bind(path,{kind:'existing',url},'pull');
    t.xml=t.xml.replace('已有云端正文','更新正文');t.revision=2;
    const result=await t.service.apply(path,await t.service.preview(path,'pull'));
    expect(result.snapshot.review?.resources?.items[0].path).toMatch(/^feishu-assets-/);
    expect(t.calls.filter(args=>args.includes('+media-download'))).toHaveLength(1);
    expect(await readFile(join(t.root,'.review-assets-old','photo.png'))).toEqual(png);
  });
});
