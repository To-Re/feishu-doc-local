import {lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import {dirname,basename,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import type {CreateProjectInput,ReviewProject,SyncDirection} from '../core/projects';
import {createReview,type Snapshot} from '../core/types';
import {exchangeXML,contentNodes} from '../core/content-xml';
import {validateUnchangedLocalComments} from '../core/content-identity';
import {FileError,openLocalFile} from './files';
import type {ProjectStore} from './projects';
import {ContentCLIError,type ContentDocument,type ContentTransport} from './content-cli';
import {cacheContentResources,localAssetHashes} from './content-resources';
import {remapContentComments,saveContentEvidence,withReviewLock,type ContentApplyOptions} from './content-sync';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const label=(v:unknown)=>typeof v==='string'&&!!v.trim()&&v.trim().length<=200&&!/[\u0000-\u001f\u007f]/.test(v);
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function validate(input:unknown):asserts input is CreateProjectInput {
  if(!record(input)||!keys(input,['name','local','cloud','defaultDirection'])||!label(input.name)||!['pull','push'].includes(input.defaultDirection as string)||
    !record(input.local)||!keys(input.local,['kind','path'])||!['existing','new'].includes(input.local.kind as string)||
    typeof input.local.path!=='string'||!isAbsolute(input.local.path)||!/\.xml$/i.test(input.local.path)||input.local.path.includes('\0')||
    !record(input.cloud)||!['none','existing','new'].includes(input.cloud.kind as string))throw new FileError('项目创建参数不正确。','INVALID_REQUEST',400);
  const c=input.cloud;
  if(c.kind==='none'&&!keys(c,['kind'])||c.kind==='existing'&&(!keys(c,['kind','url'])||typeof c.url!=='string'||!c.url.trim())||
    c.kind==='new'&&(!keys(c,['kind','title','parentToken'])||!label(c.title)||c.parentToken!==undefined&&(typeof c.parentToken!=='string'||!/^[-\w]{1,512}$/.test(c.parentToken))))
    throw new FileError('飞书来源参数不正确。','INVALID_REQUEST',400);
}
async function absent(path:string){try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw new FileError('目标正文或相邻评论文件已存在，请选择已有文件，或使用新文件名。','ALREADY_EXISTS');}
export async function createReviewProject(input:unknown,store:ProjectStore,transport:ContentTransport|undefined,historyRoot:string,options:ContentApplyOptions={}):Promise<{project:ReviewProject;warning?:string}> {
  if(record(input)&&record(input.local)&&typeof input.local.path==='string'&&input.local.path.startsWith('~/'))
    input={...input,local:{...input.local,path:resolve(homedir(),input.local.path.slice(2))}};
  validate(input);
  if(input.cloud.kind!=='none'&&!transport)throw new FileError('请先为本地服务配置飞书 CLI。','CLOUD_UNAVAILABLE',400);
  const folder=await realpath(dirname(input.local.path));
  let path=resolve(folder,basename(input.local.path));
  if(input.local.kind==='new'){await absent(path);await absent(path.replace(/\.xml$/i,'.review.json'));}
  else path=(await openLocalFile(path,{readOnly:true})).path;
  const entries=await store.list();
  if(entries.some(p=>p.localPath===path))throw new FileError('这份本地稿件已属于一个项目，请直接切换到该项目。','DUPLICATE_PROJECT');
  let remote:ContentDocument|undefined;
  if(input.cloud.kind==='existing'){
    remote=await transport!.fetch(input.cloud.url);
    if(entries.some(p=>p.cloud?.documentId===remote!.documentId))throw new FileError('这份飞书文档已关联其他项目，请直接切换，避免两份本地稿件互相覆盖。','DUPLICATE_PROJECT');
  }
  const initialXML=remote?.xml||`<title>${escape(input.cloud.kind==='new'?input.cloud.title.trim():input.name.trim())}</title>\n<p></p>\n`;
  if(input.local.kind==='new'){
    // Exclusive creation: the UI never replaces a file merely by choosing its name.
    await writeFile(path,initialXML,{flag:'wx',mode:0o600});
  }
  const file=await openLocalFile(path,{readOnly:true}),snapshot=await file.read();
  if(snapshot.review?.cloudSync?.pending||snapshot.review?.contentSync?.pending)throw new FileError('稿件含未确认的同步，请先核对相邻记录，不能重复创建。','SYNC_PENDING');
  if(snapshot.review?.contentSync&&(!remote||snapshot.review.contentSync.documentId!==remote.documentId))throw new FileError('稿件已有其他飞书正文绑定，请先核对原项目。','CLOUD_BINDING');
  if(snapshot.review?.cloudSync&&input.cloud.kind!=='none'&&(!remote||snapshot.review.cloudSync.documentId!==remote.documentId))throw new FileError('稿件的评论关联了另一份飞书文档，请先核对原项目。','CLOUD_BINDING');
  if(input.cloud.kind==='new'){
    await localAssetHashes(snapshot.xml,path);
    exchangeXML(snapshot.xml);
  }
  // Register first: if a subsequent cloud create has an uncertain outcome, reopening this
  // project reveals its durable intent instead of offering the same create again.
  let project=await store.register({name:input.name.trim(),localPath:path,defaultDirection:input.defaultDirection,...(remote?{cloud:{documentId:remote.documentId,url:remote.url}}:{})});
  if(input.cloud.kind==='none')return {project};
  if(input.local.kind==='existing'&&input.cloud.kind==='existing')return {project};
  const cloud=input.cloud;
  const writable=await openLocalFile(path);
  return withReviewLock(writable,async()=>{
    let local=await writable.read();
    if(local.revision!==snapshot.revision||local.review?.contentSync?.pending||local.review?.cloudSync?.pending)
      return {project,warning:'项目已登记，但稿件在创建期间有新修改或未完成同步；保留当前文件，未发起新的云端操作。请先核对相邻记录。'};
    return initializeProjectCloud({cloud,project,local,writable,store,transport:transport!,historyRoot,remote,options});
  });
}


type LocalFile=Awaited<ReturnType<typeof openLocalFile>>;
/** Caller holds the review lock. Persist intent before creating remotely so uncertain results cannot be retried blindly. */
export async function initializeProjectCloud({cloud,project,local,writable,store,transport,historyRoot,remote,defaultDirection,operation='project.create',options={}}:{
  cloud:Exclude<CreateProjectInput['cloud'],{kind:'none'}>;project:ReviewProject;local:Snapshot;writable:LocalFile;store:ProjectStore;
  transport:ContentTransport;historyRoot:string;remote?:ContentDocument;defaultDirection?:SyncDirection;operation?:'project.create'|'project.bind';options?:ContentApplyOptions;
}):Promise<{project:ReviewProject;warning?:string}>{
  const path=writable.path;
  const evidence=await saveContentEvidence(historyRoot,local,remote,path);
  const warnings:string[]=[];
  let sentAssets:Record<string,string>|undefined;
  try{
    if(cloud.kind==='new'){
      sentAssets=await localAssetHashes(local.xml,path);
      const review=structuredClone(local.review||createReview(writable.name,local.xml));
      review.comments=review.document.xml===local.xml?validateUnchangedLocalComments(local.xml,review.comments):
        remapContentComments(review.document.xml,local.xml,review.comments);
      review.document.xml=local.xml;
      review.contentSync={version:1,documentId:'',localXML:local.xml,cloudXML:'',cloudRevision:0,syncedAt:new Date().toISOString(),
        pending:{id:randomUUID(),direction:'create',sourceXML:local.xml,startedAt:new Date().toISOString()}};
      local=await writable.save(local.xml,review,local.revision);
      const contentPath=resolve(dirname(path),'.review-create-'+randomUUID()+'.xml');
      const content=contentNodes(exchangeXML(local.xml)).filter(n=>n.tag!=='title').map(n=>n.raw).join('');
      await writeFile(contentPath,content,{flag:'wx',mode:0o600});
      let created;
      try{created=await transport.create({title:cloud.title,contentPath,...(cloud.parentToken?{parentToken:cloud.parentToken}:{})});}
      finally{await unlink(contentPath);}
      await writeFile(resolve(evidence,'created.json'),JSON.stringify(created,null,2),{flag:'wx',mode:0o600});
      warnings.push(...created.warnings);
      // Save the received identity before any following read/index mutation can fail.
      review.contentSync.documentId=created.documentId;
      local=await writable.save(local.xml,review,local.revision);
      project=await store.update(project.id,{cloud:{documentId:created.documentId,url:created.url},expectUnbound:true,...(defaultDirection?{defaultDirection}:{})});
      remote=await transport.fetch(created.documentId);
      if(remote.documentId!==created.documentId)throw new FileError('新文档回读身份不一致。','CLOUD_BINDING');
    }
    // Archive both representations before the caller's selected adoption policy.
    await writeFile(resolve(evidence,'cloud-after.json'),JSON.stringify(remote,null,2),{flag:'wx',mode:0o600});
    await writeFile(resolve(evidence,'cloud.xml'),remote!.xml,{flag:'wx',mode:0o600});
    contentNodes(remote!.xml);
    if(sentAssets&&JSON.stringify(await localAssetHashes(local.xml,path))!==JSON.stringify(sentAssets))throw new FileError('创建期间本地素材已变化，未确认最终稿。','CONFLICT');
    const adopting=cloud.kind==='existing'||options.adoptPublished===true;
    const xml=adopting?remote!.xml:local.xml;
    const resources=adopting?await cacheContentResources(path,xml,local.review?.resources,transport,options):undefined;
    if(resources)warnings.push(...resources.warnings);
    if(cloud.kind==='new'&&adopting){
      const confirmed=await transport.fetch(remote!.documentId);
      if(confirmed.documentId!==remote!.documentId||confirmed.revision!==remote!.revision||confirmed.xml!==remote!.xml)
        throw new FileError('回读期间飞书正文已变化，未覆盖本地。','CONFLICT');
    }
    const review=structuredClone(local.review||createReview(writable.name,local.xml));
    if(!adopting){
      review.comments=validateUnchangedLocalComments(xml,review.comments);
    }else review.comments=remapContentComments(review.document.xml,xml,review.comments);
    if(adopting){
      const attached=new Set(local.review?.comments.filter(comment=>comment.anchor.state==='attached').map(comment=>comment.id)||[]);
      const uncertain=review.comments.filter(comment=>attached.has(comment.id)&&comment.anchor.state==='unverified').length;
      if(uncertain)warnings.push(`${uncertain} 条本地评论已保留，但采用回读后无法可靠确认引用位置，请核对后再同步这些评论。`);
    }
    review.document.xml=xml;review.document.updatedAt=new Date().toISOString();
    if(resources)review.resources=resources.resources;
    const localAssets=await localAssetHashes(xml,path);
    if(sentAssets&&JSON.stringify(await localAssetHashes(local.xml,path))!==JSON.stringify(sentAssets))throw new FileError('创建后的本地素材与发出版本不同。','CONFLICT');
    review.contentSync={version:1,documentId:remote!.documentId,localXML:xml,cloudXML:remote!.xml,cloudRevision:remote!.revision,syncedAt:new Date().toISOString(),localAssets};
    review.operations.push({id:randomUUID(),type:operation,author:'我',at:new Date().toISOString(),summary:(cloud.kind==='new'?adopting?'创建飞书文档并采用回读，旧稿已存档':'创建飞书文档，保留本地原稿与回读':'从飞书建立本地稿件')+`；双方备份：${evidence}`});
    await writable.save(xml,review,local.revision);
    if(cloud.kind==='new'&&!adopting&&local.xml!==remote!.xml)
      warnings.push(`飞书回读与本地原稿有差异，原稿未覆盖。双方备份保存在 ${evidence}；请预览核对，再决定是否采用回读。`);
    return {project,...(warnings.length?{warning:warnings.join(' ')}:{})};
  }catch(error){
    await writeFile(resolve(evidence,'error.json'),JSON.stringify({message:error instanceof Error?error.message:'创建后续步骤未确认',code:error instanceof FileError?error.code:undefined},null,2),{flag:'wx',mode:0o600});
    if(error instanceof ContentCLIError&&error.receipt)await writeFile(resolve(evidence,'cli-error.json'),JSON.stringify(error.receipt,null,2),{flag:'wx',mode:0o600});
    // No retry here: a failed create can already have produced a cloud document.
    return {project,warning:cloud.kind==='new'?'本地项目已保留，但新建飞书文档的后续步骤未确认完成。请查看相邻 .review.json 和同步快照，核对后再恢复，勿重复新建。':
      '项目和飞书正文已保留，资源或同步基线尚未写完。请先查看文件，再重新预览拉取。'};
  }
}
