import type {BindProjectInput,ReviewProject} from '../core/projects';
import type {Snapshot} from '../core/types';
import {exchangeXML} from '../core/content-xml';
import {FileError,type openLocalFile} from './files';
import type {ProjectStore} from './projects';
import type {ContentTransport} from './content-cli';
import {localAssetHashes} from './content-resources';
import {withReviewLock,type ContentApplyOptions} from './content-sync';
import {initializeProjectCloud} from './project-create';

type LocalFile=Awaited<ReturnType<typeof openLocalFile>>;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
function validate(input:unknown):asserts input is BindProjectInput {
  if(!record(input)||!keys(input,['revision','cloud','defaultDirection'])||typeof input.revision!=='string'||!input.revision||
    !['pull','push'].includes(input.defaultDirection as string)||!record(input.cloud))
    throw new FileError('关联参数不正确。','INVALID_REQUEST',400);
  const c=input.cloud;
  if(c.kind==='existing'){
    if(keys(c,['kind','url'])&&typeof c.url==='string'&&c.url.trim())return;
  }else if(c.kind==='new'){
    if(keys(c,['kind','title','parentToken'])&&typeof c.title==='string'&&c.title.trim()&&c.title.trim().length<=200&&
      !/[\u0000-\u001f\u007f]/.test(c.title)&&(c.parentToken===undefined||typeof c.parentToken==='string'&&/^[-\w]{1,512}$/.test(c.parentToken)))return;
  }
  throw new FileError('飞书关联参数不正确。','INVALID_REQUEST',400);
}
function checkSnapshot(snapshot:Snapshot,revision:string,documentId?:string){
  if(snapshot.revision!==revision)throw new FileError('稿件已变化，请先保存并重新关联。','CONFLICT');
  if(snapshot.review?.contentSync?.pending||snapshot.review?.cloudSync?.pending)
    throw new FileError('上次同步结果尚未确认，请先核对相邻记录，不能重复新建或关联。','SYNC_PENDING');
  for(const bound of [snapshot.review?.contentSync,snapshot.review?.cloudSync])
    if(bound&&(!documentId||bound.documentId!==documentId))throw new FileError('稿件相邻记录已关联其他飞书文档，请核对原项目。','CLOUD_BINDING');
}

/** Attach cloud metadata to the existing project; linking an existing document never adopts either body. */
export async function bindReviewProject(input:unknown,project:ReviewProject,file:LocalFile,store:ProjectStore,
  transport:ContentTransport|undefined,historyRoot:string,options:ContentApplyOptions={}):Promise<{project:ReviewProject;warning?:string}>{
  validate(input);
  if(!transport)throw new FileError('请先为本地服务配置飞书 CLI。','CLOUD_UNAVAILABLE',400);
  if(file.path!==project.localPath)throw new FileError('项目与当前稿件不一致。','CLOUD_BINDING');
  return withReviewLock(file,async()=>{
    const fresh=await store.get(project.id);
    if(!fresh||fresh.localPath!==file.path)throw new FileError('项目登记已变化，请重新读取项目。','PROJECT_CONFLICT');
    if(fresh.cloud)throw new FileError('这个项目已经关联飞书文档，不能重复关联或换绑。','CLOUD_BINDING');
    const snapshot=await file.read();
    // Check revision and pending state before even fetching the proposed endpoint.
    if(snapshot.revision!==input.revision)throw new FileError('稿件已变化，请先保存并重新关联。','CONFLICT');
    if(snapshot.review?.contentSync?.pending||snapshot.review?.cloudSync?.pending)
      throw new FileError('上次同步结果尚未确认，请先核对相邻记录。','SYNC_PENDING');
    if(input.cloud.kind==='existing'){
      const remote=await transport.fetch(input.cloud.url);
      checkSnapshot(snapshot,input.revision,remote.documentId);
      checkSnapshot(await file.read(),input.revision,remote.documentId);
      const linked=await store.update(project.id,{cloud:{documentId:remote.documentId,url:remote.url},
        defaultDirection:input.defaultDirection,expectUnbound:true});
      return {project:linked};
    }
    checkSnapshot(snapshot,input.revision);
    await localAssetHashes(snapshot.xml,file.path);exchangeXML(snapshot.xml);
    checkSnapshot(await file.read(),input.revision);
    return initializeProjectCloud({cloud:input.cloud,project:fresh,local:snapshot,writable:file,store,transport,historyRoot,
      defaultDirection:input.defaultDirection,operation:'project.bind',options});
  });
}
