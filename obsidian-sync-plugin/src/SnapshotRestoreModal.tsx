import {Modal,type App,type TFile} from 'obsidian';
import {createRoot,type Root} from 'react-dom/client';
import {XMLDiff} from '../../src/ui/XMLDiff';
import type {PreparedContentRestore} from '../../src/server/content-history';
import {withSyncLease} from './bridge';
import type FeishuSyncPlugin from './main';

/** Local history has its own confirmation flow and never calls cloud sync. */
export class SnapshotRestoreModal extends Modal {
  private alive=true;private busy=false;private prepared?:PreparedContentRestore;private root?:Root;private notice='';private readonly filePath:string;
  constructor(app:App,private readonly plugin:FeishuSyncPlugin,private readonly file:TFile,private readonly closed:()=>void){super(app);this.filePath=file.path;}
  onOpen(){this.modalEl.addClass('feishu-doc-local-sync-modal');this.render();void this.preview();}
  onClose(){this.alive=false;this.root?.unmount();this.root=undefined;this.contentEl.empty();this.closed();}
  private button(parent:HTMLElement,text:string,action:()=>void,primary=false){const button=parent.createEl('button',{text,cls:primary?'mod-cta':''});button.type='button';button.disabled=this.busy;button.addEventListener('click',action);return button;}
  private async run(action:()=>Promise<void>){
    if(this.busy||!this.alive)return;this.busy=true;this.notice='';this.render();
    try{
      const assertCurrent=()=>{if(!this.alive)throw new Error('恢复窗口已关闭，未开始新的恢复操作。');if(this.file.path!==this.filePath)throw new Error('文档路径已变化，请重新打开恢复窗口。');};
      assertCurrent();await withSyncLease(this.app.workspace,this.filePath,async()=>{assertCurrent();await action();});
    }catch(error){this.prepared=undefined;this.notice=error instanceof Error?error.message:'恢复未完成，请重新核对本地文件。';}
    finally{this.busy=false;if(this.alive)this.render();this.plugin.refreshToolbars();}
  }
  private preview(){if(this.busy||!this.alive)return;this.prepared=undefined;return this.run(async()=>{
    const prepared=await this.plugin.backend().prepareRestore(this.plugin.absolute(this.file));
    if(!this.alive)return;if(prepared.view.localPath!==this.plugin.absolute(this.file))throw new Error('快照与当前文档不一致，请重新预览。');this.prepared=prepared;
  });}
  private apply(prepared:PreparedContentRestore){return this.run(async()=>{
    if(this.prepared!==prepared||prepared.view.localPath!==this.plugin.absolute(this.file))throw new Error('快照预览已变化，请重新预览。');
    if(!Number.isFinite(Date.parse(prepared.view.expiresAt))||Date.parse(prepared.view.expiresAt)<=Date.now())throw new Error('快照预览已过期，请重新预览。');
    const result=await this.plugin.backend().applyRestore(this.plugin.absolute(this.file),prepared);this.prepared=undefined;this.notice=[result.summary,...result.warnings].join(' ');
  });}
  private render(){this.root?.unmount();this.root=undefined;const el=this.contentEl;el.empty();el.createEl('h2',{text:'恢复上一快照'});el.createEl('p',{text:this.file.path,cls:'feishu-sync-path'});
    const actions=el.createDiv({cls:'feishu-sync-actions feishu-sync-sticky-actions',attr:{'aria-label':'快照操作'}});
    if(this.prepared){const prepared=this.prepared;this.button(actions,'确认恢复',()=>void this.apply(prepared),true);}else if(!this.busy)this.button(actions,'重新预览快照',()=>void this.preview());
    el.createEl('p',{text:'只恢复本地正文和评论，不修改飞书。确认后会先备份当前版本，较新的评论也保留在该备份中。',cls:'feishu-sync-help'});
    if(this.notice)el.createEl('p',{text:this.notice,cls:'feishu-sync-status',attr:{role:'status'}});
    if(this.busy)el.createEl('p',{text:this.prepared?'正在恢复本地快照…':'正在读取本地快照…',attr:{role:'status'}});
    if(!this.prepared)return;const {view}=this.prepared;
    el.createEl('p',{text:'快照：'+view.snapshotPath,cls:'feishu-sync-path'});el.createEl('p',{text:'保存时间：'+new Date(view.createdAt).toLocaleString(),cls:'feishu-sync-help'});
    for(const warning of view.warnings)el.createEl('p',{text:warning,cls:'feishu-sync-warning'});
    const diff=el.createDiv();this.root=createRoot(diff);this.root.render(<XMLDiff before={view.localXML} after={view.snapshotXML} beforeLabel="恢复前 · 当前本地正文" afterLabel="恢复后 · 上一快照正文"/>);
  }
}
