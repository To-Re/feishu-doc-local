import { FileView, FuzzySuggestModal, Modal, Notice, Plugin, TFile, type WorkspaceLeaf, type EventRef } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserApp } from '../../src/browser/BrowserApp';
import type { BrowserDocumentStore } from '../../src/browser/files';
import { EDITOR_ACTION_EVENT, LOCAL_EDITOR_ACTION_EVENT, EDITOR_TOOLBAR_EVENT, EDITOR_EXTENSION_CHANGED_EVENT, type EditorToolbarRequest, type EditorActionRequest, type LocalEditorActionRequest, type EditorController, type EditorHost, type EditorRecovery } from '../../src/browser/host';
import { validateBrowserReview } from '../../src/browser/review';
import { DraftStore, safeDraftPath } from './drafts';
import { openObsidianDirectory } from './store';
import { assertDocxXML, assertDocxXMLFile, readVaultXML } from './docxml-file';

export const VIEW_TYPE='feishu-doc-local-xml';
const SYNC_EVENT='feishu-doc-local:acquire-sync';
interface Lease {release():Promise<void>;}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const sidecar=(path:string)=>path.replace(/\.xml$/i,'.review.json');
const parentPath=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';

export class FeishuXMLView extends FileView {
  private root:Root|null=null;
  private store:BrowserDocumentStore|null=null;
  private controller:EditorController|null=null;
  private session:Awaited<ReturnType<DraftStore['open']>>|null=null;
  private activePath='';
  private plainPath='';
  private requestedPath='';
  private generation=0;
  private lifecycle:Promise<unknown>=Promise.resolve();
  constructor(leaf:WorkspaceLeaf,private plugin:FeishuDocLocalPlugin){super(leaf);}
  getViewType(){return VIEW_TYPE;}
  getDisplayText(){return this.file?.basename||'本地飞书文档';}
  getIcon(){return 'file-code';}
  // This leaf is a content router only while our extension registration owns
  // XML. Do not override another XML plugin when it registered before us.
  canAcceptExtension(extension:string){return this.plugin.routesXML()&&extension.toLowerCase()==='xml';}
  uses(path:string){return this.activePath===path||this.requestedPath===path;}
  documentPath(){return this.requestedPath||this.activePath;}
  private enqueue(action:()=>Promise<void>){const next=this.lifecycle.catch(()=>undefined).then(action);this.lifecycle=next;return next;}
  onLoadFile(file:TFile){
    // Invalidate older loads immediately, before waiting for the previous editor.
    const generation=++this.generation,path=file.path;this.requestedPath=path;
    return this.enqueue(async()=>{
      let xml:string;
      try{xml=await readVaultXML(this.app.vault,file);}
      catch(error){
        if(generation!==this.generation)return;
        this.requestedPath=this.activePath;
        const previous=this.activePath||this.plainPath;
        if(previous){this.file=this.app.vault.getFileByPath(previous);new Notice('未切换文档：'+message(error));}
        else this.showError(message(error));
        return;
      }
      if(generation!==this.generation)return;
      try{await this.stopCurrent();}
      catch(error){if(generation===this.generation){this.requestedPath=this.activePath;if(this.activePath)this.file=this.app.vault.getFileByPath(this.activePath);new Notice('未切换文档：'+message(error));}throw error;}
      if(generation!==this.generation)return;
      if(file.path!==path||this.app.vault.getFileByPath(path)!==file){this.requestedPath='';this.showError('文档位置已改变，请重新打开。');return;}
      this.file=file;
      try{assertDocxXML(xml);}catch{this.showPlainXML(file,xml);return;}
      this.activePath=path;this.contentEl.classList.add('feishu-doc-local-view');this.contentEl.replaceChildren();
      let store:BrowserDocumentStore|null=null,session:Awaited<ReturnType<DraftStore['open']>>|null=null;
      try{
        if(this.contentEl.ownerDocument!==document)throw new Error('请在 Obsidian 主窗口打开本地飞书文档；独立弹出窗口暂不支持。');
        if(this.plugin.isLocked(path))throw new Error('该文档正在同步或迁移，请完成后重新打开。');
        if(file.path!==path||this.app.vault.getFileByPath(path)!==file)throw new Error('文档位置已改变，请重新打开。');
        store=await openObsidianDirectory(this.app.vault,parentPath(path));
        const opened=await store.open(file.name),snapshot=await opened.read();
        if(generation!==this.generation||file.path!==path){store.dispose();return;}
        try{assertDocxXML(snapshot.xml);}catch{store.dispose();this.showPlainXML(file,snapshot.xml);return;}
        const recovery=this.plugin.takeRecovery(this.leaf);
        session=await this.plugin.drafts.open(path,recovery);
        if(generation!==this.generation||this.plugin.isLocked(path)){session.close();store.dispose();return;}
        const ownedSession=session;
        this.store=store;this.session=session;
        if(!recovery&&this.plugin.drafts.list().some(record=>record.path===path&&!record.active)){
          const banner=this.contentEl.createDiv({attr:{role:'status'}});
          banner.createEl('span',{text:'这篇文档有未保存草稿，尚未应用到正文。'});
          const recover=banner.createEl('button',{text:'查看恢复草稿'});recover.onclick=()=>this.plugin.showRecovery(path);
        }
        const host:EditorHost={label:'Obsidian',initial:{store,document:opened,snapshot,recovery:session.recovery},
          openDocument:()=>this.plugin.choose(),createDocument:()=>this.plugin.newDocument(parentPath(path)),
          openSync:()=>this.plugin.openExtension('sync',path),openProjects:()=>this.plugin.openExtension('projects',path),
          mountToolbar:container=>this.plugin.mountToolbar(path,container,()=>this.session===ownedSession&&this.activePath===path&&this.requestedPath===path&&file.path===path),
          persistRecovery:value=>ownedSession.write(value),onReady:controller=>{if(this.session===ownedSession)this.controller=controller;}};
        const mount=this.contentEl.createDiv({cls:'feishu-doc-local-mount'});this.root=createRoot(mount);this.root.render(<BrowserApp host={host}/>);
      }catch(error){session?.close();store?.dispose();if(generation===this.generation){this.store=null;this.session=null;this.showError(message(error),file);}}
    });
  }
  private showPlainXML(file:TFile,xml:string){
    this.activePath='';this.requestedPath='';this.plainPath=file.path;this.file=file;
    this.contentEl.replaceChildren();this.contentEl.classList.add('feishu-doc-local-view');
    const preview=this.contentEl.createDiv({cls:'fdl-plain-xml',attr:{role:'region','aria-label':'普通 XML 只读预览'}});
    preview.createEl('h2',{text:file.name});
    preview.createEl('p',{text:'普通 XML · 只读。未识别为飞书 DocxXML，按原始文本显示，不生成评论或同步数据。需要编辑时，可通过 Obsidian 页签菜单用默认应用打开。'});
    const source=preview.createEl('pre',{text:xml,attr:{'aria-label':'XML 原始内容',tabindex:'0'}});
  }
  private showError(error:string,file?:TFile){
    this.contentEl.replaceChildren();this.contentEl.classList.add('feishu-doc-local-view');
    this.contentEl.createEl('p',{text:error,attr:{role:'alert'}});
    if(file){const retry=this.contentEl.createEl('button',{text:'重新读取'});retry.onclick=()=>void this.onLoadFile(file).catch(error=>new Notice(message(error)));}
    const recover=this.contentEl.createEl('button',{text:'恢复未保存草稿'});recover.onclick=()=>this.plugin.showRecovery();
  }
  showMigrationError(error:string){this.showError(error);}
  onUnloadFile(){return this.shutdown();}
  onClose(){return this.shutdown();}
  onRename(file:TFile){if(this.plainPath){this.plainPath=file.path;this.file=file;return Promise.resolve();}const oldPath=this.documentPath();return oldPath&&oldPath!==file.path?this.plugin.renameDocument(oldPath,file):Promise.resolve();}
  async acquireSync(){if(this.plainPath)throw new Error('普通 XML 只读预览不支持飞书同步。');if(!this.controller||this.activePath!==this.requestedPath)throw new Error('文档编辑器仍在加载，请稍后再同步。');return this.controller.acquireSync();}
  shutdown(){const generation=++this.generation;this.requestedPath='';return this.enqueue(()=>this.stopCurrent()).catch(error=>{if(generation===this.generation)this.requestedPath=this.activePath;throw error;});}
  private async stopCurrent(){
    if(this.controller){
      try{await this.controller.prepareClose();}
      catch(error){
        // Plugin unload cannot itself be awaited by Obsidian. Persist a final
        // snapshot independently, and retain the view if safe closing failed.
        await this.session?.write(this.controller.capture());throw error;
      }
    }
    this.controller=null;this.root?.unmount();this.root=null;this.store?.dispose();this.store=null;
    this.session?.close();this.session=null;this.activePath='';this.plainPath='';
  }
}

class XMLPicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin:FeishuDocLocalPlugin){super(plugin.app);this.setPlaceholder('选择飞书 XML 文档（打开前校验 DocxXML 子集）');}
  getItems(){return this.app.vault.getFiles().filter(file=>file.extension.toLowerCase()==='xml');}
  getItemText(file:TFile){return file.path;}
  onChooseItem(file:TFile){void this.plugin.open(file).catch(error=>new Notice(message(error)));}
}
class RecoveryPicker extends FuzzySuggestModal<{id:string;path:string;updatedAt:number;active:boolean}> {
  constructor(private plugin:FeishuDocLocalPlugin,private path?:string){super(plugin.app);this.setPlaceholder('选择草稿，查看后恢复或另存');}
  getItems(){return this.plugin.drafts.list().filter(record=>!this.path||record.path===this.path);}
  getItemText(item:{path:string;updatedAt:number;active:boolean}){return item.path+' · '+new Date(item.updatedAt).toLocaleString()+(item.active?' · 正在编辑':'');}
  onChooseItem(item:{id:string;active:boolean}){if(item.active){new Notice('该草稿仍在另一页签编辑，请先关闭对应页签。');return;}new RecoveryModal(this.plugin,item.id).open();}
}
export class RecoveryModal extends Modal {
  private closed=false;
  constructor(private plugin:FeishuDocLocalPlugin,private id:string){super(plugin.app);}
  async onOpen(){
    this.closed=false;this.contentEl.createEl('h2',{text:'恢复未保存草稿'});
    try{
      const draft=await this.plugin.drafts.get(this.id);if(this.closed)return;
      this.contentEl.createEl('p',{text:'原文：'+draft.path});
      this.contentEl.createEl('p',{text:'草稿不会自动替换磁盘正文。可在原文中恢复后核对，或保存为新的 XML 与评论文件。'});
      const details=this.contentEl.createEl('details');details.createEl('summary',{text:'查看保留的正文与意见'});
      details.createEl('pre',{text:draft.invalidSource?.value||draft.xml});
      if(draft.comment)details.createEl('p',{text:'未发送评论：'+draft.comment});
      for(const reply of Object.values(draft.replies))if(reply)details.createEl('p',{text:'未发送回复：'+reply});
      if(draft.formula.length||draft.whiteboard.length)details.createEl('p',{text:`另有 ${draft.formula.length} 份公式、${draft.whiteboard.length} 份白板源码草稿。`});
      const error=this.contentEl.createEl('p',{attr:{role:'alert'}});
      const original=this.app.vault.getFileByPath(draft.path);
      if(original){const restore=this.contentEl.createEl('button',{text:'在原文中恢复'});restore.onclick=async()=>{restore.disabled=true;try{await this.plugin.open(original,this.id);this.close();}catch(failure){error.textContent=message(failure);restore.disabled=false;}};}
      else this.contentEl.createEl('p',{text:'原文件已移动或删除，可以在下面恢复为新文档；原恢复记录会保留。'});
      const form=this.contentEl.createEl('form');
      const folderLabel=form.createEl('label',{text:'恢复目录（库内已有目录）'}),folder=folderLabel.createEl('input',{attr:{'aria-label':'恢复目录'}});
      folder.value=this.app.vault.getFolderByPath(parentPath(draft.path))?parentPath(draft.path):'';
      const nameLabel=form.createEl('label',{text:'新文件名'}),name=nameLabel.createEl('input',{attr:{'aria-label':'恢复文件名',required:'true'}});name.value=draft.path.split('/').at(-1)!.replace(/\.xml$/i,'')+'-恢复.xml';
      const save=form.createEl('button',{text:'恢复为新文档',attr:{type:'submit'}});
      form.onsubmit=async event=>{event.preventDefault();save.disabled=true;error.textContent='';try{await this.plugin.restoreCopy(this.id,folder.value.trim(),name.value.trim());this.close();}catch(failure){error.textContent=message(failure);save.disabled=false;}};
    }catch(error){this.contentEl.createEl('p',{text:message(error),attr:{role:'alert'}});}
    if(this.closed)return;
    const discard=this.contentEl.createEl('button',{text:'丢弃这份恢复草稿'});let confirmed=false;
    discard.onclick=async()=>{
      if(!confirmed){confirmed=true;discard.textContent='确认丢弃草稿（正文与评论文件保留）';return;}
      discard.disabled=true;try{await this.plugin.drafts.discard(this.id);this.close();}catch(error){this.contentEl.createEl('p',{text:message(error),attr:{role:'alert'}});discard.disabled=false;}
    };
  }
  onClose(){this.closed=true;this.contentEl.replaceChildren();}
}
class NewXMLModal extends Modal {
  constructor(private plugin:FeishuDocLocalPlugin,private directory:string){super(plugin.app);}
  onOpen(){
    this.contentEl.createEl('h2',{text:'新建本地飞书文档'});const form=this.contentEl.createEl('form');
    const folderLabel=form.createEl('label',{text:'库内目录'}),folder=folderLabel.createEl('input',{attr:{'aria-label':'库内目录'}});folder.value=this.directory;
    const nameLabel=form.createEl('label',{text:'文件名'}),name=nameLabel.createEl('input',{attr:{'aria-label':'XML 文件名',placeholder:'文章.xml',required:'true'}});
    const titleLabel=form.createEl('label',{text:'文章标题'}),title=titleLabel.createEl('input',{attr:{'aria-label':'文章标题'}});
    const error=form.createEl('p',{attr:{role:'alert'}}),submit=form.createEl('button',{text:'创建文档',attr:{type:'submit'}});
    form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;error.textContent='';let store:BrowserDocumentStore|null=null;
      try{if(!name.value.trim())throw new Error('请输入 XML 文件名。');store=await openObsidianDirectory(this.app.vault,folder.value.trim());const filename=name.value.trim().replace(/\.xml$/i,'')+'.xml';
        const created=await store.create(filename,title.value);const file=this.app.vault.getFileByPath(created.handle.path);if(!file)throw new Error('文档已创建，等待文件列表刷新后打开。');
        this.close();await this.plugin.open(file);
      }catch(failure){error.textContent=message(failure);}finally{store?.dispose();submit.disabled=false;}};
    name.focus();
  }
  onClose(){this.contentEl.replaceChildren();}
}

export default class FeishuDocLocalPlugin extends Plugin {
  drafts=new DraftStore(value=>this.saveData(value));
  private xmlRouteRegistered=false;
  private locks=new Set<string>();
  private renaming=new Map<string,Promise<void>>();
  private recoveryRequests=new WeakMap<WorkspaceLeaf,string>();
  private views(){return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf=>leaf.view).filter((view):view is FeishuXMLView=>view instanceof FeishuXMLView);}
  async onload(){
    this.drafts.load(await this.loadData());this.registerView(VIEW_TYPE,leaf=>new FeishuXMLView(leaf,this));
    this.xmlRouteRegistered=false;
    try{this.registerExtensions(['xml'],VIEW_TYPE);this.xmlRouteRegistered=true;}
    catch{new Notice('XML 已由其他插件关联，未改变该关联；可用“打开飞书 XML 文档”命令打开。');}
    this.addCommand({id:'open-xml',name:'打开飞书 XML 文档',callback:()=>this.choose()});
    this.addCommand({id:'new-xml',name:'新建本地文档',callback:()=>this.newDocument()});
    this.addCommand({id:'recover-draft',name:'恢复未保存草稿',callback:()=>this.showRecovery()});
    this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{if(file instanceof TFile&&file.extension.toLowerCase()==='xml')menu.addItem(item=>item.setTitle('用本地飞书文档打开').setIcon('file-code').onClick(()=>void this.open(file).catch(error=>new Notice(message(error))))); }));
    this.registerEvent(this.app.vault.on('rename',(entry,oldPath)=>{
      for(const view of this.views()){
        const previous=view.documentPath();if(previous!==oldPath&&!previous.startsWith(oldPath+'/'))continue;
        const next=this.app.vault.getFileByPath(entry.path+previous.slice(oldPath.length));
        if(next&&next.extension.toLowerCase()==='xml')void this.renameDocument(previous,next).catch(error=>new Notice(message(error)));
      }
    }));
    const events=this.app.workspace as unknown as {on(name:string,callback:(request:{path:string;acquire:(value:Promise<Lease>)=>void})=>void):EventRef};
    this.registerEvent(events.on(SYNC_EVENT,request=>{if(request&&typeof request.path==='string'&&typeof request.acquire==='function')request.acquire(this.acquire(request.path));}));
    const actions=this.app.workspace as unknown as {on(name:string,callback:(request:LocalEditorActionRequest)=>void):EventRef};
    this.registerEvent(actions.on(LOCAL_EDITOR_ACTION_EVENT,request=>{
      if(!request||!['open','create'].includes(request.action)||typeof request.path!=='string'||typeof request.accept!=='function')return;
      request.accept(this.openLocalAction(request));
    }));
  }
  openExtension(action:EditorActionRequest['action'],path:string){
    if(!safeDraftPath(path)||!this.app.vault.getFileByPath(path)){new Notice('请先打开库内已有 XML 文档。');return;}
    const request:EditorActionRequest={action,path,handled:false};
    this.app.workspace.trigger(EDITOR_ACTION_EVENT,request);
    if(!request.handled)new Notice('项目关联和飞书同步由可选的「本地飞书文档 · 飞书同步」扩展提供，请安装并启用它。本地编辑、评论和自动保存仍可使用。');
  }
  mountToolbar(path:string,container:HTMLElement,current:()=>boolean){
    let closed=false,dispose:(()=>void)|undefined;
    const clear=()=>{const previous=dispose;dispose=undefined;try{previous?.();}finally{container.replaceChildren();}};
    const mount=()=>{
      clear();if(closed||!current())return;
      let accepting=true;
      const request:EditorToolbarRequest={path,container,accept:cleanup=>{
        if(typeof cleanup!=='function')return;
        if(!accepting||closed||!current()||dispose){cleanup();return;}
        dispose=cleanup;
      }};
      try{this.app.workspace.trigger(EDITOR_TOOLBAR_EVENT,request);}finally{accepting=false;}
    };
    const events=this.app.workspace as unknown as {on(name:string,callback:()=>void):EventRef;offref(ref:EventRef):void};
    const ref=events.on(EDITOR_EXTENSION_CHANGED_EVENT,mount);
    try{mount();}catch(error){events.offref(ref);clear();throw error;}
    return()=>{if(closed)return;closed=true;events.offref(ref);clear();};
  }
  private async openLocalAction(request:LocalEditorActionRequest){
    if(request.action==='create'){
      if(request.path&&!safeDraftPath(request.path))throw new Error('请选择库内的 XML 文档目录。');
      const directory=request.path?parentPath(request.path):'';
      if(directory&&!this.app.vault.getFolderByPath(directory))throw new Error('库内目录不存在。');
      this.newDocument(directory);return;
    }
    if(!safeDraftPath(request.path))throw new Error('只能打开当前仓库中的 XML 文档。');
    const file=this.app.vault.getFileByPath(request.path);if(!file||file.extension.toLowerCase()!=='xml')throw new Error('库内 XML 文档不存在。');
    await this.open(file);
  }
  choose(){new XMLPicker(this).open();}
  newDocument(directory=''){new NewXMLModal(this,directory).open();}
  showRecovery(path?:string){new RecoveryPicker(this,path).open();}
  isLocked(path:string){return this.locks.has(path);}
  routesXML(){return this.xmlRouteRegistered;}
  takeRecovery(leaf:WorkspaceLeaf){const id=this.recoveryRequests.get(leaf);this.recoveryRequests.delete(leaf);return id;}
  async open(file:TFile,recovery?:string){
    await assertDocxXMLFile(this.app.vault,file);
    const leaf=this.app.workspace.getLeaf(true);if(recovery)this.recoveryRequests.set(leaf,recovery);
    try{await leaf.setViewState({type:VIEW_TYPE,active:true,state:{file:file.path}});}finally{this.recoveryRequests.delete(leaf);}
  }
  async restoreCopy(id:string,directory:string,name:string){
    if(!name)throw new Error('请输入新文件名。');const original=await this.drafts.get(id);
    const store=await openObsidianDirectory(this.app.vault,directory);
    try{
      const created=await store.create(name.replace(/\.xml$/i,'')+'.xml'),initial=await created.read();
      const review=structuredClone(original.review);review.document.name=created.handle.name;delete review.cloudSync;delete review.contentSync;
      const saved=await created.save(original.xml,review,initial.revision);
      const restored:EditorRecovery={...original,path:created.handle.path,review:saved.review||review,revision:saved.revision,dirty:false};
      const session=await this.drafts.open(created.handle.path);let recoveryId:string;
      try{await session.write(restored);recoveryId=session.id;}finally{session.close();}
      const file=this.app.vault.getFileByPath(created.handle.path);if(!file)throw new Error('新文档已保存，请从文件列表打开。');
      await this.open(file,recoveryId);return file;
    }finally{store.dispose();}
  }
  renameDocument(oldPath:string,file:TFile):Promise<void>{
    const newPath=file.path,key=oldPath+'\n'+newPath,existing=this.renaming.get(key);if(existing)return existing;
    const operation=this.performRename(oldPath,newPath,file).finally(()=>this.renaming.delete(key));this.renaming.set(key,operation);return operation;
  }
  private async performRename(oldPath:string,newPath:string,file:TFile){
    if(oldPath===newPath)return;
    if(!safeDraftPath(oldPath)||!safeDraftPath(newPath))throw new Error('文档新路径无效，评论与草稿未迁移。');
    if(this.isLocked(oldPath)||this.isLocked(newPath))throw new Error('文档正在同步，未迁移旁置评论。请完成同步后重新打开。');
    this.locks.add(oldPath);this.locks.add(newPath);
    const views=this.views().filter(view=>view.uses(oldPath));
    try{
      const closed=await Promise.allSettled(views.map(view=>view.shutdown()));
      const failed=closed.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
      if(file.path!==newPath||this.app.vault.getFileByPath(newPath)!==file)throw new Error('文档再次移动，请在最终位置重新打开。旧评论与草稿已保留。');
      const oldSidecar=sidecar(oldPath),nextSidecar=sidecar(newPath),source=this.app.vault.getFileByPath(oldSidecar),target=this.app.vault.getFileByPath(nextSidecar);
      if(source&&oldSidecar!==nextSidecar){
        if(this.app.vault.getAbstractFileByPath(nextSidecar))throw new Error('新位置已有评论文件，未覆盖或关联旧评论。请核对两份旁置文件；草稿仍可从恢复命令取回。');
        const raw=await this.app.vault.read(source);const review=await validateBrowserReview(JSON.parse(raw),oldPath.split('/').at(-1)!);
        if(await this.app.vault.read(source)!==raw)throw new Error('原评论在迁移时又发生修改，两份文件均未覆盖，请重新核对。');
        review.document.name=file.name;
        // Retain the source sidecar as a backup; never overwrite a destination.
        await this.app.vault.create(nextSidecar,JSON.stringify(review,null,2)+'\n');
        if(await this.app.vault.read(source)!==raw)throw new Error('原评论在迁移时又发生修改，新副本与原文件均已保留，请先核对。');
        new Notice('评论已复制到新位置，原旁置文件保留为备份。');
      }else if(target){
        // A folder rename already moved its sidecar. Only validate it; a file
        // with unrelated metadata is never silently relabelled as this article.
        await validateBrowserReview(JSON.parse(await this.app.vault.read(target)),file.name);
      }
      await this.drafts.relocate(oldPath,newPath);
    }catch(error){for(const view of views)view.showMigrationError(message(error));throw error;}
    finally{this.locks.delete(oldPath);this.locks.delete(newPath);}
    for(const view of views)await view.onLoadFile(file);
    if(parentPath(oldPath)!==parentPath(newPath)&&this.app.vault.getFolderByPath(parentPath(oldPath)))new Notice('若仅移动了 XML，请将其引用的资源目录一并移动；插件不会覆盖新目录的已有附件。');
  }
  async acquire(path:string):Promise<Lease>{
    if(!safeDraftPath(path)||!path.toLowerCase().endsWith('.xml')||!this.app.vault.getFileByPath(path))throw new Error('请选择库内已有 XML 文档。');
    if(this.locks.has(path))throw new Error('这篇文档已有同步操作正在进行。');
    if(this.drafts.list().some(record=>record.path===path&&!record.active))throw new Error('这篇文档还有未处理的恢复草稿，请先通过“恢复未保存草稿”查看并处理，再同步。');
    this.locks.add(path);const acquired:Lease[]=[];
    try{
      await assertDocxXMLFile(this.app.vault,this.app.vault.getFileByPath(path)!);
      for(const view of this.views())if(view.uses(path))acquired.push(await view.acquireSync());
      await this.drafts.settled();
      if(this.drafts.list().some(record=>record.path===path))throw new Error('本地草稿仍未处理，未开始飞书同步。');
    }catch(error){await Promise.allSettled(acquired.map(lease=>lease.release()));this.locks.delete(path);throw error;}
    let released=false;return{release:async()=>{if(released)return;released=true;try{
      const results=await Promise.allSettled(acquired.map(lease=>lease.release()));const failed=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
    }finally{this.locks.delete(path);}}};
  }
  onunload(){this.xmlRouteRegistered=false;for(const view of this.views())void view.shutdown().catch(error=>new Notice('草稿保存未完成：'+message(error)));}
}
