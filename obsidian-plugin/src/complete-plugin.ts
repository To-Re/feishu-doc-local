import { Notice, type Command, type EventRef, type PluginSettingTab } from 'obsidian';
import FeishuDocLocalPlugin from './plugin';
import FeishuSyncPlugin from '../../obsidian-sync-plugin/src/main';
import { CLISettingsStore } from './cli-settings';
import type { Preferences } from '../../obsidian-sync-plugin/src/preferences';

/** Reuse the synchronization implementation under one plugin lifecycle and ID. */
class EmbeddedSync extends FeishuSyncPlugin {
  constructor(private host:FeishuDocLocalPlugin,private settingsStore:CLISettingsStore,private active:()=>boolean){super(host.app,host.manifest);}
  async loadData(){try{return await this.settingsStore.load();}catch{throw new Error('CLI 配置读取或备份迁移失败，原文件已保留；请检查配置后重新保存。');}}
  saveData(value:Preferences){return this.settingsStore.save(value);}
  addCommand(command:Command){return this.active()?this.host.addCommand(command):command;}
  registerEvent(event:EventRef){if(this.active())this.host.registerEvent(event);else this.app.workspace.offref(event);}
  addSettingTab(tab:PluginSettingTab){if(this.active())this.host.addSettingTab(tab);}
  needsCLISetup(){return !this.settings.command;}
}

export default class CompleteFeishuPlugin extends FeishuDocLocalPlugin {
  private sync?:EmbeddedSync;
  private stopping=false;
  async onload(){
    await super.onload();
    if(this.stopping)return;
    const store=new CLISettingsStore(this.app.vault.adapter,this.app.vault.configDir);
    try {
      if(await store.legacyEnabled()){
        new Notice('已启用旧的飞书同步扩展。请先停用旧扩展，再重启本地飞书文档；旧配置会自动备份并迁入完整插件。本地编辑仍可使用。',15000);
        return;
      }
      if(this.stopping)return;
      const sync=new EmbeddedSync(this,store,()=>!this.stopping);this.sync=sync;
      await sync.onload();
      if(this.stopping){sync.onunload();this.sync=undefined;}
    } catch {
      this.sync?.onunload();this.sync=undefined;
      new Notice('同步组件未能启动，原配置已保留。本地阅读、编辑与评论仍可使用，请检查插件配置文件。',15000);
    }
  }
  onunload(){this.stopping=true;this.sync?.onunload();this.sync=undefined;super.onunload();}
}
