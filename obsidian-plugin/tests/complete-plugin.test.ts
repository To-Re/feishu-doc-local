import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,screen} from '@testing-library/dom';
vi.mock('obsidian',()=>import('../../obsidian-sync-plugin/tests/obsidian-mock'));
vi.mock('../src/plugin',()=>({default:class {
  commands:any[]=[];settingsTabs:any[]=[];events:any[]=[];manifest={id:'feishu-doc-local'};
  constructor(public app:any){}
  async onload(){this.commands.push({id:'open-xml'});}
  onunload(){for(const ref of this.events)this.app.workspace.offref(ref);}
  addCommand(value:any){this.commands.push(value);return value;}
  registerEvent(ref:any){this.events.push(ref);}
  addSettingTab(tab:any){this.settingsTabs.push(tab);}
}}));
import CompletePlugin from '../src/complete-plugin';
import FeishuSyncPlugin from '../../obsidian-sync-plugin/src/main';
import {prepareDOM,TFile,modals} from '../../obsidian-sync-plugin/tests/obsidian-mock';
const plugins:CompletePlugin[]=[];
beforeEach(prepareDOM);
afterEach(()=>{plugins.splice(0).forEach(plugin=>plugin.onunload());document.body.replaceChildren();modals.length=0;vi.restoreAllMocks();});
async function setup(legacy=false){
  const files=new Map<string,string>([['.obsidian/community-plugins.json',JSON.stringify(legacy?['feishu-doc-local-sync','feishu-doc-local']:['feishu-doc-local'])]]);
  const file=new TFile(),events=new Map<string,Set<Function>>();
  const workspace={getActiveFile:()=>file,on:(name:string,callback:Function)=>{if(!events.has(name))events.set(name,new Set());events.get(name)!.add(callback);return{name,callback};},offref:({name,callback}:any)=>events.get(name)?.delete(callback),trigger:(name:string,request?:any)=>{for(const fn of events.get(name)||[])fn(request);}};
  const adapter={exists:async(path:string)=>files.has(path),read:async(path:string)=>files.get(path)!,write:async(path:string,text:string)=>{files.set(path,text);},mkdir:async()=>{}};
  const app={workspace,vault:{configDir:'.obsidian',adapter,getFileByPath:()=>file,getFiles:()=>[file]}};
  const plugin=new CompletePlugin(app as any,{id:'feishu-doc-local'} as any);plugins.push(plugin);await plugin.onload();
  return{plugin:plugin as any,workspace,events,files,file};
}
describe('one complete Obsidian plugin',()=>{
  it('provides optional CLI settings without calling the backend or requiring CLI for the local editor',async()=>{
    const backend=vi.spyOn(FeishuSyncPlugin.prototype,'backend');const t=await setup();
    const container=document.body.appendChild(document.createElement('div'));
    t.workspace.trigger('feishu-doc-local:mount-toolbar',{path:t.file.path,container,accept:()=>{}});
    expect(container.textContent).toContain('本地功能可直接使用');expect(backend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'配置 CLI（可选）'}));
    expect(modals).toHaveLength(1);expect(backend).not.toHaveBeenCalled();
    expect(t.plugin.commands.map((c:any)=>c.id)).toEqual(['open-xml','open-sync','open-projects','open-cli-settings','import-cloud-document']);
    expect(t.plugin.settingsTabs).toHaveLength(1);
    t.plugin.onunload();expect([...t.events.values()].every(set=>set.size===0)).toBe(true);expect(modals).toHaveLength(0);
  });
  it('does not register a second sync toolbar, setting tab or command set while the old extension is enabled',async()=>{
    const t=await setup(true);
    expect(t.plugin.commands.map((c:any)=>c.id)).toEqual(['open-xml']);expect(t.plugin.settingsTabs).toHaveLength(0);
    expect(t.events.has('feishu-doc-local:mount-toolbar')).toBe(false);
    expect(t.files.size).toBe(1);
  });
});
