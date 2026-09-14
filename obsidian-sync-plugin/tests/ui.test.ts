// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {fireEvent,screen,waitFor,within} from '@testing-library/react';
import FeishuSyncPlugin from '../src/main';
import {FileSystemAdapter,modals,prepareDOM,TFile} from './obsidian-mock';
import type {SyncService} from '../src/service';
const bound={id:'project',name:'本地稿件',localPath:'/vault/article.xml',defaultDirection:'push',createdAt:new Date().toISOString(),cloud:{documentId:'Doc',url:'https://example.feishu.cn/docx/Doc'}};
const preview={view:{id:'preview',projectId:'project',direction:'push',status:'ready',localXML:'<p>本地新稿</p>',cloudXML:'<p>云端旧稿</p>',warnings:[],summary:'准备发布',expiresAt:new Date(Date.now()+100000).toISOString()},revision:'revision',remote:{},assets:{}};
const restorePreview={view:{id:'restore-preview',localPath:'/vault/article.xml',snapshotPath:'/vault/history/previous',createdAt:new Date().toISOString(),localXML:'<p>当前正文</p>',snapshotXML:'<p>上一正文</p>',warnings:[],expiresAt:new Date(Date.now()+60000).toISOString()},revision:'current'};
beforeEach(()=>{prepareDOM();});afterEach(()=>{for(const modal of [...modals])modal.close();document.body.replaceChildren();vi.restoreAllMocks();});
async function setup(project:unknown=bound,bridge=true){
  const release=vi.fn(async()=>{}),file=new TFile(),events=new Map<string,Function>(),vaultEvents=new Map<string,Function>(),files=new Map<string,TFile>([[file.path,file]]);const app:any={vault:{adapter:new FileSystemAdapter(),getFiles:()=>[...files.values()],getFileByPath:(path:string)=>files.get(path)??null,on:vi.fn((name,callback)=>{vaultEvents.set(name,callback);return{name};}),offref:vi.fn(ref=>vaultEvents.delete(ref.name))},workspace:{getActiveFile:()=>file,on:vi.fn((name,callback)=>{events.set(name,callback);return{};}),trigger:vi.fn((name,request)=>{if(name==='feishu-doc-local:acquire-sync'&&bridge)request.acquire(Promise.resolve({release}));else if(name==='feishu-doc-local:open-local'&&bridge)request.accept(Promise.resolve());else events.get(name)?.(request);})}};
  const plugin=new FeishuSyncPlugin(app,{id:'feishu-doc-local-sync',name:'同步',version:'0.1.0',author:'test',minAppVersion:'1.5.7'} as any);
  const service={existingBinding:vi.fn(async()=>undefined as any),restoreBinding:vi.fn(async()=>bound),listProjects:vi.fn(async()=>[{project:bound,vaultPath:'article.xml'}]),openProject:vi.fn(async()=>({project:bound,vaultPath:'article.xml'})),updateProject:vi.fn(async()=>bound),project:vi.fn(async()=>project),bind:vi.fn(async()=>({project:bound})),preview:vi.fn(async(_path?:string,_direction?:string)=>preview),apply:vi.fn(async()=>({project:bound,summary:'发布完成，原稿保留',warnings:[]})),prepareImport:vi.fn(async()=>({xml:'<p>云端导入正文</p>',documentId:'Doc',title:'导入文档',vaultPath:'导入.xml',path:'/vault/导入.xml',url:'https://example.feishu.cn/docx/Doc',expiresAt:new Date(Date.now()+60000).toISOString(),warnings:[]})),importDocument:vi.fn(async()=>({project:bound,vaultPath:'导入.xml',warnings:[]})),prepareRestore:vi.fn(async()=>restorePreview),applyRestore:vi.fn(async()=>({snapshot:'/vault/history/current-backup',summary:'本地正文和评论已恢复，当前版本已备份；未修改飞书。',warnings:[]})),comments:vi.fn(async()=>({report:{imported:1,created:1,replies:0,resolved:0,issues:[]}})),dispose:vi.fn()};
  vi.spyOn(plugin,'backend').mockReturnValue(service as unknown as SyncService);await plugin.onload();return {plugin,service,app,release,file,addFile:(path:string)=>{const created=new TFile();created.path=path;files.set(path,created);vaultEvents.get('create')?.(created);return created;},mount:()=>{const container=document.body.appendChild(document.createElement('div'));let dispose=()=>{};app.workspace.trigger('feishu-doc-local:mount-toolbar',{path:file.path,container,accept:(value:()=>void)=>dispose=value});return{container,dispose:()=>dispose()};},open:()=>{(plugin as any).commands[0].callback();}};
}
describe('Obsidian extension window interactions',()=>{
  it('does not call a cloud action on load or while merely opening the window',async()=>{const t=await setup();expect(t.service.project).not.toHaveBeenCalled();t.open();await screen.findByText('打开关联的飞书文档');expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();});
  it('keeps preview read-only until its top action is confirmed',async()=>{const t=await setup();t.plugin.openPreview(t.file as any,'push');await screen.findByRole('button',{name:'确认推送'});expect(t.service.apply).not.toHaveBeenCalled();expect(screen.getByRole('region',{name:'可滚动的正文差异'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'确认推送'}));await screen.findByText('发布完成，原稿保留');expect(t.service.apply).toHaveBeenCalledOnce();expect(t.release).toHaveBeenCalledTimes(2);});
  it('keeps association settings free of duplicate preview, sync and comment actions',async()=>{
    const t=await setup();const mounted=t.mount();await within(mounted.container).findByRole('button',{name:'预览同步'});
    fireEvent.click(within(mounted.container).getByRole('button',{name:'关联设置'}));await screen.findByRole('link',{name:'打开关联的飞书文档'});
    const settings=within(modals[0].contentEl);
    for(const name of ['预览同步','拉取','推送','同步评论','确认拉取','确认推送'])expect(settings.queryByRole('button',{name})).toBeNull();
    expect(settings.queryByRole('group',{name:'预览方向'})).toBeNull();expect(modals).toHaveLength(1);expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.preview).not.toHaveBeenCalled();
    expect(settings.getByRole('button',{name:'恢复上一快照'})).toBeTruthy();expect(settings.getByRole('button',{name:'从飞书导入新文档'})).toBeTruthy();
  });
  it('creates only after a second confirmation, retaining entered fields on failure',async()=>{const t=await setup(undefined);t.service.project.mockResolvedValue(undefined as any);t.open();fireEvent.click(await screen.findByRole('button',{name:'新建飞书文档'}));fireEvent.input(screen.getByLabelText('新飞书文档标题'),{target:{value:'用户输入标题'}});fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));expect(t.service.bind).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect((screen.getByLabelText('新飞书文档标题') as HTMLInputElement).value).toBe('用户输入标题');t.service.bind.mockRejectedValue(new Error('网络失败'));fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));await screen.findByText('网络失败');expect((screen.getByLabelText('新飞书文档标题') as HTMLInputElement).value).toBe('用户输入标题');});
  it('refuses all cloud calls when the base plugin is unavailable',async()=>{const t=await setup(bound,false);t.plugin.openPreview(t.file as any,'push');await screen.findByText(/请先安装并启用/);expect(t.service.preview).not.toHaveBeenCalled();});
  it('disables action controls during a pending operation and closes safely at unload',async()=>{const t=await setup();let finish:any;t.service.preview.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));t.plugin.openPreview(t.file as any,'push');await waitFor(()=>expect(t.service.preview).toHaveBeenCalled());expect((screen.getByRole('button',{name:'飞书 → 本地'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();t.plugin.onunload();expect(modals).toHaveLength(0);finish(preview);await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.apply).not.toHaveBeenCalled();});
});

it('does not start a delayed cloud action after its window closes while waiting for editor save',async()=>{
  const t=await setup(bound,false);let grant:any;t.app.workspace.trigger.mockImplementation((_name:string,request:any)=>request.acquire(new Promise(resolve=>{grant=resolve;})));
  t.plugin.openPreview(t.file as any,'push');await waitFor(()=>expect(grant).toBeTypeOf('function'));modals[0].close();grant({release:t.release});await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.preview).not.toHaveBeenCalled();
});
it('cannot change CLI configuration while a preview is open and does not replace settings when persistence fails',async()=>{
  const t=await setup();t.open();await screen.findByRole('link',{name:'打开关联的飞书文档'});const next={command:'/configured/other-cli',args:[],catalogPath:'/configured/projects.json'};
  await expect(t.plugin.updateSettings(next)).rejects.toThrow('关闭同步窗口');modals[0].close();const original=t.plugin.settings;vi.spyOn(t.plugin,'saveData').mockRejectedValueOnce(new Error('disk failed'));
  await expect(t.plugin.updateSettings(next)).rejects.toThrow('disk failed');expect(t.plugin.settings).toBe(original);await t.plugin.updateSettings(next);expect(t.plugin.settings).toEqual(next);
});


it('opens visible host sync and project actions without cloud calls',async()=>{
  const t=await setup();const request={action:'sync',path:'article.xml',handled:false};t.app.workspace.trigger('feishu-doc-local:open-action',request);
  expect(request.handled).toBe(true);await screen.findByRole('link',{name:'打开关联的飞书文档'});modals[0].close();
  const projects={action:'projects',path:'article.xml',handled:false};t.app.workspace.trigger('feishu-doc-local:open-action',projects);
  expect(projects.handled).toBe(true);await screen.findByRole('button',{name:'打开项目'});expect(t.service.listProjects).toHaveBeenCalledOnce();
  expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();
});
it('saves project metadata locally and opens through the base plugin event',async()=>{
  const t=await setup();t.plugin.openProjects();await screen.findByRole('button',{name:'打开项目'});
  fireEvent.input(screen.getByLabelText('项目名称'),{target:{value:'改名的本地项目'}});fireEvent.click(screen.getByRole('button',{name:'飞书 → 本地'}));
  fireEvent.click(screen.getByRole('button',{name:'保存项目配置'}));await screen.findByText(/项目名称与默认方向已保存/);
  expect(t.service.updateProject).toHaveBeenCalledWith('project',{name:'改名的本地项目',defaultDirection:'pull'});
  expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'打开项目'}));await waitFor(()=>expect(modals).toHaveLength(0));
  expect(t.app.workspace.trigger).toHaveBeenCalledWith('feishu-doc-local:open-local',expect.objectContaining({action:'open',path:'article.xml'}));
});
it('shows unavailable cross-vault registrations disabled without opening their files',async()=>{
  const t=await setup();t.service.listProjects.mockResolvedValue([{project:{...bound,localPath:'/another-vault/article.xml'},unavailable:'不在当前 Obsidian 仓库内'}] as any);
  t.plugin.openProjects();const unavailable=await screen.findByRole('button',{name:'无法在当前仓库打开'});expect((unavailable as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'打开项目'})).toBeNull();expect(t.service.openProject).not.toHaveBeenCalled();
});
it('opens explicit CLI settings without executing commands and can save unconfigured local catalog settings',async()=>{
  const t=await setup();t.plugin.openProjects();await screen.findByRole('button',{name:'打开项目'});fireEvent.click(screen.getByRole('button',{name:'CLI 与项目路径设置'}));
  expect(screen.getByLabelText('CLI 可执行文件')).toBeTruthy();expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存；尚未运行 CLI。');expect(t.plugin.settings.command).toBe('');
});
it('uses the base create flow and registers the current XML as local only after explicit action',async()=>{
  const t=await setup();t.service.listProjects.mockResolvedValue([]);t.plugin.openProjects(new TFile() as any);
  fireEvent.click(await screen.findByRole('button',{name:'将当前文档加入项目'}));await screen.findByText(/已加入纯本地项目/);
  expect(t.service.bind).toHaveBeenCalledWith('/vault/article.xml',{kind:'none'},'push');expect(t.release).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'新建本地文档'}));await waitFor(()=>expect(modals).toHaveLength(0));
  expect(t.app.workspace.trigger).toHaveBeenCalledWith('feishu-doc-local:open-local',expect.objectContaining({action:'create',path:'article.xml'}));
});

it('does not register a project after its window closes while waiting for the editor lease',async()=>{
  const t=await setup(bound,false);let grant:any;
  t.service.listProjects.mockResolvedValue([]);t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(new Promise(resolve=>{grant=resolve;}));});
  t.plugin.openProjects(new TFile() as any);fireEvent.click(await screen.findByRole('button',{name:'将当前文档加入项目'}));
  await waitFor(()=>expect(grant).toBeTypeOf('function'));modals[0].close();grant({release:t.release});
  await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.bind).not.toHaveBeenCalled();
});


it('uses the saved pull direction for preview after navigating project management',async()=>{
  const t=await setup({...bound,defaultDirection:'pull'});
  t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction:'pull',summary:'从飞书拉取'}});
  t.open();await screen.findByRole('link',{name:'打开关联的飞书文档'});expect(t.service.preview).not.toHaveBeenCalled();
  modals[0].close();t.plugin.openProjects();await screen.findByRole('button',{name:'打开项目'});
  fireEvent.click(screen.getByRole('button',{name:'关联设置'}));await screen.findByRole('heading',{name:'关联设置'});
  modals[0].close();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));await screen.findByRole('button',{name:'确认拉取'});
  expect(t.service.preview).toHaveBeenCalledWith('/vault/article.xml','pull');expect(t.service.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'确认拉取'}));await waitFor(()=>expect(t.service.apply).toHaveBeenCalledOnce());expect(t.release).toHaveBeenCalledTimes(2);
});
it('changes optional preview direction without applying either body',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');await screen.findByRole('button',{name:'确认推送'});
  expect(screen.getByRole('heading',{name:'推送 · 本地 → 飞书'})).toBeTruthy();
  expect(await screen.findByText('推送前 · 飞书正文')).toBeTruthy();
  t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction:'pull',summary:'拉取差异'}});
  fireEvent.click(screen.getByRole('button',{name:'飞书 → 本地'}));await screen.findByRole('button',{name:'确认拉取'});
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(t.service.preview).toHaveBeenLastCalledWith('/vault/article.xml','pull');expect(t.service.apply).not.toHaveBeenCalled();
  expect(screen.getByRole('heading',{name:'拉取 · 飞书 → 本地'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'确认拉取'})).toBeTruthy();
  expect(await screen.findByText('拉取前 · 本地正文')).toBeTruthy();
  expect(document.querySelector('.xml-diff-removed code')!.textContent).toContain('本地新稿');
  expect(document.querySelector('.xml-diff-added code')!.textContent).toContain('云端旧稿');
  t.service.preview.mockResolvedValue(preview);
  fireEvent.click(screen.getByRole('button',{name:'本地 → 飞书'}));await screen.findByRole('button',{name:'确认推送'});
  expect(screen.getByRole('button',{name:'确认推送'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'确认拉取'})).toBeNull();
  expect(t.service.preview).toHaveBeenLastCalledWith('/vault/article.xml','push');
  expect(await screen.findByText('推送前 · 飞书正文')).toBeTruthy();
  expect(document.querySelector('.xml-diff-removed code')!.textContent).toContain('云端旧稿');
  expect(t.service.apply).not.toHaveBeenCalled();
});
it('offers both preview directions in the dedicated window and hides the old action while changing direction',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');await screen.findByRole('button',{name:'确认推送'});
  let finish:any;t.service.preview.mockImplementation(()=>new Promise(resolve=>finish=resolve));
  fireEvent.click(screen.getByRole('button',{name:'飞书 → 本地'}));await waitFor(()=>expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(screen.queryByRole('region',{name:'可滚动的正文差异'})).toBeNull();
  finish({...preview,view:{...preview.view,direction:'pull'}});
  await screen.findByRole('button',{name:'确认拉取'});expect(t.service.apply).not.toHaveBeenCalled();
});
it('rejects a preview for the wrong direction instead of displaying an inconsistent action',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'pull');
  await screen.findByText('预览与当前项目或同步方向不一致，请重新预览。');
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(screen.queryByRole('button',{name:'确认拉取'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();
});
it('shows equal content without a body write action',async()=>{
  const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,status:'equal'}});t.plugin.openPreview(t.file as any,'push');
  await screen.findByText('两端正文一致，无需拉取或推送。');
  for(const name of ['确认推送','确认拉取','更新本地副本'])expect(screen.queryByRole('button',{name})).toBeNull();
  expect(screen.getByRole('button',{name:'刷新预览'})).toBeTruthy();expect(t.service.apply).not.toHaveBeenCalled();
});
it('rejects a preview for another project',async()=>{
  const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,projectId:'other'}});t.plugin.openPreview(t.file as any,'push');
  await screen.findByText('预览与当前项目或同步方向不一致，请重新预览。');expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();
});
it('never applies a detached action after the displayed direction has changed',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');const oldAction=await screen.findByRole('button',{name:'确认推送'});
  t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction:'pull'}});fireEvent.click(screen.getByRole('button',{name:'飞书 → 本地'}));await screen.findByRole('button',{name:'确认拉取'});
  fireEvent.click(oldAction);await screen.findByText('预览已变化，请重新核对差异。');expect(t.service.apply).not.toHaveBeenCalled();
});
it('expires an old preview before applying and permits a fresh preview',async()=>{
  const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,expiresAt:new Date(Date.now()-1000).toISOString()}});t.plugin.openPreview(t.file as any,'push');
  fireEvent.click(await screen.findByRole('button',{name:'确认推送'}));await screen.findByText('预览已过期，请重新预览。');expect(t.service.apply).not.toHaveBeenCalled();
  t.service.preview.mockResolvedValue(preview);fireEvent.click(screen.getByRole('button',{name:'重新预览'}));await screen.findByRole('button',{name:'确认推送'});expect(t.service.apply).not.toHaveBeenCalled();
});
it('does not apply an approved preview after its modal closes while waiting for the lease',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');const action=await screen.findByRole('button',{name:'确认推送'});let grant:any;
  t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(new Promise(resolve=>grant=resolve));});
  fireEvent.click(action);await waitFor(()=>expect(grant).toBeTypeOf('function'));modals[0].close();grant({release:t.release});await waitFor(()=>expect(t.release).toHaveBeenCalledTimes(2));expect(t.service.apply).not.toHaveBeenCalled();
});
it('blocks confirmation after the document path changes',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');const action=await screen.findByRole('button',{name:'确认推送'});t.file.path='renamed.xml';fireEvent.click(action);
  await screen.findByText('文档路径已变化，请重新打开同步窗口。');expect(t.service.apply).not.toHaveBeenCalled();
});
it('offers readback adoption separately from push and never confirms it implicitly',async()=>{
  const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,action:'refresh-local',summary:'发布已完成，选择是否采用回读'}} as any);
  t.plugin.openPreview(t.file as any,'push');await screen.findByRole('button',{name:'更新本地副本'});
  expect(screen.getByRole('heading',{name:'推送已完成 · 更新本地副本'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'更新本地副本'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'确认拉取'})).toBeNull();
  expect(await screen.findByText('更新后 · 采用飞书正文')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();
  modals[0].close();expect(t.service.apply).not.toHaveBeenCalled();
});
it('binds an existing document without publishing or adding duplicate body actions',async()=>{
  const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.open();
  fireEvent.input(await screen.findByLabelText('飞书文档地址'),{target:{value:'https://example.feishu.cn/docx/Doc'}});
  fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));await screen.findByRole('link',{name:'打开关联的飞书文档'});
  expect(screen.queryByRole('button',{name:'预览同步'})).toBeNull();expect(screen.queryByRole('button',{name:'拉取'})).toBeNull();expect(screen.queryByRole('button',{name:'推送'})).toBeNull();
  expect(t.service.bind).toHaveBeenCalledWith('/vault/article.xml',{kind:'existing',url:'https://example.feishu.cn/docx/Doc'},'push');
  expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();
});


it('shows historical binding recovery instead of new cloud creation when the catalog is missing',async()=>{
  const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.service.existingBinding.mockResolvedValue({revision:'existing',documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',pending:false});
  t.open();await screen.findByText('发现已有飞书同步记录');expect(screen.queryByRole('button',{name:'新建飞书文档'})).toBeNull();
  expect(t.service.restoreBinding).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'恢复已有飞书关联到项目列表'}));await screen.findByRole('link',{name:'打开关联的飞书文档'});
  expect(t.service.restoreBinding).toHaveBeenCalledWith('/vault/article.xml',{revision:'existing',url:'https://example.feishu.cn/docx/Doc',defaultDirection:'push'});
  expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();expect(t.release).toHaveBeenCalledOnce();
});
it('explains missing historical URL and conflicting IDs without offering a new document',async()=>{
  const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.service.existingBinding.mockResolvedValue({revision:'existing',documentId:'Doc',pending:false});
  t.open();await screen.findByText(/历史正文记录只有文档 ID/);expect((screen.getByLabelText('已有飞书文档地址') as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('button',{name:'新建飞书文档'})).toBeNull();modals[0].close();
  t.service.existingBinding.mockResolvedValue({revision:'existing',documentId:'Doc',pending:false,error:'正文与评论 ID 不一致'});t.open();
  await screen.findByText('正文与评论 ID 不一致');expect(screen.queryByRole('button',{name:'恢复已有飞书关联到项目列表'})).toBeNull();expect(t.service.bind).not.toHaveBeenCalled();
});
it('does not expose a new binding form after project or sidecar inspection fails',async()=>{
  const t=await setup();t.service.project.mockRejectedValue(new Error('项目配置文件损坏'));t.open();await screen.findByText('项目配置文件损坏');
  expect(screen.queryByRole('button',{name:'新建飞书文档'})).toBeNull();expect(screen.getByRole('button',{name:'CLI 设置'})).toBeTruthy();expect(screen.getByRole('button',{name:'重新读取项目关联'})).toBeTruthy();
});
it('lets a failed preview repair its catalog configuration without keeping the sync window open or calling the cloud',async()=>{
  const t=await setup();t.plugin.settings.catalogPath='/retired/project/projects.json';
  t.service.project.mockRejectedValue(new Error('项目索引目录已被移动或删除，请重新打开。'));
  const save=vi.spyOn(t.plugin,'saveData');t.plugin.openPreview(t.file as any,'push');
  await screen.findByText('项目索引目录已被移动或删除，请重新打开。');
  expect(screen.getByText('当前项目配置：/retired/project/projects.json')).toBeTruthy();
  expect(screen.getByRole('button',{name:'重新读取项目关联'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'新建飞书文档'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'CLI 设置'}));
  expect(screen.queryByRole('heading',{name:'正文同步预览'})).toBeNull();expect(modals).toHaveLength(1);
  fireEvent.input(screen.getByLabelText('项目配置文件'),{target:{value:'/current/project/projects.json'}});
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存；尚未运行 CLI。');
  expect(t.plugin.settings.catalogPath).toBe('/current/project/projects.json');
  expect(save).toHaveBeenCalledWith(expect.objectContaining({catalogPath:'/current/project/projects.json'}));
  for(const method of [t.service.preview,t.service.apply,t.service.bind,t.service.comments,t.service.prepareImport])expect(method).not.toHaveBeenCalled();
  expect(t.release).not.toHaveBeenCalled();t.plugin.onunload();
});

it('routes orphaned historical documents from project management into recovery instead of local registration',async()=>{
  const t=await setup();t.service.listProjects.mockResolvedValue([]);t.service.project.mockResolvedValue(undefined as any);t.service.existingBinding.mockResolvedValue({revision:'old',documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',pending:false});
  t.plugin.openProjects(new TFile() as any);fireEvent.click(await screen.findByRole('button',{name:'恢复当前文档的飞书关联'}));
  await screen.findByText('发现已有飞书同步记录');expect(screen.queryByRole('button',{name:'将当前文档加入项目'})).toBeNull();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.restoreBinding).not.toHaveBeenCalled();
});


describe('inline editor sync toolbar',()=>{
  it('shows a single body preview entry and secondary comments and association controls',async()=>{
    const t=await setup();const mounted=t.mount();await within(mounted.container).findByRole('button',{name:'预览同步'});
    expect(within(mounted.container).getAllByRole('button').map(button=>button.textContent)).toEqual(['预览同步','同步评论','关联设置']);
    expect(mounted.container.querySelectorAll('button.mod-cta')).toHaveLength(1);
    expect(within(mounted.container).getByRole('link',{name:'打开飞书'}).getAttribute('href')).toBe(bound.cloud.url);
    for(const method of [t.service.preview,t.service.apply,t.service.comments,t.service.bind,t.service.prepareImport])expect(method).not.toHaveBeenCalled();
    mounted.dispose();expect(mounted.container.children).toHaveLength(0);t.plugin.onunload();
  });
  it.each(['pull','push'] as const)('requires visible %s preview and confirmation inside separate editor leases',async direction=>{
    const t=await setup({...bound,defaultDirection:direction});const prepared={...preview,view:{...preview.view,direction}};t.service.preview.mockResolvedValue(prepared);const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));const action=await screen.findByRole('button',{name:direction==='push'?'确认推送':'确认拉取'});
    expect(t.service.preview).toHaveBeenCalledWith('/vault/article.xml',direction);expect(t.service.apply).not.toHaveBeenCalled();expect(t.release).toHaveBeenCalledOnce();
    fireEvent.click(action);await screen.findByText('发布完成，原稿保留');expect(t.service.apply).toHaveBeenCalledWith('/vault/article.xml',prepared);expect(t.release).toHaveBeenCalledTimes(2);t.plugin.onunload();
  });
  it('keeps direction and its sole confirm action together above the diff',async()=>{
    const t=await setup();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));
    const diff=await screen.findByRole('region',{name:'可滚动的正文差异'}),action=screen.getByRole('button',{name:'确认推送'}),directions=screen.getByRole('group',{name:'预览方向'});
    expect(action.compareDocumentPosition(diff)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(action.closest('.feishu-sync-sticky-actions')).toBe(directions.closest('.feishu-sync-sticky-actions'));
    expect(screen.queryByRole('button',{name:'关闭'})).toBeNull();expect(screen.queryByRole('button',{name:'CLI 设置'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it.each(['pull','push'] as const)('remembers the last chosen %s preview direction after closing',async direction=>{
    const initial=direction==='push'?'pull':'push';const t=await setup({...bound,defaultDirection:initial});const mounted=t.mount();
    t.service.preview.mockImplementation(async(_path,selected)=>({...preview,view:{...preview.view,direction:selected!}}));
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));await screen.findByRole('button',{name:initial==='push'?'确认推送':'确认拉取'});
    fireEvent.click(screen.getByRole('button',{name:direction==='push'?'本地 → 飞书':'飞书 → 本地'}));await screen.findByRole('button',{name:direction==='push'?'确认推送':'确认拉取'});modals[0].close();
    fireEvent.click(within(mounted.container).getByRole('button',{name:'预览同步'}));await screen.findByRole('button',{name:direction==='push'?'确认推送':'确认拉取'});
    expect(t.service.preview).toHaveBeenLastCalledWith('/vault/article.xml',direction);expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('shows conflicts for explicit confirmation without applying or retrying a write',async()=>{
    const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,status:'conflict'}});const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));await screen.findByText(/两端都有修改，请核对差异/);
    await screen.findByRole('button',{name:'确认推送'});expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('does not prepare or publish when the editor rejects an unsent draft',async()=>{
    const t=await setup();const mounted=t.mount();await within(mounted.container).findByRole('button',{name:'预览同步'});
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(Promise.reject(new Error('请先处理未发送评论草稿')));});
    fireEvent.click(within(mounted.container).getByRole('button',{name:'预览同步'}));await screen.findByText('请先处理未发送评论草稿');
    expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('closes its preview if the document view is disposed while preparing',async()=>{
    const t=await setup();let finish:any;t.service.preview.mockImplementation(()=>new Promise(resolve=>finish=resolve));const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));await waitFor(()=>expect(t.service.preview).toHaveBeenCalledOnce());
    mounted.dispose();expect(modals).toHaveLength(0);finish(preview);await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('disables directions while applying and does not retry an uncertain result',async()=>{
    const t=await setup();let finish:any;t.service.apply.mockImplementation(()=>new Promise((_resolve,reject)=>finish=reject));const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览同步'}));fireEvent.click(await screen.findByRole('button',{name:'确认推送'}));await waitFor(()=>expect(t.service.apply).toHaveBeenCalledOnce());
    expect((screen.getByRole('button',{name:'飞书 → 本地'}) as HTMLButtonElement).disabled).toBe(true);
    finish(new Error('上次同步未确认，请先核对飞书'));await screen.findByText('上次同步未确认，请先核对飞书');expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();
    expect(t.service.apply).toHaveBeenCalledOnce();expect(t.release).toHaveBeenCalledTimes(2);t.plugin.onunload();
  });
  it('confirms comments directly, disables controls while pending and refreshes after release',async()=>{
    const t=await setup();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'同步评论'}));
    expect(t.service.comments).not.toHaveBeenCalled();expect(screen.queryByRole('heading',{name:'关联设置'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(t.service.comments).not.toHaveBeenCalled();
    let finish:any;t.service.comments.mockImplementation(()=>new Promise(resolve=>finish=resolve));fireEvent.click(within(mounted.container).getByRole('button',{name:'同步评论'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));
    await waitFor(()=>expect(t.service.comments).toHaveBeenCalledOnce());expect((within(mounted.container).getByRole('button',{name:'关联设置'}) as HTMLButtonElement).disabled).toBe(true);
    finish({report:{imported:1,created:0,replies:0,resolved:0,issues:[]}});await screen.findByText(/评论同步完成/);expect(t.release).toHaveBeenCalledOnce();expect(t.service.project.mock.calls.length).toBeGreaterThan(1);t.plugin.onunload();
  });
  it('blocks comments for a rejected draft lease and cancels confirmation when the view unmounts',async()=>{
    const t=await setup();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'同步评论'}));
    const confirm=screen.getByRole('button',{name:'确认'});mounted.dispose();fireEvent.click(confirm);expect(t.service.comments).not.toHaveBeenCalled();expect(modals).toHaveLength(0);
    const again=t.mount();await within(again.container).findByRole('button',{name:'同步评论'});
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(Promise.reject(new Error('请先处理未发送评论草稿')));});
    fireEvent.click(within(again.container).getByRole('button',{name:'同步评论'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));
    await within(again.container).findByText('请先处理未发送评论草稿');expect(t.service.comments).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('does not sync a renamed or disposed file after waiting for its lease',async()=>{
    const t=await setup();const mounted=t.mount();await within(mounted.container).findByRole('button',{name:'同步评论'});let grant:any;
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(new Promise(resolve=>grant=resolve));});
    fireEvent.click(within(mounted.container).getByRole('button',{name:'同步评论'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));await waitFor(()=>expect(grant).toBeTypeOf('function'));
    t.file.path='renamed.xml';grant({release:t.release});await within(mounted.container).findByText('文档路径已变化，请重新打开文档。');expect(t.service.comments).not.toHaveBeenCalled();expect(t.release).toHaveBeenCalledOnce();t.plugin.onunload();
  });
  it('exposes binding for unbound XML and reports inspection failures without guessing a new association',async()=>{
    const t=await setup();t.service.project.mockResolvedValue(undefined as any);const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'关联'}));
    await screen.findByRole('button',{name:'确认项目关联'});expect(t.service.bind).not.toHaveBeenCalled();modals[0].close();t.service.project.mockRejectedValue(new Error('项目配置损坏'));t.plugin.refreshToolbars();
    await within(mounted.container).findByText('项目配置损坏');expect(within(mounted.container).queryByRole('button',{name:'关联'})).toBeNull();expect(within(mounted.container).getByRole('button',{name:'CLI 设置'})).toBeTruthy();t.plugin.onunload();
  });
});

describe('cloud document import interaction',()=>{
  it('previews on explicit action and imports only after confirmation, then waits for vault indexing before opening',async()=>{
    const t=await setup();t.plugin.openImport(t.file as any);
    expect(t.service.prepareImport).not.toHaveBeenCalled();fireEvent.input(screen.getByLabelText('飞书文档地址'),{target:{value:'https://example.feishu.cn/docx/Doc'}});fireEvent.input(screen.getByLabelText('保存到仓库路径'),{target:{value:'导入.xml'}});
    fireEvent.click(screen.getByRole('button',{name:'读取并预览飞书文档'}));await screen.findByLabelText('导入正文预览');expect(t.service.prepareImport).toHaveBeenCalledWith({url:'https://example.feishu.cn/docx/Doc',path:'导入.xml'});expect(t.service.importDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'确认导入为新文档'}));await waitFor(()=>expect(t.app.vault.on).toHaveBeenCalledWith('create',expect.any(Function)));
    expect(t.service.importDocument).toHaveBeenCalledOnce();expect(t.release).toHaveBeenCalledTimes(2);expect(t.app.workspace.trigger).not.toHaveBeenCalledWith('feishu-doc-local:open-local',expect.anything());
    t.addFile('导入.xml');await waitFor(()=>expect(modals).toHaveLength(0));expect(t.app.workspace.trigger).toHaveBeenCalledWith('feishu-doc-local:open-local',expect.objectContaining({action:'open',path:'导入.xml'}));expect(t.app.vault.offref).toHaveBeenCalledOnce();t.plugin.onunload();
  });
  it('invalidates import confirmation when URL or path changes and preserves input on failure',async()=>{
    const t=await setup();t.plugin.openImport(t.file as any);fireEvent.input(screen.getByLabelText('飞书文档地址'),{target:{value:'https://example.feishu.cn/docx/Doc'}});fireEvent.click(screen.getByRole('button',{name:'读取并预览飞书文档'}));await screen.findByRole('button',{name:'确认导入为新文档'});
    fireEvent.input(screen.getByLabelText('保存到仓库路径'),{target:{value:'已存在.xml'}});expect(screen.queryByRole('button',{name:'确认导入为新文档'})).toBeNull();t.service.prepareImport.mockRejectedValue(new Error('目标文件已存在'));
    fireEvent.click(screen.getByRole('button',{name:'读取并预览飞书文档'}));await screen.findByText('目标文件已存在');expect((screen.getByLabelText('保存到仓库路径') as HTMLInputElement).value).toBe('已存在.xml');expect(t.service.importDocument).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('does not repeat a successful import if opening fails and supports retrying only the open action',async()=>{
    const t=await setup();t.addFile('导入.xml');t.plugin.openImport(t.file as any);fireEvent.click(screen.getByRole('button',{name:'读取并预览飞书文档'}));await screen.findByRole('button',{name:'确认导入为新文档'});
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(Promise.resolve({release:t.release}));else if(name==='feishu-doc-local:open-local')request.accept(Promise.reject(new Error('打开失败')));});
    fireEvent.click(screen.getByRole('button',{name:'确认导入为新文档'}));await screen.findByText(/文档已导入到 导入.xml；打开失败/);expect(screen.queryByRole('button',{name:'确认导入为新文档'})).toBeNull();
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:open-local')request.accept(Promise.resolve());});fireEvent.click(screen.getByRole('button',{name:'打开已导入文档'}));await waitFor(()=>expect(modals).toHaveLength(0));expect(t.service.importDocument).toHaveBeenCalledOnce();t.plugin.onunload();
  });
  it('cancels pending indexing listeners on unload without reopening the imported document',async()=>{
    const t=await setup();t.plugin.openImport(t.file as any);fireEvent.click(screen.getByRole('button',{name:'读取并预览飞书文档'}));await screen.findByRole('button',{name:'确认导入为新文档'});fireEvent.click(screen.getByRole('button',{name:'确认导入为新文档'}));
    await waitFor(()=>expect(t.app.vault.on).toHaveBeenCalledWith('create',expect.any(Function)));t.plugin.onunload();t.addFile('导入.xml');await waitFor(()=>expect(t.app.vault.offref).toHaveBeenCalledOnce());expect(t.app.workspace.trigger).not.toHaveBeenCalledWith('feishu-doc-local:open-local',expect.anything());expect(modals).toHaveLength(0);
  });
});


describe('local snapshot restore interaction',()=>{
  it('opens from association settings as a single window and previews without a cloud or local write',async()=>{
    const t=await setup();t.open();fireEvent.click(await screen.findByRole('button',{name:'恢复上一快照'}));
    const confirm=await screen.findByRole('button',{name:'确认恢复'});expect(modals).toHaveLength(1);expect(screen.queryByRole('heading',{name:'关联设置'})).toBeNull();
    expect(t.service.prepareRestore).toHaveBeenCalledWith('/vault/article.xml');expect(t.service.applyRestore).not.toHaveBeenCalled();expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();
    expect(await screen.findByText('恢复前 · 当前本地正文')).toBeTruthy();expect(await screen.findByText('恢复后 · 上一快照正文')).toBeTruthy();
    const diff=screen.getByRole('region',{name:'可滚动的正文差异'});expect(confirm.compareDocumentPosition(diff)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(confirm.closest('.feishu-sync-sticky-actions')).toBeTruthy();
    expect(screen.getByText(/只恢复本地正文和评论，不修改飞书/)).toBeTruthy();expect(screen.getByText(/较新的评论也保留在该备份中/)).toBeTruthy();
    fireEvent.click(confirm);await screen.findByText('本地正文和评论已恢复，当前版本已备份；未修改飞书。');
    expect(t.service.applyRestore).toHaveBeenCalledWith('/vault/article.xml',restorePreview);expect(t.release).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:'确认恢复'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();
  });
  it('reports missing snapshots without exposing a restore action or calling cloud',async()=>{
    const t=await setup();t.service.prepareRestore.mockRejectedValue(new Error('没有可恢复的同步快照。'));t.plugin.openRestore(t.file as any);
    await screen.findByText('没有可恢复的同步快照。');expect(screen.queryByRole('button',{name:'确认恢复'})).toBeNull();expect(t.service.applyRestore).not.toHaveBeenCalled();expect(t.service.preview).not.toHaveBeenCalled();
  });
  it('offers local restore for an unbound document and does not bind it',async()=>{
    const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.open();fireEvent.click(await screen.findByRole('button',{name:'恢复上一快照'}));await screen.findByRole('button',{name:'确认恢复'});
    expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.prepareRestore).toHaveBeenCalledOnce();expect(t.service.applyRestore).not.toHaveBeenCalled();
  });
  it('rejects a snapshot for a different local document',async()=>{
    const t=await setup();t.service.prepareRestore.mockResolvedValue({...restorePreview,view:{...restorePreview.view,localPath:'/vault/other.xml'}});t.plugin.openRestore(t.file as any);
    await screen.findByText('快照与当前文档不一致，请重新预览。');expect(screen.queryByRole('button',{name:'确认恢复'})).toBeNull();expect(t.service.applyRestore).not.toHaveBeenCalled();
  });
  it('requires another preview after expiry and after a backend revision conflict',async()=>{
    const t=await setup();t.service.prepareRestore.mockResolvedValue({...restorePreview,view:{...restorePreview.view,expiresAt:new Date(Date.now()-1000).toISOString()}});t.plugin.openRestore(t.file as any);
    fireEvent.click(await screen.findByRole('button',{name:'确认恢复'}));await screen.findByText('快照预览已过期，请重新预览。');expect(t.service.applyRestore).not.toHaveBeenCalled();
    t.service.prepareRestore.mockResolvedValue(restorePreview);fireEvent.click(screen.getByRole('button',{name:'重新预览快照'}));
    t.service.applyRestore.mockRejectedValue(new Error('当前正文已变化，请重新预览快照。'));fireEvent.click(await screen.findByRole('button',{name:'确认恢复'}));await screen.findByText('当前正文已变化，请重新预览快照。');
    expect(screen.queryByRole('button',{name:'确认恢复'})).toBeNull();expect(t.service.applyRestore).toHaveBeenCalledOnce();
  });
  it('does not restore when the window closes while awaiting the editor lease',async()=>{
    const t=await setup();t.plugin.openRestore(t.file as any);const confirm=await screen.findByRole('button',{name:'确认恢复'});let grant:any;
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(new Promise(resolve=>grant=resolve));});
    fireEvent.click(confirm);await waitFor(()=>expect(grant).toBeTypeOf('function'));modals[0].close();grant({release:t.release});await waitFor(()=>expect(t.release).toHaveBeenCalledTimes(2));expect(t.service.applyRestore).not.toHaveBeenCalled();
  });
  it('releases the editor without rendering an actionable preview after plugin unload',async()=>{
    const t=await setup();let finish:any;t.service.prepareRestore.mockImplementation(()=>new Promise(resolve=>finish=resolve));t.plugin.openRestore(t.file as any);await waitFor(()=>expect(finish).toBeTypeOf('function'));
    t.plugin.onunload();finish(restorePreview);await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(modals).toHaveLength(0);expect(t.service.applyRestore).not.toHaveBeenCalled();
  });
});
