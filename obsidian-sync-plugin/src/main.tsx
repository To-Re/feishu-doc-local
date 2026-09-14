import {FileSystemAdapter,FuzzySuggestModal,Modal,Plugin,PluginSettingTab,Setting,TFile,Notice,type App,type EventRef} from 'obsidian';
import {resolve} from 'node:path';
import {createRoot,type Root} from 'react-dom/client';
import {XMLDiff} from '../../src/ui/XMLDiff';
import {contentSyncPresentation} from '../../src/ui/content-sync-presentation';
import type {CreateProjectInput,ReviewProject,SyncDirection} from '../../src/core/projects';
import type {PreparedContent} from '../../src/server/content-sync';
import {ManagedCLIRunner} from './runner';
import {defaultPreferences,readPreferences,validatePreferences,type Preferences} from './preferences';
import {SyncService,type ExistingBinding,type LocalProjectEntry,type PreparedImport} from './service';
import {withSyncLease,openLocalEditor} from './bridge';
import {EDITOR_ACTION_EVENT,EDITOR_TOOLBAR_EVENT,EDITOR_EXTENSION_CHANGED_EVENT,type EditorActionRequest,type EditorToolbarRequest} from '../../src/browser/host';

const readable=(error:unknown)=>error instanceof Error?error.message:'操作未完成，请核对文件后重试。';
function button(parent:HTMLElement,text:string,action:()=>void,primary=false){const el=parent.createEl('button',{text,cls:primary?'mod-cta':''});el.type='button';el.addEventListener('click',action);return el;}
class XMLPicker extends FuzzySuggestModal<TFile>{
  constructor(app:App,private readonly chosen:(file:TFile)=>void){super(app);this.setPlaceholder('选择需要同步的本地 XML 文档');}
  getItems(){return this.app.vault.getFiles().filter(file=>file.extension.toLowerCase()==='xml');}
  getItemText(file:TFile){return file.path;}
  onChooseItem(file:TFile){this.chosen(file);}
}

export default class FeishuSyncPlugin extends Plugin {
  settings:Preferences=defaultPreferences();configurationError='';private runner=new ManagedCLIRunner();private service?:SyncService;private dialogs=new Set<Modal>();private toolbars=new Set<SyncToolbar>();private stopping=false;
  async onload(){try{this.settings=readPreferences(await this.loadData());}catch(error){this.configurationError=readable(error);}
    this.runner=new ManagedCLIRunner(undefined,this.runnerOptions());
    this.addSettingTab(new SyncSettings(this.app,this));
    this.addCommand({id:'open-sync',name:'关联与同步当前 XML 文档',callback:()=>{const file=this.app.workspace.getActiveFile();if(file?.extension.toLowerCase()==='xml')this.open(file);else new XMLPicker(this.app,file=>this.open(file)).open();}});
    this.addCommand({id:'open-projects',name:'管理与切换项目',callback:()=>this.openProjects(this.app.workspace.getActiveFile()??undefined)});
    this.addCommand({id:'open-cli-settings',name:'配置官方 CLI 与项目路径',callback:()=>this.openSettings()});
    this.addCommand({id:'import-cloud-document',name:'从飞书导入新文档',callback:()=>this.openImport(this.app.workspace.getActiveFile()??undefined)});
    const events=this.app.workspace as unknown as {on<T>(name:string,callback:(request:T)=>void):EventRef};
    this.registerEvent(events.on<EditorActionRequest>(EDITOR_ACTION_EVENT,request=>{
      if(this.stopping||!request||request.handled||!['sync','projects'].includes(request.action)||typeof request.path!=='string')return;
      const file=this.app.vault.getFileByPath(request.path);
      if(!(file instanceof TFile)||file.extension.toLowerCase()!=='xml'){request.handled=true;new Notice('请先打开当前仓库中的 XML 文档。');return;}
      request.handled=true;if(request.action==='sync')this.open(file);else this.openProjects(file);
    }));
    this.registerEvent(events.on<EditorToolbarRequest>(EDITOR_TOOLBAR_EVENT,request=>{
      if(this.stopping||!request||typeof request.path!=='string'||!(request.container instanceof HTMLElement)||typeof request.accept!=='function')return;
      const file=this.app.vault.getFileByPath(request.path);if(!(file instanceof TFile)||file.extension.toLowerCase()!=='xml')return;
      const toolbar=new SyncToolbar(request.container,this,file);this.toolbars.add(toolbar);
      request.accept(()=>{toolbar.dispose();this.toolbars.delete(toolbar);});toolbar.start();
    }));
    this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{if(file instanceof TFile&&file.extension.toLowerCase()==='xml')menu.addItem(item=>item.setTitle('本地飞书文档：关联与同步').setIcon('refresh-cw').onClick(()=>this.open(file)));}));
    this.extensionChanged();
  }
  onunload(){this.stopping=true;this.service?.dispose();this.runner.dispose();for(const toolbar of this.toolbars)toolbar.dispose();this.toolbars.clear();for(const dialog of [...this.dialogs])dialog.close();this.dialogs.clear();this.extensionChanged();}
  private extensionChanged(){this.app.workspace.trigger(EDITOR_EXTENSION_CHANGED_EVENT);}
  private runnerOptions(){const adapter=this.app.vault.adapter;return {nodePath:this.settings.nodePath,...(adapter instanceof FileSystemAdapter?{cwd:adapter.getBasePath()}: {})};}
  refreshToolbars(){if(!this.stopping)for(const toolbar of this.toolbars)void toolbar.refresh();}
  confirm(title:string,explanation:string,action:()=>void){const modal=new ConfirmModal(this.app,title,explanation,()=>{if(!this.stopping)action();},()=>this.dialogs.delete(modal));this.dialogs.add(modal);modal.open();return modal;}
  open(file:TFile){const modal=new SyncModal(this.app,this,file,()=>this.dialogs.delete(modal));this.dialogs.add(modal);modal.open();}
  openPreview(file:TFile,direction:SyncDirection){const modal=new SyncModal(this.app,this,file,()=>this.dialogs.delete(modal),{direction,preview:true});this.dialogs.add(modal);modal.open();}
  openImport(file?:TFile){const current=file?.extension.toLowerCase()==='xml'?file:undefined;const modal=new ImportModal(this.app,this,current,()=>this.dialogs.delete(modal));this.dialogs.add(modal);modal.open();}
  openProjects(file?:TFile){const current=file?.extension.toLowerCase()==='xml'?file:undefined;const modal=new ProjectsModal(this.app,this,current,()=>this.dialogs.delete(modal));this.dialogs.add(modal);modal.open();}
  openSettings(){const modal=new CLISettingsModal(this.app,this,()=>this.dialogs.delete(modal));this.dialogs.add(modal);modal.open();}
  async openRegistered(id:string){
    const entry=await this.backend().openProject(id),file=this.app.vault.getFileByPath(entry.vaultPath);
    if(this.stopping)throw new Error('插件已卸载。');
    if(!(file instanceof TFile)||file.extension.toLowerCase()!=='xml')throw new Error('库内文件列表尚未找到该 XML，请确认文件位置后刷新。');
    await openLocalEditor(this.app.workspace,'open',entry.vaultPath);
  }
  backend(){if(this.configurationError)throw new Error(this.configurationError);if(this.stopping)throw new Error('插件已卸载。');const adapter=this.app.vault.adapter;if(!(adapter instanceof FileSystemAdapter))throw new Error('飞书 CLI 扩展仅支持桌面版的本地仓库。');
    return this.service??=new SyncService({vaultRoot:adapter.getBasePath(),catalogPath:this.settings.catalogPath,profile:this.settings,runner:this.runner.run});
  }
  absolute(file:TFile){const adapter=this.app.vault.adapter;if(!(adapter instanceof FileSystemAdapter))throw new Error('需要桌面版本地文件仓库。');return resolve(adapter.getBasePath(),file.path);}
  async updateSettings(value:Preferences){if([...this.dialogs].some(dialog=>dialog instanceof SyncModal||dialog instanceof ProjectsModal||dialog instanceof ImportModal)||[...this.toolbars].some(toolbar=>toolbar.isBusy))throw new Error('请先关闭同步窗口、导入窗口和项目管理，并等待同步完成，再修改 CLI 设置。');const next=validatePreferences(value,true);await this.saveData(next);this.settings=next;this.configurationError='';this.service?.dispose();this.service=undefined;this.runner.dispose();this.runner=new ManagedCLIRunner(undefined,this.runnerOptions());this.extensionChanged();this.refreshToolbars();}
}

class SyncToolbar {
  private alive=true;private generation=0;private project?:ReviewProject;private loading=true;private error='';private notice='';private busy=false;private confirmation?:Modal;
  private direction?:SyncDirection;
  private readonly filePath:string;
  constructor(private readonly container:HTMLElement,private readonly plugin:FeishuSyncPlugin,private readonly file:TFile){this.filePath=file.path;}
  get isBusy(){return this.busy;}
  start(){this.container.addClass('feishu-doc-local-sync-toolbar');this.render();void this.refresh();}
  dispose(){this.alive=false;this.generation++;this.confirmation?.close();this.container.empty();this.container.classList.remove('feishu-doc-local-sync-toolbar');}
  async refresh(){const generation=++this.generation;try{if(this.file.path!==this.filePath)throw new Error('文档路径已变化，请重新打开文档。');const project=await this.plugin.backend().project(this.plugin.absolute(this.file));if(!this.alive||generation!==this.generation)return;if(!this.direction||project?.id!==this.project?.id)this.direction=project?.defaultDirection;this.project=project;this.error='';}catch(error){if(!this.alive||generation!==this.generation)return;this.error=readable(error);}this.loading=false;if(this.alive)this.render();}
  private async comments(){if(this.busy||!this.alive)return;const path=this.filePath;this.busy=true;this.notice='正在同步评论…';this.render();try{if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开文档。');const absolute=this.plugin.absolute(this.file);
    await withSyncLease(this.plugin.app.workspace,path,async()=>{if(!this.alive)throw new Error('文档已关闭，未启动评论同步。');if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开文档。');const result=await this.plugin.backend().comments(absolute);this.notice=`评论同步完成：导入 ${result.report.imported}，新建 ${result.report.created}，回复 ${result.report.replies}，状态 ${result.report.resolved}。`+result.report.issues.join(' ');});
  }catch(error){this.notice=readable(error);}finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}}
  private async sync(direction:SyncDirection){if(this.busy||!this.alive)return;this.direction=direction;const path=this.filePath;let conflict=false;this.busy=true;this.notice=direction==='push'?'正在推送…':'正在拉取…';this.render();try{
    if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开文档。');const absolute=this.plugin.absolute(this.file);
    await withSyncLease(this.plugin.app.workspace,path,async()=>{
      const assertCurrent=()=>{if(!this.alive)throw new Error('文档已关闭，未启动新的同步操作。');if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开文档。');};
      assertCurrent();const prepared=await this.plugin.backend().preview(absolute,direction);assertCurrent();
      if(prepared.view.status==='conflict'){this.notice='两端都有修改，请先核对差异。';conflict=true;return;}
      const result=await this.plugin.backend().apply(absolute,prepared);this.notice=[result.summary,...result.warnings].join(' ');
    });
    if(conflict&&this.alive&&this.file.path===path)this.plugin.openPreview(this.file,direction);
  }catch(error){this.notice=readable(error);}finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}}
  private render(){if(!this.alive)return;const el=this.container;el.empty();
    button(el,'从飞书导入',()=>this.plugin.openImport(this.file)).disabled=this.busy;
    if(this.project?.cloud&&!this.error){
      button(el,'拉取',()=>void this.sync('pull')).disabled=this.busy;
      button(el,'推送',()=>void this.sync('push'),true).disabled=this.busy;
      button(el,'关联设置',()=>this.plugin.open(this.file)).disabled=this.busy;
      button(el,'预览差异',()=>this.plugin.openPreview(this.file,this.direction??this.project?.defaultDirection??'push')).disabled=this.busy;
      button(el,'同步评论',()=>{this.confirmation=this.plugin.confirm('同步评论','将读取飞书评论，并把本地新增评论、回复和处理状态同步到这篇关联文档。找不到可靠块位置的意见会保留在本地。',()=>void this.comments());}).disabled=this.busy;
      el.createEl('a',{text:'打开飞书',href:this.project.cloud.url,attr:{target:'_blank',rel:'noopener noreferrer'}});
    }else if(this.loading)el.createEl('span',{text:'正在读取飞书关联…',attr:{role:'status'}});
    else if(this.error){el.createEl('span',{text:this.error,cls:'feishu-sync-toolbar-status',attr:{role:'alert'}});button(el,'重新读取关联',()=>void this.refresh()).disabled=this.busy;}
    else button(el,'关联',()=>this.plugin.open(this.file)).disabled=this.busy;
    if(this.error)button(el,'CLI 设置',()=>this.plugin.openSettings()).disabled=this.busy;
    if(this.notice&&this.notice!==this.error)el.createEl('span',{text:this.notice,cls:'feishu-sync-toolbar-status',attr:{role:'status'}});
  }
}
class SyncSettings extends PluginSettingTab {
  constructor(app:App,private readonly plugin:FeishuSyncPlugin){super(app,plugin);}
  display(){renderSettings(this.containerEl,this.plugin);}
}
function renderSettings(containerEl:HTMLElement,plugin:FeishuSyncPlugin){containerEl.empty();containerEl.createEl('h2',{text:'飞书同步'});containerEl.createEl('p',{text:'只在你确认操作时调用已登录的官方 Lark CLI。插件不启动本地服务，不自动登录，不保存令牌。'});
    if(plugin.configurationError)containerEl.createEl('p',{text:plugin.configurationError,attr:{role:'alert'}});
    let command=plugin.settings.command,args=JSON.stringify(plugin.settings.args),catalogPath=plugin.settings.catalogPath,nodePath=plugin.settings.nodePath??'';
    new Setting(containerEl).setName('CLI 可执行文件').setDesc('填写 lark-cli 的绝对路径；不会从文章内容获取命令。').addText(input=>input.setPlaceholder('/usr/local/bin/lark-cli').setValue(command).onChange(value=>command=value));
    new Setting(containerEl).setName('Node 可执行文件（可选）').setDesc('npm 版 CLI 可填写 Node 的绝对路径，避免图形应用 PATH 缺失；原生 CLI 留空。').addText(input=>input.setPlaceholder('/usr/local/bin/node').setValue(nodePath).onChange(value=>nodePath=value));
    new Setting(containerEl).setName('固定参数').setDesc('JSON 字符串数组，例如 []。仅用于你信任的 CLI 适配命令；不要填写凭证。').addText(input=>input.setValue(args).onChange(value=>args=value));
    new Setting(containerEl).setName('项目配置文件').setDesc('可与本地服务版共用 projects.json。这里只保存项目关联，不保存正文或凭证。').addText(input=>input.setValue(catalogPath).onChange(value=>catalogPath=value));
    const status=containerEl.createEl('p',{attr:{role:'status'}});
    new Setting(containerEl).addButton(save=>save.setButtonText('保存配置').setCta().onClick(async()=>{try{const parsed:unknown=JSON.parse(args);await plugin.updateSettings({command,args:parsed as string[],catalogPath,nodePath});status.textContent='配置已保存；尚未运行 CLI。';}catch(error){status.textContent=readable(error);}}));
}
class CLISettingsModal extends Modal {
  constructor(app:App,private readonly plugin:FeishuSyncPlugin,private readonly closed:()=>void){super(app);}
  onOpen(){this.modalEl.addClass('feishu-doc-local-sync-modal');renderSettings(this.contentEl,this.plugin);}
  onClose(){this.contentEl.empty();this.closed();}
}

class ImportModal extends Modal {
  private alive=true;private busy=false;private url='';private path:string;private prepared?:PreparedImport;private importedPath?:string;private notice='';private cancelWait?:()=>void;
  constructor(app:App,private readonly plugin:FeishuSyncPlugin,private readonly current:TFile|undefined,private readonly closed:()=>void){super(app);const folder=current?.path.includes('/')?current.path.slice(0,current.path.lastIndexOf('/')+1):'';this.path=folder+'从飞书导入.xml';}
  onOpen(){this.modalEl.addClass('feishu-doc-local-sync-modal');this.render();}
  onClose(){this.alive=false;this.cancelWait?.();this.contentEl.empty();this.closed();}
  private async run(action:()=>Promise<void>,after?:()=>Promise<void>,lease=true){if(this.busy||!this.alive)return;const path=this.current?.path;this.busy=true;this.notice='正在处理…';this.render();try{
    const guarded=async()=>{if(!this.alive)throw new Error('导入窗口已关闭，未启动新的操作。');if(this.current&&this.current.path!==path)throw new Error('当前文档路径已变化，请重新打开导入窗口。');await action();};
    if(path&&lease)await withSyncLease(this.app.workspace,path,guarded);else await guarded();if(this.alive)await after?.();
  }catch(error){this.notice=(this.importedPath?'文档已导入到 '+this.importedPath+'；':'')+readable(error);}finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}}
  private async openImported(){const path=this.importedPath;if(!path||!this.alive)return;
    await new Promise<void>((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>|undefined,event:EventRef|undefined;let finished=false;
      const finish=(error?:Error)=>{if(finished)return;finished=true;if(timer)clearTimeout(timer);if(event)this.app.vault.offref(event);this.cancelWait=undefined;error?reject(error):resolve();};
      const check=()=>{if(!this.alive){finish(new Error('导入窗口已关闭。'));return;}const file=this.app.vault.getFileByPath(path);if(file instanceof TFile&&file.extension.toLowerCase()==='xml')finish();};
      this.cancelWait=()=>finish(new Error('导入窗口已关闭。'));check();if(finished)return;
      event=this.app.vault.on('create',check);timer=setTimeout(()=>finish(new Error('Obsidian 尚未索引新文件，请稍后点击「打开已导入文档」。')),5000);check();
    });
    if(!this.alive)return;await openLocalEditor(this.app.workspace,'open',path);if(this.alive)this.close();
  }
  private render(){const el=this.contentEl;el.empty();el.createEl('h2',{text:'从飞书导入'});
    el.createEl('p',{text:'读取已有飞书文档，预览后保存为仓库中的新 XML，并建立飞书关联。',cls:'feishu-sync-help'});
    if(this.notice)el.createEl('p',{text:this.notice,cls:'feishu-sync-status',attr:{role:'status'}});
    if(this.importedPath){el.createEl('p',{text:'已导入：'+this.importedPath,cls:'feishu-sync-path'});button(el,'打开已导入文档',()=>void this.run(()=>this.openImported(),undefined,false),true).disabled=this.busy;return;}
    new Setting(el).setName('飞书文档地址').addText(input=>input.setValue(this.url).setPlaceholder('https://example.feishu.cn/docx/…').onChange(value=>{this.url=value;this.invalidatePreview();}));
    new Setting(el).setName('保存到仓库路径').setDesc('填写仓库内的新 XML 路径；目标文件和相邻同步记录必须不存在，所在文件夹须已存在。').addText(input=>input.setValue(this.path).onChange(value=>{this.path=value;this.invalidatePreview();}));
    button(el,'读取并预览飞书文档',()=>void this.run(async()=>{this.prepared=undefined;this.prepared=await this.plugin.backend().prepareImport({url:this.url,path:this.path});this.notice='预览已读取，请核对正文和保存路径后确认导入。';}),true).disabled=this.busy;
    const preview=el.createDiv({cls:'feishu-sync-import-preview'});
    if(this.prepared){const prepared=this.prepared;preview.createEl('h3',{text:prepared.title||'飞书正文'});preview.createEl('p',{text:'新文件：'+prepared.vaultPath,cls:'feishu-sync-path'});for(const warning of prepared.warnings)preview.createEl('p',{text:warning,cls:'feishu-sync-warning'});
      const actions=preview.createDiv({cls:'feishu-sync-actions feishu-sync-sticky-actions'});
      button(actions,'确认导入为新文档',()=>void this.run(async()=>{if(this.prepared!==prepared)throw new Error('地址或路径已变化，请重新读取预览。');const result=await this.plugin.backend().importDocument(prepared);this.importedPath=result.vaultPath;this.prepared=undefined;this.notice=['文档已导入。',...result.warnings].join(' ');if(this.alive&&result.warnings.length)new Notice(this.notice,12000);},()=>this.openImported()),true).disabled=this.busy;
      preview.createEl('pre',{text:prepared.xml,attr:{'aria-label':'导入正文预览',tabindex:'0'}});
    }
    if(this.busy)for(const control of Array.from(el.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input')))control.disabled=true;
  }
  private invalidatePreview(){this.prepared=undefined;this.contentEl.querySelector('.feishu-sync-import-preview')?.replaceChildren();}
}

class ProjectsModal extends Modal {
  private entries:LocalProjectEntry[]=[];private currentBinding?:ExistingBinding;private alive=true;private busy=false;private loading=true;private notice='';
  private drafts=new Map<string,{name:string;defaultDirection:SyncDirection}>();
  constructor(app:App,private readonly plugin:FeishuSyncPlugin,private readonly current:TFile|undefined,private readonly closed:()=>void){super(app);}
  onOpen(){this.modalEl.addClass('feishu-doc-local-sync-modal');this.render();void this.refresh();}
  onClose(){this.alive=false;this.contentEl.empty();this.closed();}
  private async refresh(){try{const backend=this.plugin.backend();this.entries=await backend.listProjects();this.currentBinding=this.current&&!this.entries.some(entry=>entry.vaultPath===this.current!.path&&entry.project.cloud)?await backend.existingBinding(this.plugin.absolute(this.current)):undefined;}catch(error){this.notice=readable(error);}this.loading=false;if(this.alive)this.render();}
  private async run(action:()=>Promise<void>){if(this.busy||!this.alive)return;this.busy=true;this.notice='';this.render();try{await action();}catch(error){this.notice=readable(error);}finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}}
  private render(){const el=this.contentEl;el.empty();el.createEl('h2',{text:'项目管理'});
    el.createEl('p',{text:'一个项目对应一份本地 XML，可先在本地写作，成熟后再关联飞书。列表与配置操作只在本地进行。',cls:'feishu-sync-help'});
    el.createEl('p',{text:'项目配置：'+this.plugin.settings.catalogPath,cls:'feishu-sync-path'});
    const actions=el.createDiv({cls:'feishu-sync-actions'});
    button(actions,'新建本地文档',()=>void this.run(async()=>{await openLocalEditor(this.app.workspace,'create',this.current?.path??'');this.close();}),true);
    button(actions,'刷新项目',()=>void this.run(()=>this.refresh()));
    button(actions,'CLI 与项目路径设置',()=>{this.close();this.plugin.openSettings();});
    if(this.current){
      const current=this.current;el.createEl('p',{text:'当前文档：'+current.path,cls:'feishu-sync-path'});
      const registered=this.entries.some(entry=>entry.vaultPath===current.path);
      if(!this.loading&&!registered&&this.currentBinding)button(actions,'恢复当前文档的飞书关联',()=>{this.close();this.plugin.open(current);});
      if(!this.loading&&!registered&&!this.currentBinding)button(actions,'将当前文档加入项目',()=>void this.run(async()=>{
        await withSyncLease(this.app.workspace,current.path,()=>{if(!this.alive)throw new Error('项目窗口已关闭，未建立新的关联。');return this.plugin.backend().bind(this.plugin.absolute(current),{kind:'none'},'push');});
        await this.refresh();this.notice='已加入纯本地项目，尚未调用飞书。';
      }));
    }
    if(this.notice)el.createEl('p',{text:this.notice,cls:'feishu-sync-status',attr:{role:'status'}});
    if(this.loading)el.createEl('p',{text:'正在读取本地项目列表…',attr:{role:'status'}});
    else if(!this.entries.length)el.createEl('p',{text:'还没有项目。可以新建文档，或将当前 XML 加入项目。'});
    for(const entry of this.entries){
      const {project}=entry,area=el.createEl('section',{cls:'feishu-sync-project',attr:{'aria-label':project.name}});
      area.createEl('h3',{text:project.name+(entry.vaultPath===this.current?.path?' · 当前项目':'')});
      area.createEl('p',{text:entry.vaultPath??project.localPath,cls:'feishu-sync-path'});
      area.createEl('p',{text:project.cloud?'已关联飞书文档':'仅保存在本地',cls:'feishu-sync-help'});
      if(project.cloud)area.createEl('a',{text:'打开关联的飞书文档',href:project.cloud.url,attr:{target:'_blank',rel:'noopener noreferrer'}});
      if(entry.unavailable){area.createEl('p',{text:entry.unavailable,cls:'feishu-sync-help'});button(area,'无法在当前仓库打开',()=>{}).disabled=true;continue;}
      let draft=this.drafts.get(project.id);if(!draft){draft={name:project.name,defaultDirection:project.defaultDirection};this.drafts.set(project.id,draft);}const edit=draft;
      new Setting(area).setName('项目名称').addText(input=>input.setValue(edit.name).onChange(value=>edit.name=value));
      const directions=area.createDiv({cls:'feishu-sync-segments',attr:{role:'group','aria-label':'默认同步方向'}});
      for(const [value,label] of [['pull','飞书 → 本地'],['push','本地 → 飞书']] as const){const direction=button(directions,label,()=>{edit.defaultDirection=value;this.render();});direction.setAttribute('aria-pressed',String(edit.defaultDirection===value));}
      const controls=area.createDiv({cls:'feishu-sync-actions'});
      button(controls,'打开项目',()=>void this.run(async()=>{await this.plugin.openRegistered(project.id);this.close();}),true);
      button(controls,project.cloud?'关联与同步':'关联飞书',()=>void this.run(async()=>{
        const checked=await this.plugin.backend().openProject(project.id),file=this.app.vault.getFileByPath(checked.vaultPath);
        if(!(file instanceof TFile)||file.extension.toLowerCase()!=='xml')throw new Error('库内 XML 不存在，请刷新文件列表。');
        if(this.alive){this.close();this.plugin.open(file);}
      }));
      button(controls,'保存项目配置',()=>void this.run(async()=>{await this.plugin.backend().updateProject(project.id,{...edit});this.drafts.delete(project.id);await this.refresh();this.notice='项目名称与默认方向已保存。正文和飞书内容保持原样。';}));
    }
    if(this.busy)for(const control of Array.from(el.querySelectorAll<HTMLInputElement|HTMLButtonElement>('input,button')))control.disabled=true;
  }
}

class SyncModal extends Modal {
  private root?:Root;private project?:ReviewProject;private prepared?:PreparedContent;private busy=false;private loading=true;private alive=true;private direction:SyncDirection='push';private notice='';private bindingKind:CreateProjectInput['cloud']['kind']='existing';private bindingURL='';private bindingTitle='';private bindingParent='';private existingBinding?:ExistingBinding;private recoveryURL='';private inspectionFailed=false;private readonly filePath:string;private confirmation?:Modal;
  constructor(app:App,private readonly plugin:FeishuSyncPlugin,private readonly file:TFile,private readonly closed:()=>void,private readonly initial?:{direction:SyncDirection;preview:true}){super(app);this.bindingTitle=file.basename;this.filePath=file.path;}
  onOpen(){this.modalEl.addClass('feishu-doc-local-sync-modal');this.render();void this.refresh();}
  onClose(){this.alive=false;this.confirmation?.close();this.root?.unmount();this.root=undefined;this.contentEl.empty();this.closed();}
  private async refresh(){this.inspectionFailed=false;try{const backend=this.plugin.backend(),path=this.plugin.absolute(this.file);this.project=await backend.project(path);this.direction=this.initial?.direction??this.project?.defaultDirection??'push';this.existingBinding=this.project?.cloud?undefined:await backend.existingBinding(path);if(!this.recoveryURL&&this.existingBinding?.url)this.recoveryURL=this.existingBinding.url;}catch(error){this.notice=readable(error);this.inspectionFailed=true;}this.loading=false;if(this.alive){this.render();if(this.initial&&this.project?.cloud&&!this.inspectionFailed)await this.preview();}}
  private preview(){const direction=this.direction;this.prepared=undefined;return this.run(async()=>{const prepared=await this.plugin.backend().preview(this.plugin.absolute(this.file),direction);if(prepared.view.direction!==direction||prepared.view.projectId!==this.project?.id)throw new Error('预览与当前项目或同步方向不一致，请重新预览。');this.prepared=prepared;this.notice=prepared.view.summary;});}
  private sync(direction:SyncDirection){this.direction=direction;this.prepared=undefined;return this.run(async()=>{
    const path=this.plugin.absolute(this.file),prepared=await this.plugin.backend().preview(path,direction);
    if(!this.alive)throw new Error('同步窗口已关闭，未启动新的飞书操作。');if(this.file.path!==this.filePath)throw new Error('文档路径已变化，请重新打开同步窗口。');
    if(prepared.view.status==='conflict'){this.prepared=prepared;this.notice='两端都有修改，请核对差异后再确认。';return;}
    const result=await this.plugin.backend().apply(path,prepared);this.project=result.project;this.notice=[result.summary,...result.warnings].join(' ');
  });}
  private async run(action:()=>Promise<void>){if(this.busy||!this.alive)return;const path=this.filePath;this.busy=true;this.notice='正在处理…';this.render();try{if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开同步窗口。');await withSyncLease(this.app.workspace,path,async()=>{if(!this.alive)throw new Error('同步窗口已关闭，未启动新的飞书操作。');if(this.file.path!==path)throw new Error('文档路径已变化，请重新打开同步窗口。');await action();});}catch(error){this.notice=readable(error);this.prepared=undefined;}finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}}
  private render(){this.root?.unmount();this.root=undefined;const el=this.contentEl;el.empty();el.createEl('h2',{text:this.initial?'正文差异预览':'关联设置'});el.createEl('p',{text:this.file.path,cls:'feishu-sync-path'});
    if(!this.initial&&!this.prepared)el.createEl('p',{text:'拉取更新本地；推送后自动更新本地，旧稿会存档。',cls:'feishu-sync-help'});
    if(this.notice)el.createEl('p',{text:this.notice,cls:'feishu-sync-status',attr:{role:'status'}});
    const navigation=el.createDiv({cls:'feishu-sync-actions'});
    button(navigation,'CLI 设置',()=>{this.close();this.plugin.openSettings();}).disabled=this.busy;
    if(this.loading){el.createEl('p',{text:'正在读取项目关联…',attr:{role:'status'}});return;}
    if(this.inspectionFailed){button(el,'重新读取项目关联',()=>void this.refresh()).disabled=this.busy;return;}
    const area=el.createDiv({cls:'feishu-sync-controls'});
    if(this.initial&&this.project?.cloud){
      this.renderPreviewDirections(area);
      if(this.prepared)this.renderPreview(el,this.prepared);
      else if(!this.busy)button(area,'重新预览差异',()=>void this.preview()).disabled=this.busy;
      return;
    }
    if(!this.project?.cloud){if(this.existingBinding)this.renderRecovery(area,this.existingBinding);else this.renderBinding(area);}else{
      area.createEl('a',{text:'打开关联的飞书文档',href:this.project.cloud.url,attr:{target:'_blank',rel:'noopener noreferrer'}});
      const actions=area.createDiv({cls:'feishu-sync-actions feishu-sync-sticky-actions'});
      button(actions,'拉取',()=>void this.sync('pull')).disabled=this.busy;
      button(actions,'推送',()=>void this.sync('push'),true).disabled=this.busy;
      button(actions,'预览差异',()=>void this.preview()).disabled=this.busy;
      button(actions,'同步评论、回复与处理状态',()=>this.confirmation=this.plugin.confirm('同步评论','将读取飞书评论，并把本地新增评论、回复和处理状态同步到这篇关联文档。找不到可靠块位置的意见会保留在本地。',()=>void this.run(async()=>{const result=await this.plugin.backend().comments(this.plugin.absolute(this.file));this.notice=`评论同步完成：导入 ${result.report.imported}，新建 ${result.report.created}，回复 ${result.report.replies}，状态 ${result.report.resolved}。`+result.report.issues.join(' ');this.prepared=undefined;}))).disabled=this.busy;
      if(this.prepared){this.renderPreviewDirections(area);this.renderPreview(el,this.prepared);}
    }
    if(this.busy)for(const control of Array.from(area.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input')))control.disabled=true;
  }
  private renderRecovery(area:HTMLElement,saved:ExistingBinding){
    area.createEl('h3',{text:'发现已有飞书同步记录'});
    area.createEl('p',{text:'这份 XML 已经同步过飞书，但当前项目配置中没有对应关联。恢复已有关联只补充本地项目列表，不创建飞书文档，也不覆盖正文或评论。'});
    area.createEl('p',{text:'原飞书文档 ID：'+saved.documentId,cls:'feishu-sync-path'});
    area.createEl('p',{text:'当前项目配置：'+this.plugin.settings.catalogPath,cls:'feishu-sync-path'});
    if(saved.error)area.createEl('p',{text:saved.error,cls:'feishu-sync-warning',attr:{role:'alert'}});
    else{
      if(saved.pending)area.createEl('p',{text:'原记录含未确认的同步操作。恢复关联会原样保留待定记录，不会重新发送；请核对飞书结果后处理。',cls:'feishu-sync-warning'});
      if(!saved.url)area.createEl('p',{text:'历史正文记录只有文档 ID，没有保存域名。请从飞书复制该文档的 Docx 地址，或通过 CLI 设置选择网页原来的项目配置文件。',cls:'feishu-sync-help'});
      new Setting(area).setName('已有飞书文档地址').addText(input=>input.setValue(this.recoveryURL).setPlaceholder('https://example.feishu.cn/docx/'+saved.documentId).onChange(value=>this.recoveryURL=value));
      button(area,'恢复已有飞书关联到项目列表',()=>void this.run(async()=>{
        this.project=await this.plugin.backend().restoreBinding(this.plugin.absolute(this.file),{revision:saved.revision,url:this.recoveryURL,defaultDirection:this.direction});
        this.existingBinding=undefined;this.notice='已有飞书关联已恢复；正文、评论和原同步记录均保留，尚未调用飞书。';
      }),true);
    }
    button(area,'重新读取同步记录',()=>void this.refresh());
  }
  private renderBinding(area:HTMLElement){let kind=this.bindingKind,url=this.bindingURL,title=this.bindingTitle,parentToken=this.bindingParent;
    const choices=area.createDiv({cls:'feishu-sync-segments',attr:{role:'group','aria-label':'飞书关联方式'}}),fields=area.createDiv();
    const draw=()=>{fields.empty();if(kind==='existing')new Setting(fields).setName('飞书文档地址').addText(input=>input.setPlaceholder('https://example.feishu.cn/docx/…').setValue(url).onChange(value=>{url=value;this.bindingURL=value;}));
      if(kind==='new'){new Setting(fields).setName('新飞书文档标题').addText(input=>input.setValue(title).onChange(value=>{title=value;this.bindingTitle=value;}));new Setting(fields).setName('父目录 token（可选）').addText(input=>input.setValue(parentToken).onChange(value=>{parentToken=value;this.bindingParent=value;}));}
      if(kind==='none')fields.createEl('p',{text:'保留为纯本地项目，以后再关联飞书。'});
      for(const child of Array.from(choices.querySelectorAll('button')))child.setAttribute('aria-pressed',String(child.dataset.kind===kind));
    };
    for(const [value,label] of [['existing','关联已有文档'],['new','新建飞书文档'],['none','仅保存在本地']] as const){const choice=button(choices,label,()=>{kind=value;this.bindingKind=value;draw();});choice.dataset.kind=value;}
    draw();
    button(area,'确认项目关联',()=>{const cloud:CreateProjectInput['cloud']=kind==='existing'?{kind,url}:kind==='new'?{kind,title,...(parentToken.trim()?{parentToken:parentToken.trim()}:{})}:{kind};
      const execute=()=>void this.run(async()=>{const result=await this.plugin.backend().bind(this.plugin.absolute(this.file),cloud,this.direction);this.project=result.project;this.notice=result.warning||'项目关联已保存。关联已有文档不会覆盖任一端正文。';});
      if(cloud.kind==='new')this.confirmation=this.plugin.confirm('创建并发布到飞书',`将当前本地正文及引用资源创建为「${cloud.title}」。成功后更新本地，旧稿会存档。`,execute);else execute();
    },true);
  }
  private renderPreviewDirections(area:HTMLElement){
    const directions=area.createDiv({cls:'feishu-sync-segments',attr:{role:'group','aria-label':'预览方向'}});
    for(const [value,label] of [['pull','飞书 → 本地'],['push','本地 → 飞书']] as const){const choice=button(directions,label,()=>{if(this.busy||value===this.direction)return;this.direction=value;void this.preview();});choice.setAttribute('aria-pressed',String(value===this.direction));choice.disabled=this.busy;}
  }
  private renderPreview(el:HTMLElement,prepared:PreparedContent){const view=prepared.view,presentation=contentSyncPresentation(view);
    el.createEl('h3',{text:presentation.operation});
    if(view.status!=='equal')el.createEl('p',{text:presentation.description+'评论单独同步。',cls:'feishu-sync-help'});
    const actions=el.createDiv({cls:'feishu-sync-actions feishu-sync-sticky-actions',attr:{'aria-label':'差异操作'}});
    const action=button(actions,presentation.confirm,()=>void this.run(async()=>{const result=await this.plugin.backend().apply(this.plugin.absolute(this.file),prepared);this.project=result.project;this.notice=[result.summary,...result.warnings].join(' ');this.prepared=undefined;}),true);action.disabled=this.busy||view.status==='equal';
    button(actions,'关闭',()=>this.close()).disabled=this.busy;
    for(const warning of view.warnings)el.createEl('p',{text:warning,cls:'feishu-sync-warning'});
    const diff=el.createDiv();this.root=createRoot(diff);this.root.render(<XMLDiff before={presentation.updatesLocal?view.localXML:view.cloudXML} after={presentation.updatesLocal?view.cloudXML:view.localXML} beforeLabel={presentation.beforeLabel} afterLabel={presentation.afterLabel}/>);
  }
}
class ConfirmModal extends Modal {
  private alive=true;
  constructor(app:App,private readonly titleText:string,private readonly explanation:string,private readonly confirm:()=>void,private readonly closed:()=>void){super(app);}
  onOpen(){this.contentEl.createEl('h2',{text:this.titleText});this.contentEl.createEl('p',{text:this.explanation});const actions=this.contentEl.createDiv({cls:'feishu-sync-actions'});button(actions,'取消',()=>this.close());button(actions,'确认',()=>{if(!this.alive)return;this.close();this.confirm();},true);}
  onClose(){this.alive=false;this.contentEl.empty();this.closed();}
}
