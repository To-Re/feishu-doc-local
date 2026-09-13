// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {fireEvent,screen,waitFor,within} from '@testing-library/react';
import FeishuSyncPlugin from '../src/main';
import {FileSystemAdapter,modals,prepareDOM,TFile} from './obsidian-mock';
import type {SyncService} from '../src/service';
const bound={id:'project',name:'本地稿件',localPath:'/vault/article.xml',defaultDirection:'push',createdAt:new Date().toISOString(),cloud:{documentId:'Doc',url:'https://example.feishu.cn/docx/Doc'}};
const preview={view:{id:'preview',projectId:'project',direction:'push',status:'ready',localXML:'<p>本地新稿</p>',cloudXML:'<p>云端旧稿</p>',warnings:[],summary:'准备发布',expiresAt:new Date(Date.now()+100000).toISOString()},revision:'revision',remote:{},assets:{}};
beforeEach(()=>{prepareDOM();});afterEach(()=>{for(const modal of [...modals])modal.close();document.body.replaceChildren();vi.restoreAllMocks();});
async function setup(project:unknown=bound,bridge=true){
  const release=vi.fn(async()=>{}),file=new TFile(),events=new Map<string,Function>(),vaultEvents=new Map<string,Function>(),files=new Map<string,TFile>([[file.path,file]]);const app:any={vault:{adapter:new FileSystemAdapter(),getFiles:()=>[...files.values()],getFileByPath:(path:string)=>files.get(path)??null,on:vi.fn((name,callback)=>{vaultEvents.set(name,callback);return{name};}),offref:vi.fn(ref=>vaultEvents.delete(ref.name))},workspace:{getActiveFile:()=>file,on:vi.fn((name,callback)=>{events.set(name,callback);return{};}),trigger:vi.fn((name,request)=>{if(name==='feishu-doc-local:acquire-sync'&&bridge)request.acquire(Promise.resolve({release}));else if(name==='feishu-doc-local:open-local'&&bridge)request.accept(Promise.resolve());else events.get(name)?.(request);})}};
  const plugin=new FeishuSyncPlugin(app,{id:'feishu-doc-local-sync',name:'同步',version:'0.1.0',author:'test',minAppVersion:'1.5.7'} as any);
  const service={existingBinding:vi.fn(async()=>undefined as any),restoreBinding:vi.fn(async()=>bound),listProjects:vi.fn(async()=>[{project:bound,vaultPath:'article.xml'}]),openProject:vi.fn(async()=>({project:bound,vaultPath:'article.xml'})),updateProject:vi.fn(async()=>bound),project:vi.fn(async()=>project),bind:vi.fn(async()=>({project:bound})),preview:vi.fn(async()=>preview),apply:vi.fn(async()=>({project:bound,summary:'发布完成，原稿保留',warnings:[]})),prepareImport:vi.fn(async()=>({xml:'<p>云端导入正文</p>',documentId:'Doc',title:'导入文档',vaultPath:'导入.xml',path:'/vault/导入.xml',url:'https://example.feishu.cn/docx/Doc',expiresAt:new Date(Date.now()+60000).toISOString(),warnings:[]})),importDocument:vi.fn(async()=>({project:bound,vaultPath:'导入.xml',warnings:[]})),comments:vi.fn(async()=>({report:{imported:1,created:1,replies:0,resolved:0,issues:[]}})),dispose:vi.fn()};
  vi.spyOn(plugin,'backend').mockReturnValue(service as unknown as SyncService);await plugin.onload();return {plugin,service,app,release,file,addFile:(path:string)=>{const created=new TFile();created.path=path;files.set(path,created);vaultEvents.get('create')?.(created);return created;},mount:()=>{const container=document.body.appendChild(document.createElement('div'));let dispose=()=>{};app.workspace.trigger('feishu-doc-local:mount-toolbar',{path:file.path,container,accept:(value:()=>void)=>dispose=value});return{container,dispose:()=>dispose()};},open:()=>{(plugin as any).commands[0].callback();}};
}
describe('Obsidian extension window interactions',()=>{
  it('does not call a cloud action on load or while merely opening the window',async()=>{const t=await setup();expect(t.service.project).not.toHaveBeenCalled();t.open();await screen.findByText('打开关联的飞书文档');expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();});
  it('keeps optional preview read-only until its top action is confirmed',async()=>{const t=await setup();t.open();fireEvent.click(await screen.findByRole('button',{name:'预览差异'}));await screen.findByText('准备发布');expect(t.service.apply).not.toHaveBeenCalled();expect(screen.getByRole('region',{name:'可滚动的正文差异'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'确认推送'}));await screen.findByText('发布完成，原稿保留');expect(t.service.apply).toHaveBeenCalledOnce();expect(t.release).toHaveBeenCalledTimes(2);});
  it('does not send comments when the separate confirmation is cancelled',async()=>{const t=await setup();t.open();fireEvent.click(await screen.findByRole('button',{name:'同步评论、回复与处理状态'}));expect(t.service.comments).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(t.service.comments).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'同步评论、回复与处理状态'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));await screen.findByText(/评论同步完成/);expect(t.service.comments).toHaveBeenCalledOnce();});
  it('creates only after a second confirmation, retaining entered fields on failure',async()=>{const t=await setup(undefined);t.service.project.mockResolvedValue(undefined as any);t.open();fireEvent.click(await screen.findByRole('button',{name:'新建飞书文档'}));fireEvent.input(screen.getByLabelText('新飞书文档标题'),{target:{value:'用户输入标题'}});fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));expect(t.service.bind).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect((screen.getByLabelText('新飞书文档标题') as HTMLInputElement).value).toBe('用户输入标题');t.service.bind.mockRejectedValue(new Error('网络失败'));fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));fireEvent.click(screen.getByRole('button',{name:'确认'}));await screen.findByText('网络失败');expect((screen.getByLabelText('新飞书文档标题') as HTMLInputElement).value).toBe('用户输入标题');});
  it('refuses all cloud calls when the base plugin is unavailable',async()=>{const t=await setup(bound,false);t.open();fireEvent.click(await screen.findByRole('button',{name:'预览差异'}));await screen.findByText(/请先安装并启用/);expect(t.service.preview).not.toHaveBeenCalled();});
  it('disables action controls during a pending operation and closes safely at unload',async()=>{const t=await setup();let finish:any;t.service.preview.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));t.open();fireEvent.click(await screen.findByRole('button',{name:'预览差异'}));await waitFor(()=>expect(t.service.preview).toHaveBeenCalled());expect((screen.getByRole('button',{name:'同步评论、回复与处理状态'}) as HTMLButtonElement).disabled).toBe(true);t.plugin.onunload();expect(modals).toHaveLength(0);finish(preview);await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.apply).not.toHaveBeenCalled();});
});

it('does not start a delayed cloud action after its window closes while waiting for editor save',async()=>{
  const t=await setup(bound,false);let grant:any;t.app.workspace.trigger.mockImplementation((_name:string,request:any)=>request.acquire(new Promise(resolve=>{grant=resolve;})));
  t.open();fireEvent.click(await screen.findByRole('button',{name:'预览差异'}));await waitFor(()=>expect(grant).toBeTypeOf('function'));modals[0].close();grant({release:t.release});await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.preview).not.toHaveBeenCalled();
});
it('cannot change CLI configuration while a preview is open and does not replace settings when persistence fails',async()=>{
  const t=await setup();t.open();await screen.findByRole('button',{name:'预览差异'});const next={command:'/configured/other-cli',args:[],catalogPath:'/configured/projects.json'};
  await expect(t.plugin.updateSettings(next)).rejects.toThrow('关闭同步窗口');modals[0].close();const original=t.plugin.settings;vi.spyOn(t.plugin,'saveData').mockRejectedValueOnce(new Error('disk failed'));
  await expect(t.plugin.updateSettings(next)).rejects.toThrow('disk failed');expect(t.plugin.settings).toBe(original);await t.plugin.updateSettings(next);expect(t.plugin.settings).toEqual(next);
});


it('opens visible host sync and project actions without cloud calls',async()=>{
  const t=await setup();const request={action:'sync',path:'article.xml',handled:false};t.app.workspace.trigger('feishu-doc-local:open-action',request);
  expect(request.handled).toBe(true);await screen.findByRole('button',{name:'预览差异'});modals[0].close();
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


it('uses the saved pull direction for optional preview after navigating project management',async()=>{
  const t=await setup({...bound,defaultDirection:'pull'});
  t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction:'pull',summary:'从飞书拉取'}});
  t.open();await screen.findByRole('button',{name:'拉取'});expect(t.service.preview).not.toHaveBeenCalled();
  modals[0].close();t.plugin.openProjects();await screen.findByRole('button',{name:'打开项目'});
  fireEvent.click(screen.getByRole('button',{name:'关联与同步'}));await screen.findByRole('heading',{name:'关联设置'});
  fireEvent.click(screen.getByRole('button',{name:'预览差异'}));await screen.findByText('从飞书拉取');
  expect(t.service.preview).toHaveBeenCalledWith('/vault/article.xml','pull');expect(t.service.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'确认更新本地'}));await waitFor(()=>expect(t.service.apply).toHaveBeenCalledOnce());expect(t.release).toHaveBeenCalledTimes(2);
});
it('changes optional preview direction without applying either body',async()=>{
  const t=await setup();t.plugin.openPreview(t.file as any,'push');await screen.findByText('准备发布');
  t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction:'pull',summary:'拉取差异'}});
  fireEvent.click(screen.getByRole('button',{name:'拉取差异'}));await screen.findByText('拉取差异',{selector:'p'});
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(t.service.preview).toHaveBeenLastCalledWith('/vault/article.xml','pull');expect(t.service.apply).not.toHaveBeenCalled();
});
it('offers readback adoption separately from push and never confirms it implicitly',async()=>{
  const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,action:'refresh-local',summary:'发布已完成，选择是否采用回读'}} as any);
  t.open();fireEvent.click(await screen.findByRole('button',{name:'预览差异'}));await screen.findByText('发布已完成，选择是否采用回读');
  expect(screen.queryByRole('button',{name:'确认推送'})).toBeNull();expect(t.service.apply).not.toHaveBeenCalled();
  modals[0].close();expect(t.service.apply).not.toHaveBeenCalled();
});
it('binds an existing document without publishing and immediately exposes both sync directions and comments',async()=>{
  const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.open();
  fireEvent.input(await screen.findByLabelText('飞书文档地址'),{target:{value:'https://example.feishu.cn/docx/Doc'}});
  fireEvent.click(screen.getByRole('button',{name:'确认项目关联'}));await screen.findByRole('button',{name:'同步评论、回复与处理状态'});
  expect(screen.getByRole('button',{name:'拉取'})).toBeTruthy();expect(screen.getByRole('button',{name:'推送'})).toBeTruthy();
  expect(t.service.bind).toHaveBeenCalledWith('/vault/article.xml',{kind:'existing',url:'https://example.feishu.cn/docx/Doc'},'push');
  expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();
});


it('shows historical binding recovery instead of new cloud creation when the catalog is missing',async()=>{
  const t=await setup();t.service.project.mockResolvedValue(undefined as any);t.service.existingBinding.mockResolvedValue({revision:'existing',documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',pending:false});
  t.open();await screen.findByText('发现已有飞书同步记录');expect(screen.queryByRole('button',{name:'新建飞书文档'})).toBeNull();
  expect(t.service.restoreBinding).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'恢复已有飞书关联到项目列表'}));await screen.findByRole('button',{name:'同步评论、回复与处理状态'});
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

it('routes orphaned historical documents from project management into recovery instead of local registration',async()=>{
  const t=await setup();t.service.listProjects.mockResolvedValue([]);t.service.project.mockResolvedValue(undefined as any);t.service.existingBinding.mockResolvedValue({revision:'old',documentId:'Doc',url:'https://example.feishu.cn/docx/Doc',pending:false});
  t.plugin.openProjects(new TFile() as any);fireEvent.click(await screen.findByRole('button',{name:'恢复当前文档的飞书关联'}));
  await screen.findByText('发现已有飞书同步记录');expect(screen.queryByRole('button',{name:'将当前文档加入项目'})).toBeNull();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.restoreBinding).not.toHaveBeenCalled();
});


describe('inline editor sync toolbar',()=>{
  it('mounts direct controls using local association reads only and disposes them',async()=>{
    const t=await setup();expect(t.app.workspace.trigger).toHaveBeenCalledWith('feishu-doc-local:extension-changed');const mounted=t.mount();
    await within(mounted.container).findByRole('button',{name:'预览差异'});
    for(const name of ['从飞书导入','拉取','推送','同步评论','关联设置'])expect(within(mounted.container).getByRole('button',{name})).toBeTruthy();
    expect(within(mounted.container).getByRole('link',{name:'打开飞书'}).getAttribute('href')).toBe(bound.cloud.url);
    for(const name of ['新建','切换文档','项目管理','飞书同步'])expect(within(mounted.container).queryByRole('button',{name})).toBeNull();
    expect(t.service.project).toHaveBeenCalledWith('/vault/article.xml');
    expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.comments).not.toHaveBeenCalled();expect(t.service.bind).not.toHaveBeenCalled();expect(t.service.prepareImport).not.toHaveBeenCalled();
    mounted.dispose();expect(mounted.container.children).toHaveLength(0);t.plugin.onunload();
  });
  it.each(['pull','push'] as const)('executes %s from one top-level click inside the editor lease',async direction=>{
    const t=await setup();t.service.preview.mockResolvedValue({...preview,view:{...preview.view,direction,summary:'已准备'}});const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:direction==='push'?'推送':'拉取'}));
    await within(mounted.container).findByText('发布完成，原稿保留');expect(t.service.preview).toHaveBeenCalledWith('/vault/article.xml',direction);
    expect(t.service.apply).toHaveBeenCalledWith('/vault/article.xml',expect.objectContaining({view:expect.objectContaining({direction})}));
    expect(t.release).toHaveBeenCalledOnce();expect(modals).toHaveLength(0);t.plugin.onunload();
  });
  it('keeps optional preview separate and places its action before the diff',async()=>{
    const t=await setup();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'预览差异'}));
    await screen.findByRole('region',{name:'可滚动的正文差异'});expect(t.service.apply).not.toHaveBeenCalled();
    const action=screen.getByRole('button',{name:'确认推送'}),diff=screen.getByRole('region',{name:'可滚动的正文差异'});
    expect(action.compareDocumentPosition(diff)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(action.closest('.feishu-sync-sticky-actions')).toBeTruthy();
    t.plugin.onunload();
  });
  it('opens conflict review without applying or retrying a write',async()=>{
    const t=await setup();let released=false;t.release.mockImplementation(async()=>{released=true;});
    t.service.preview.mockImplementation(async()=>{if(t.service.preview.mock.calls.length>1)expect(released).toBe(true);return {...preview,view:{...preview.view,status:'conflict',summary:'两端有修改'}};});const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'推送'}));await screen.findByRole('heading',{name:'正文差异预览'});
    await screen.findByRole('button',{name:'确认推送'});expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('does not prepare or publish when the editor rejects an unsent draft',async()=>{
    const t=await setup();const mounted=t.mount();await within(mounted.container).findByRole('button',{name:'推送'});
    t.app.workspace.trigger.mockImplementation((name:string,request:any)=>{if(name==='feishu-doc-local:acquire-sync')request.acquire(Promise.reject(new Error('请先处理未发送评论草稿')));});
    fireEvent.click(within(mounted.container).getByRole('button',{name:'推送'}));await within(mounted.container).findByText('请先处理未发送评论草稿');
    expect(t.service.preview).not.toHaveBeenCalled();expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('stops direct publication if the view closes while preparing',async()=>{
    const t=await setup();let finish:any;t.service.preview.mockImplementation(()=>new Promise(resolve=>finish=resolve));const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'推送'}));await waitFor(()=>expect(t.service.preview).toHaveBeenCalledOnce());
    mounted.dispose();finish(preview);await waitFor(()=>expect(t.release).toHaveBeenCalledOnce());expect(t.service.apply).not.toHaveBeenCalled();t.plugin.onunload();
  });
  it('disables direct actions and does not retry an uncertain result',async()=>{
    const t=await setup();let finish:any;t.service.apply.mockImplementation(()=>new Promise((_resolve,reject)=>finish=reject));const mounted=t.mount();
    fireEvent.click(await within(mounted.container).findByRole('button',{name:'推送'}));await waitFor(()=>expect(t.service.apply).toHaveBeenCalledOnce());
    expect((within(mounted.container).getByRole('button',{name:'拉取'}) as HTMLButtonElement).disabled).toBe(true);
    finish(new Error('上次同步未确认，请先核对飞书'));await within(mounted.container).findByText('上次同步未确认，请先核对飞书');
    expect(t.service.apply).toHaveBeenCalledOnce();expect(t.release).toHaveBeenCalledOnce();t.plugin.onunload();
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
    const t=await setup();const mounted=t.mount();fireEvent.click(await within(mounted.container).findByRole('button',{name:'从飞书导入'}));
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
