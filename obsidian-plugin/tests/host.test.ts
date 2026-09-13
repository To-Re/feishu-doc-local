import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest, WorkspaceLeaf, TFile as FileType } from 'obsidian';
import { EDITOR_TOOLBAR_EVENT, EDITOR_EXTENSION_CHANGED_EVENT, type EditorToolbarRequest, type EditorController, type EditorHost, type EditorRecovery } from '../../src/browser/host';
import type { BrowserDocument, BrowserDocumentStore } from '../../src/browser/files';
import { createReview } from '../../src/core/types';

const state=vi.hoisted(()=>({roots:[] as Array<{host:EditorHost;unmount:ReturnType<typeof vi.fn>}>,notices:[] as string[],factory:null as null|((directory:string)=>Promise<BrowserDocumentStore>),log:[] as string[]}));
vi.mock('obsidian',()=>{
  class TFile {path:string;name:string;basename:string;extension='xml';parent:{path:string};stat={size:5,mtime:1};constructor(path:string){this.path=path;this.name=path.split('/').at(-1)!;this.basename=this.name.replace(/\.\w+$/,'');this.extension=this.name.split('.').at(-1)!;this.parent={path:path.includes('/')?path.slice(0,path.lastIndexOf('/')):''};}}
  class FileView {app:any;contentEl:HTMLElement;leaf:any;file:any=null;constructor(leaf:any){this.leaf=leaf;this.app=leaf.app;this.contentEl=document.createElement('section');document.body.append(this.contentEl);}}
  class Plugin {app:any;constructor(app:any){this.app=app;}saveData=vi.fn(async()=>{state.log.push('persist');});loadData=async()=>null;registerView(type:string,factory:any){this.app.workspace.factory=factory;}registerExtensions(){}addCommand(){}registerEvent(){} }
  class Modal {app:any;contentEl:HTMLElement;constructor(app:any){this.app=app;this.contentEl=document.createElement('section');document.body.append(this.contentEl);}open(){void(this as any).onOpen?.();}close(){(this as any).onClose?.();}}
  class FuzzySuggestModal extends Modal {setPlaceholder(){} }
  class Notice {constructor(message:string){state.notices.push(message);}}
  return{FileView,FuzzySuggestModal,Modal,Notice,Plugin,TFile};
});
vi.mock('react-dom/client',()=>({createRoot:()=>{const root={unmount:vi.fn(()=>state.log.push('unmount')),render:(node:any)=>{state.roots.push({host:node.props.host,unmount:root.unmount});}};return root;}}));
vi.mock('../../src/browser/BrowserApp',()=>({BrowserApp:()=>null}));
vi.mock('../src/store',()=>({openObsidianDirectory:async(_vault:unknown,directory:string)=>state.factory!(directory)}));
import FeishuDocLocalPlugin,{FeishuXMLView,RecoveryModal} from '../src/plugin';
import { TFile } from 'obsidian';

class Vault {
  files=new Map<string,FileType>();texts=new Map<string,string>();folders=new Set(['','notes','moved']);events=new Map<string,Function>();
  add(path:string,text='<p>磁盘稿</p>'){const file=new (TFile as any)(path) as FileType;this.files.set(path,file);this.texts.set(path,text);return file;}
  move(file:FileType,path:string){const old=file.path,text=this.texts.get(old)!;this.files.delete(old);this.texts.delete(old);Object.assign(file,{path,name:path.split('/').at(-1),basename:path.split('/').at(-1)!.replace(/\.\w+$/,''),parent:{path:path.slice(0,path.lastIndexOf('/'))}});this.files.set(path,file);this.texts.set(path,text);}
  getFileByPath=(path:string)=>this.files.get(path)||null;
  getAbstractFileByPath=(path:string)=>this.files.get(path)||(this.folders.has(path)?{path}:null);
  getFolderByPath=(path:string)=>this.folders.has(path)?{path}:null;
  getFiles=()=>[...this.files.values()];
  read=async(file:FileType)=>this.texts.get(file.path)!;
  create=vi.fn(async(path:string,text:string)=>{if(this.getAbstractFileByPath(path))throw new Error('文件已存在');return this.add(path,text);});
  on=(name:string,callback:Function)=>{this.events.set(name,callback);return{};};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
let vault:Vault,plugin:FeishuDocLocalPlugin,app:any,stores:BrowserDocumentStore[];
const controllers:EditorController[]=[];
const sampleRecovery=(path='notes/a.xml'):EditorRecovery=>({format:'feishu-editor-draft',version:1,path,xml:'<p>恢复有效正文</p>',review:createReview(path.split('/').at(-1)!,'<p>恢复有效正文</p>'),revision:'r1',dirty:true,pending:null,comment:'未发评论',replies:{},invalidSource:{value:'<p>未闭合',error:'XML'},formula:[],whiteboard:[]});
function domHelpers(){
  const create=function(this:HTMLElement,tag:string,options:any={}){const child=document.createElement(tag);if(options.text)child.textContent=options.text;if(options.cls)child.className=options.cls;for(const[key,value]of Object.entries(options.attr||{}))child.setAttribute(key,String(value));this.append(child);return child;};
  Object.defineProperty(HTMLElement.prototype,'createEl',{configurable:true,value:create});Object.defineProperty(HTMLElement.prototype,'createDiv',{configurable:true,value:function(this:HTMLElement,options:any){return create.call(this,'div',options);}});
}
function createStore(directory:string):BrowserDocumentStore{
  const filename=(name:string)=>directory?directory+'/'+name:name;
  const open=async(name:string):Promise<BrowserDocument>=>{const path=filename(name);if(!vault.getFileByPath(path))throw new Error('文件不存在');return{handle:{id:path,name,path,reviewPath:path.replace(/\.xml$/i,'.review.json')},resourceRevision:'assets',assetURL:()=>'',readResource:async()=>({path:'',text:''}),requestPermission:async()=>{},dispose:vi.fn(),read:async()=>({xml:vault.texts.get(path)!,review:vault.texts.has(path.replace(/\.xml$/i,'.review.json'))?JSON.parse(vault.texts.get(path.replace(/\.xml$/i,'.review.json'))!):null,revision:'r1'}),save:async(xml,review)=>{vault.texts.set(path,xml);vault.texts.set(path.replace(/\.xml$/i,'.review.json'),JSON.stringify(review));return{xml,review,revision:'saved'};}};};
  const store:BrowserDocumentStore={directoryName:directory,listDocuments:async()=>[],open,create:async(name)=>{await vault.create(filename(name),'<p/>');return open(name);},dispose:vi.fn(()=>state.log.push('dispose'))};stores.push(store);return store;
}
function view(){const leaf={app,view:null as FeishuXMLView|null,setViewState:async()=>{}};const result=new FeishuXMLView(leaf as unknown as WorkspaceLeaf,plugin);leaf.view=result;app.workspace.leaves.push(leaf);return result;}
async function load(file:FileType){const result=view();result.file=file;await result.onLoadFile(file);return result;}
function ready(host=state.roots.at(-1)!.host,recovery:EditorRecovery|null=null){
  const controller:EditorController={capture:()=>recovery,flush:async()=>true,prepareClose:vi.fn(async()=>{state.log.push('prepare');await host.persistRecovery(recovery);}),acquireSync:vi.fn(async()=>({release:vi.fn(async()=>{})}))};controllers.push(controller);host.onReady(controller);return controller;
}
beforeEach(async()=>{
  state.roots=[];state.notices=[];state.log=[];stores=[];controllers.length=0;vi.stubGlobal('crypto',webcrypto);domHelpers();vault=new Vault();
  app={vault,workspace:{leaves:[] as any[],factory:null as any,getLeavesOfType(){return this.leaves;},events:new Map<string,Set<Function>>(),on(name:string,callback:Function){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name)!.add(callback);return{name,callback};},offref(ref:{name:string;callback:Function}){this.events.get(ref.name)?.delete(ref.callback);},trigger(name:string,request?:unknown){for(const callback of [...(this.events.get(name)||[])])callback(request);},getLeaf(){const leaf:any={app,view:null,setViewState:async(state:any)=>{leaf.view=this.factory(leaf);leaf.view.file=vault.getFileByPath(state.state.file);this.leaves.push(leaf);await leaf.view.onLoadFile(leaf.view.file);}};return leaf;}}};
  plugin=new FeishuDocLocalPlugin(app as App,{} as PluginManifest);await plugin.onload();state.factory=async directory=>createStore(directory);
});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('Obsidian host lifecycle',()=>{
  it('serializes concurrent loads and disposes the stale capability without rendering it',async()=>{
    const a=vault.add('notes/a.xml'),b=vault.add('notes/b.xml'),pending=deferred<BrowserDocumentStore>(),started=deferred<void>(),aStore=createStore('notes');
    let first=true;state.factory=async directory=>{if(first){first=false;started.resolve();return pending.promise;}return createStore(directory);};
    const target=view(),firstLoad=target.onLoadFile(a);await started.promise;const secondLoad=target.onLoadFile(b);pending.resolve(aStore);await Promise.all([firstLoad,secondLoad]);
    expect(state.roots).toHaveLength(1);expect(state.roots[0].host.initial.document.handle.name).toBe('b.xml');expect(aStore.dispose).toHaveBeenCalled();
  });
  it('persists the complete draft before unmount on close, and duplicate close calls are idempotent',async()=>{
    const target=await load(vault.add('notes/a.xml')),controller=ready(undefined,sampleRecovery());state.log=[];
    await Promise.all([target.onUnloadFile(),target.onClose()]);
    expect(controller.prepareClose).toHaveBeenCalledTimes(1);expect(state.log.indexOf('persist')).toBeLessThan(state.log.indexOf('unmount'));
    expect(plugin.drafts.list()).toHaveLength(1);expect((await plugin.drafts.get(plugin.drafts.list()[0].id)).comment).toBe('未发评论');
  });
  it('rejects a stale host registration after switching documents',async()=>{
    const target=await load(vault.add('notes/a.xml')),oldHost=state.roots[0].host;ready(oldHost);await target.onLoadFile(vault.add('notes/b.xml'));
    const current=ready(),stale=ready(oldHost);await target.shutdown();expect(current.prepareClose).toHaveBeenCalledTimes(1);expect(stale.prepareClose).not.toHaveBeenCalled();
    await expect(oldHost.persistRecovery(sampleRecovery())).rejects.toThrow('会话已关闭');
  });
  it('keeps the view and durable snapshot when closing fails',async()=>{
    const target=await load(vault.add('notes/a.xml')),controller=ready(undefined,sampleRecovery());vi.mocked(controller.prepareClose).mockRejectedValueOnce(new Error('无法关闭'));
    await expect(target.shutdown()).rejects.toThrow('无法关闭');expect(state.roots[0].unmount).not.toHaveBeenCalled();expect(plugin.drafts.list()).toHaveLength(1);expect(target.documentPath()).toBe('notes/a.xml');
    await target.shutdown();expect(state.roots[0].unmount).toHaveBeenCalledTimes(1);
  });
  it('retains the original view identity if saving prevents switching to another file',async()=>{
    const a=vault.add('notes/a.xml'),b=vault.add('notes/b.xml'),target=await load(a),controller=ready(undefined,sampleRecovery());
    vi.mocked(controller.prepareClose).mockRejectedValueOnce(new Error('无法保存'));target.file=b;
    await expect(target.onLoadFile(b)).rejects.toThrow('无法保存');expect(target.file).toBe(a);expect(target.documentPath()).toBe(a.path);expect(state.roots).toHaveLength(1);expect(state.roots[0].unmount).not.toHaveBeenCalled();
  });
  it('locks every open view and attempts all releases even if one fails',async()=>{
    const file=vault.add('notes/a.xml');await load(file);const first=ready();await load(file);const second=ready();
    const releaseA=vi.fn(async()=>{throw new Error('回读失败');}),releaseB=vi.fn(async()=>{});
    vi.mocked(first.acquireSync).mockResolvedValue({release:releaseA});vi.mocked(second.acquireSync).mockResolvedValue({release:releaseB});
    const lease=await plugin.acquire(file.path);expect(plugin.isLocked(file.path)).toBe(true);await expect(lease.release()).rejects.toThrow('回读失败');
    expect(releaseA).toHaveBeenCalled();expect(releaseB).toHaveBeenCalled();expect(plugin.isLocked(file.path)).toBe(false);
  });
  it('cleans the path lock if acquiring a later view and releasing an earlier view both fail',async()=>{
    const file=vault.add('notes/a.xml');await load(file);const first=ready();await load(file);const second=ready();
    vi.mocked(first.acquireSync).mockResolvedValue({release:async()=>{throw new Error('release');}});vi.mocked(second.acquireSync).mockRejectedValue(new Error('草稿未完成'));
    await expect(plugin.acquire(file.path)).rejects.toThrow('草稿未完成');expect(plugin.isLocked(file.path)).toBe(false);
  });
  it('blocks sync when a closed view left recovery data, until explicitly discarded',async()=>{
    const file=vault.add('notes/a.xml'),session=await plugin.drafts.open(file.path);await session.write(sampleRecovery());session.close();
    await expect(plugin.acquire(file.path)).rejects.toThrow('恢复草稿');await plugin.drafts.discard(session.id);const lease=await plugin.acquire(file.path);await lease.release();
  });
  it('normal file opening only offers recovery; it never applies an old draft',async()=>{
    const file=vault.add('notes/a.xml'),session=await plugin.drafts.open(file.path);await session.write(sampleRecovery());session.close();await load(file);
    expect(state.roots[0].host.initial.recovery).toBeNull();expect(document.body.textContent).toContain('查看恢复草稿');
  });
  it('renames a document by preserving old sidecar backup and relocating all view drafts',async()=>{
    const file=vault.add('notes/a.xml');vault.add('notes/a.review.json',JSON.stringify(createReview('a.xml','<p>磁盘稿</p>')));
    const target=await load(file);ready(undefined,sampleRecovery());vault.move(file,'notes/renamed.xml');await target.onRename(file);
    expect(vault.texts.has('notes/a.review.json')).toBe(true);expect(JSON.parse(vault.texts.get('notes/renamed.review.json')!).document.name).toBe('renamed.xml');
    expect(plugin.drafts.list()[0].path).toBe('notes/renamed.xml');expect(state.roots.at(-1)!.host.initial.recovery).toBeNull();
  });
  it('refuses to relabel or overwrite a pre-existing sidecar after rename',async()=>{
    const file=vault.add('notes/a.xml'),original=JSON.stringify(createReview('a.xml','<p>磁盘稿</p>')),other=JSON.stringify(createReview('other.xml','<p>另一篇</p>'));
    vault.add('notes/a.review.json',original);vault.add('notes/renamed.review.json',other);const target=await load(file);ready(undefined,sampleRecovery());vault.move(file,'notes/renamed.xml');
    await expect(target.onRename(file)).rejects.toThrow('已有评论文件');expect(vault.texts.get('notes/renamed.review.json')).toBe(other);expect(vault.texts.get('notes/a.review.json')).toBe(original);
    expect(plugin.drafts.list()[0].path).toBe('notes/a.xml');expect(document.body.textContent).toContain('恢复未保存草稿');
  });
  it('accepts an already-moved sidecar after its parent folder was renamed without rewriting it',async()=>{
    const file=vault.add('notes/a.xml'),review=JSON.stringify(createReview('a.xml','<p>磁盘稿</p>')),side=vault.add('notes/a.review.json',review);const target=await load(file);ready();
    vault.move(file,'moved/a.xml');vault.move(side,'moved/a.review.json');await target.onRename(file);expect(vault.texts.get('moved/a.review.json')).toBe(review);expect(vault.create).not.toHaveBeenCalled();
  });
  it('offers an explicit new-file recovery when the source disappeared and never overwrites an existing file',async()=>{
    const session=await plugin.drafts.open('notes/a.xml');await session.write(sampleRecovery());session.close();
    const modal=new RecoveryModal(plugin,session.id);await modal.onOpen();expect(modal.contentEl.textContent).toContain('原文件已移动或删除');expect(modal.contentEl.textContent).toContain('恢复为新文档');
    vault.add('notes/existing.xml','<p>不可覆盖</p>');await expect(plugin.restoreCopy(session.id,'notes','existing.xml')).rejects.toThrow('已存在');expect(vault.texts.get('notes/existing.xml')).toBe('<p>不可覆盖</p>');
    const restored=await plugin.restoreCopy(session.id,'notes','restored.xml');expect(vault.texts.get(restored.path)).toBe(sampleRecovery().xml);expect(plugin.drafts.list()).toHaveLength(2);
    expect(state.roots.at(-1)!.host.initial.recovery!.invalidSource!.value).toBe('<p>未闭合');expect(state.roots.at(-1)!.host.initial.recovery!.revision).toBe('saved');
  });
});


describe('optional extension lifecycle and commands',()=>{
  it('retains legacy action handling without interrupting local editing',async()=>{
    await load(vault.add('notes/a.xml'));const host=state.roots.at(-1)!.host,controller=ready();
    host.openSync!();host.openProjects!();expect(state.notices).toHaveLength(2);expect(state.notices[0]).toContain('安装并启用');
    expect(controller.prepareClose).not.toHaveBeenCalled();expect(host.initial.snapshot.xml).toBe('<p>磁盘稿</p>');
  });
  it('passes only the current document to an enabled workspace handler without a missing-plugin notice',async()=>{
    await load(vault.add('notes/a.xml'));const requests:any[]=[];
    app.workspace.on('feishu-doc-local:open-action',(request:any)=>{requests.push({...request});request.handled=true;});
    state.roots.at(-1)!.host.openSync!();state.roots.at(-1)!.host.openProjects!();
    expect(requests.map(request=>[request.action,request.path])).toEqual([['sync','notes/a.xml'],['projects','notes/a.xml']]);expect(state.notices).toEqual([]);
  });
  it('mounts an extension enabled after opening and clears it on disable and disposal',async()=>{
    await load(vault.add('notes/a.xml'));const host=state.roots.at(-1)!.host,container=document.createElement('div');
    const cleanup=host.mountToolbar!(container);expect(container.textContent).toBe('');expect(state.notices).toEqual([]);
    const disposed=vi.fn();const ref=app.workspace.on(EDITOR_TOOLBAR_EVENT,(request:EditorToolbarRequest)=>{
      expect(request.path).toBe('notes/a.xml');request.container.textContent='从飞书导入';request.accept(disposed);
    });
    app.workspace.trigger(EDITOR_EXTENSION_CHANGED_EVENT);expect(container.textContent).toBe('从飞书导入');
    app.workspace.offref(ref);app.workspace.trigger(EDITOR_EXTENSION_CHANGED_EVENT);expect(container.textContent).toBe('');expect(disposed).toHaveBeenCalledOnce();
    cleanup();cleanup();expect(app.workspace.events.get(EDITOR_EXTENSION_CHANGED_EVENT).size).toBe(0);
  });
  it('rejects late toolbar registrations and cannot remount a previous document after switching',async()=>{
    const a=vault.add('notes/a.xml'),target=await load(a),container=document.createElement('div');ready();
    let request!:EditorToolbarRequest;const handler=vi.fn((value:EditorToolbarRequest)=>{request=value;});app.workspace.on(EDITOR_TOOLBAR_EVENT,handler);
    const old=state.roots.at(-1)!.host,cleanup=old.mountToolbar!(container),lateCleanup=vi.fn();request.accept(lateCleanup);expect(lateCleanup).toHaveBeenCalledOnce();
    await target.onLoadFile(vault.add('notes/b.xml'));app.workspace.trigger(EDITOR_EXTENSION_CHANGED_EVENT);expect(handler).toHaveBeenCalledOnce();
    cleanup();old.mountToolbar!(container)();expect(handler).toHaveBeenCalledOnce();
  });
  it('handles local navigation through events and rejects outside-vault requests',async()=>{
    vault.add('notes/a.xml');let result:Promise<void>|undefined;
    app.workspace.trigger('feishu-doc-local:open-local',{action:'open',path:'notes/a.xml',accept:(value:Promise<void>)=>result=value});
    await result;expect(state.roots.at(-1)!.host.initial.document.handle.path).toBe('notes/a.xml');
    for(const path of ['../outside.xml','/outside.xml','notes/not-xml.txt']){
      app.workspace.trigger('feishu-doc-local:open-local',{action:'open',path,accept:(value:Promise<void>)=>result=value});
      await expect(result).rejects.toThrow();
    }
    expect(state.roots).toHaveLength(1);
  });
});
