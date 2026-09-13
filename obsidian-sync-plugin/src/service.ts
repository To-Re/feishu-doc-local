import {mkdir,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import type {CLIProfile} from './runner';
import {validateProfile} from './runner';
import {createContentCLI,type ContentCLIRunner,type ContentTransport} from '../../src/server/content-cli';
import {createCloudCLI} from '../../src/server/cloud-cli';
import {openLocalFile,FileError} from '../../src/server/files';
import {openProjectStore,validateProjectRegistrations,type ProjectStore} from '../../src/server/projects';
import {createReviewProject} from '../../src/server/project-create';
import {bindReviewProject} from '../../src/server/project-bind';
import {prepareContent,applyContent,withReviewLock,type PreparedContent} from '../../src/server/content-sync';
import {syncCloudComments} from '../../src/server/cloud-sync';
import type {CreateProjectInput,ProjectCloud,ReviewProject,SyncDirection} from '../../src/core/projects';
import {prepareCloudImport,importCloudDocument,type ImportPlan,type PreparedImport} from './import';
export type {PreparedImport,ImportResult} from './import';
export interface ExistingBinding {revision:string;documentId:string;url?:string;pending:boolean;error?:string;}
export interface LocalProjectEntry {project:ReviewProject;vaultPath?:string;unavailable?:string;}
export interface SyncServiceOptions {vaultRoot:string;catalogPath:string;profile:CLIProfile;runner:ContentCLIRunner;}
/** Direct filesystem / CLI orchestration; no listener, auto-login or background cloud traffic. */
export class SyncService {
  private store?:ProjectStore;private stopped=false;private running=false;
  private imports=new WeakMap<PreparedImport,ImportPlan>();
  constructor(private readonly options:SyncServiceOptions){}
  dispose(){this.stopped=true;}
  private assertActive(){if(this.stopped)throw new Error('飞书同步扩展已卸载。');}
  private async catalog(){this.assertActive();
    if(!isAbsolute(this.options.catalogPath)||!this.options.catalogPath.endsWith('.json'))throw new Error('项目配置文件需要绝对 JSON 路径。');
    if(!this.store){await mkdir(dirname(this.options.catalogPath),{recursive:true,mode:0o700});this.store=await openProjectStore(this.options.catalogPath);}return this.store;
  }
  private content():ContentTransport{return createContentCLI(validateProfile(this.options.profile),this.options.runner);}
  private async document(path:string,readOnly=false){this.assertActive();const root=await realpath(this.options.vaultRoot),candidate=await realpath(path),part=relative(root,candidate);
    if(!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part)||!candidate.toLowerCase().endsWith('.xml'))throw new Error('只能同步当前 Obsidian 仓库中的 XML 文档。');return openLocalFile(candidate,{readOnly});
  }
  private async guarded<T>(run:()=>Promise<T>):Promise<T>{this.assertActive();if(this.running)throw new Error('此扩展已有同步任务，请等待完成。');this.running=true;try{return await run();}finally{this.running=false;}}
  async prepareImport(input:{url:string;path:string}):Promise<PreparedImport>{return this.guarded(async()=>{
    const plan=await prepareCloudImport(this.options.vaultRoot,input,await this.catalog(),this.content(),()=>this.assertActive());
    this.imports.set(plan.view,plan);return plan.view;
  });}
  async importDocument(prepared:PreparedImport){return this.guarded(async()=>{
    const plan=this.imports.get(prepared);if(!plan)throw new FileError('导入预览无效或已使用，请重新预览。');
    this.imports.delete(prepared);
    return importCloudDocument(plan,await this.catalog(),this.content(),()=>this.assertActive());
  });}
  async project(path:string):Promise<ReviewProject|undefined>{const file=await this.document(path,true);return (await(await this.catalog()).list()).find(p=>p.localPath===file.path);}
  async existingBinding(path:string):Promise<ExistingBinding|undefined>{
    const file=await this.document(path,true),snapshot=await file.read(),content=snapshot.review?.contentSync,comments=snapshot.review?.cloudSync;
    if(!content&&!comments)return;
    return {revision:snapshot.revision,documentId:content?.documentId??comments!.documentId,...(comments?.url?{url:comments.url}:{}),pending:!!(content?.pending||comments?.pending),
      ...(content&&comments&&content.documentId!==comments.documentId?{error:'正文与评论记录关联了不同的飞书文档，请先核对原项目配置，不能自动恢复。'}:{})};
  }
  async restoreBinding(path:string,input:{revision:string;url?:string;defaultDirection:SyncDirection}):Promise<ReviewProject>{return this.guarded(async()=>{
    const file=await this.document(path,true);
    return withReviewLock(file,async()=>{
      const saved=await this.existingBinding(file.path);if(!saved)throw new Error('没有找到已有飞书同步记录，请重新读取。');
      if(saved.error)throw new Error(saved.error);if(saved.revision!==input.revision)throw new Error('正文或同步记录已变化，请重新读取关联后再恢复。');
      const url=input.url?.trim()||saved.url;if(!url)throw new Error('历史记录没有保存飞书地址，请粘贴同一文档 ID 的 Docx 链接，或切换到原项目配置。');
      // A wiki URL cannot be resolved offline. Only trust the exact previously
      // persisted wiki mapping; user-supplied links must carry the known Docx ID.
      if(/\/wiki\//.test(url)&&url!==saved.url)throw new Error('无法离线核对新的 Wiki 链接，请使用同一文档 ID 的 Docx 链接。');
      const cloud:ProjectCloud={documentId:saved.documentId,url};
      validateProjectRegistrations([{id:'restore-check',name:file.name,localPath:file.path,defaultDirection:input.defaultDirection,cloud,createdAt:new Date().toISOString()}]);
      const store=await this.catalog(),existing=(await store.list()).find(project=>project.localPath===file.path);
      if(existing?.cloud){if(existing.cloud.documentId!==saved.documentId)throw new Error('当前项目已绑定另一份飞书文档，未改变关联。');return existing;}
      if((await file.read()).revision!==saved.revision)throw new Error('正文或同步记录已变化，未恢复关联。');
      return existing?store.update(existing.id,{cloud,defaultDirection:input.defaultDirection,expectUnbound:true}):store.register({name:file.name.replace(/\.xml$/i,''),localPath:file.path,defaultDirection:input.defaultDirection,cloud});
    });
  });}
  private async projectEntry(project:ReviewProject):Promise<LocalProjectEntry>{
    const part=relative(resolve(this.options.vaultRoot),project.localPath);
    if(!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part))return {project,unavailable:'不在当前 Obsidian 仓库内，请到对应仓库打开。'};
    try{
      const file=await this.document(project.localPath,true);
      if(file.path!==project.localPath)throw new Error('项目路径已改变，请先核对文档关联。');
      return {project,vaultPath:part.split(sep).join('/')};
    }catch{return {project,unavailable:'文件不存在、路径已变化或不是可读取的 XML，请先核对本地文件。'};}
  }
  async listProjects():Promise<LocalProjectEntry[]>{
    const projects=await (await this.catalog()).list();return Promise.all(projects.map(project=>this.projectEntry(project)));
  }
  async openProject(id:string):Promise<{project:ReviewProject;vaultPath:string}>{
    const project=await (await this.catalog()).get(id);if(!project)throw new Error('项目不存在，请刷新列表。');
    const entry=await this.projectEntry(project);if(!entry.vaultPath)throw new Error(entry.unavailable);return {project,vaultPath:entry.vaultPath};
  }
  async updateProject(id:string,patch:{name:string;defaultDirection:SyncDirection}):Promise<ReviewProject>{return this.guarded(async()=>{
    await this.openProject(id);return (await this.catalog()).update(id,{name:patch.name,defaultDirection:patch.defaultDirection});
  });}
  async bind(path:string,cloud:CreateProjectInput['cloud'],direction:SyncDirection){return this.guarded(async()=>{
    const file=await this.document(path),store=await this.catalog(),project=(await store.list()).find(p=>p.localPath===file.path),historyRoot=resolve(dirname(file.path),'.review-sync-history');
    if(!project)return createReviewProject({name:file.name.replace(/\.xml$/i,''),local:{kind:'existing',path:file.path},cloud,defaultDirection:direction},store,cloud.kind==='none'?undefined:this.content(),historyRoot,{adoptPublished:true,directoryPrefix:'feishu-assets-'});
    if(project.cloud){if(cloud.kind==='none')return {project};throw new Error('这篇稿件已经关联飞书，不能直接换绑。');}
    if(cloud.kind==='none')return {project:await store.update(project.id,{defaultDirection:direction})};
    const current=await file.read();return bindReviewProject({revision:current.revision,cloud,defaultDirection:direction},project,file,store,this.content(),historyRoot,{adoptPublished:true,directoryPrefix:'feishu-assets-'});
  });}
  async preview(path:string,direction:SyncDirection){return this.guarded(async()=>{const file=await this.document(path),project=await this.project(file.path);if(!project?.cloud)throw new Error('请先关联飞书文档。');const snapshot=await file.read();return prepareContent(file,project,snapshot.revision,direction,this.content());});}
  async apply(path:string,prepared:PreparedContent){return this.guarded(async()=>{const file=await this.document(path),project=await this.project(file.path);if(!project?.cloud||project.id!==prepared.view.projectId)throw new FileError('关联已变化，请重新预览。','CLOUD_BINDING');return applyContent(file,project,prepared,this.content(),resolve(dirname(file.path),'.review-sync-history'),{directoryPrefix:'feishu-assets-',adoptPublished:true});});}
  async comments(path:string){return this.guarded(async()=>{const file=await this.document(path),project=await this.project(file.path);if(!project?.cloud)throw new Error('请先关联飞书文档，并预览确认本地已采用对应的块 ID。');const snapshot=await file.read(),profile=validateProfile(this.options.profile);
    const transport=createCloudCLI({...profile,...project.cloud},async(command,args)=>{const result=await this.options.runner(command,args);if(typeof result==='string')return result;if(result.exitCode!==0)throw new Error('评论 CLI 未确认成功。');return result.stdout;});
    return syncCloudComments(file,snapshot.revision,{localPath:file.path,...project.cloud,transport});
  });}
}
