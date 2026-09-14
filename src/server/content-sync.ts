import {randomUUID} from 'node:crypto';
import {mkdir,open,unlink,lstat,writeFile,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createReview,type Snapshot,type ReviewComment} from '../core/types';
import type {ContentPreview,ReviewProject,SyncDirection,ContentSyncResult} from '../core/projects';
import {comparableXML,contentNodes,exchangeXML,planContentWrites} from '../core/content-xml';
import {indexCloudBlocks} from '../core/cloud-blocks';
import {validateUnchangedLocalComments} from '../core/content-identity';
import {localAssetHashes,cacheContentResources,hasCloudWhiteboards,type ContentResourceOptions} from './content-resources';
import {ContentCLIError,type ContentDocument,type ContentTransport} from './content-cli';
import {FileError,type openLocalFile} from './files';

type LocalFile=Awaited<ReturnType<typeof openLocalFile>>;
export interface PreparedContent {view:ContentPreview;revision:string;remote:ContentDocument;assets:Record<string,string>;}
/** The caller explicitly chooses whether a successful publication also updates the local document. */
export interface ContentApplyOptions extends ContentResourceOptions {adoptPublished?:boolean;}
const now=()=>new Date().toISOString();
const sameAssets=(current:Record<string,string>,previous:Record<string,string>={})=>Object.keys(current).length===Object.keys(previous).length&&Object.keys(current).every(path=>Object.hasOwn(previous,path)&&current[path]===previous[path]);
function syncPlan(localXML:string,cloudXML:string,assetsChanged:boolean):ReturnType<typeof planContentWrites>{
  const plan=planContentWrites(localXML,cloudXML);
  if(assetsChanged&&!plan.writes.length)return {writes:[{command:'overwrite',xml:exchangeXML(localXML)}],warnings:[
    '本地素材已变化或尚无素材基线，但 XML 结构相同；本次需要重新发布完整正文以更新素材，原块 ID 可能改变，评论位置会标记待确认。']};
  return plan;
}
export async function withReviewLock<T>(file:LocalFile,run:()=>Promise<T>):Promise<T>{
  const path=file.reviewPath+'.sync.lock';let lock;
  try{lock=await open(path,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new FileError('此稿件正在同步，或上次同步未正常结束。请先核对记录。','CLOUD_BUSY');throw error;}
  const info=await lock.stat();
  try{return await run();}finally{await lock.close();try{const current=await lstat(path);if(current.ino===info.ino&&current.dev===info.dev)await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
export async function saveContentEvidence(root:string,snapshot:Snapshot,remote?:ContentDocument):Promise<string>{
  await mkdir(root,{recursive:true,mode:0o700});
  const folder=resolve(await realpath(root),randomUUID());await mkdir(folder,{mode:0o700});
  await writeFile(resolve(folder,'local.xml'),snapshot.xml,{flag:'wx',mode:0o600});
  await writeFile(resolve(folder,'local.review.json'),JSON.stringify(snapshot.review,null,2),{flag:'wx',mode:0o600});
  if(remote)await writeFile(resolve(folder,'cloud.json'),JSON.stringify(remote,null,2),{flag:'wx',mode:0o600});
  return folder;
}
function checkLocal(snapshot:Snapshot,revision:string,project:ReviewProject){
  if(snapshot.revision!==revision)throw new FileError('稿件已变化，请保存后重新预览。','CONFLICT');
  if(snapshot.review?.cloudSync?.pending||snapshot.review?.contentSync?.pending)throw new FileError('上次同步结果尚未确认，请先核对同步记录，当前不会重发。','SYNC_PENDING');
  if(snapshot.review?.contentSync&&project.cloud&&snapshot.review.contentSync.documentId!==project.cloud.documentId)throw new FileError('正文同步记录关联了其他文档。','CLOUD_BINDING');
  if(snapshot.review?.cloudSync&&project.cloud&&snapshot.review.cloudSync.documentId!==project.cloud.documentId)throw new FileError('评论同步记录关联了其他文档。','CLOUD_BINDING');
}
export async function prepareContent(file:LocalFile,project:ReviewProject,revision:string,direction:SyncDirection,transport:ContentTransport):Promise<PreparedContent>{
  if(!project.cloud||file.path!==project.localPath)throw new FileError('项目尚未绑定这份飞书稿件。','CLOUD_BINDING',403);
  const local=await file.read();checkLocal(local,revision,project);
  const remote=await transport.fetch(project.cloud.documentId);
  if(remote.documentId!==project.cloud.documentId)throw new FileError('飞书回读与项目目标不一致。','CLOUD_BINDING');
  const sourceSame=comparableXML(local.xml)===comparableXML(remote.xml),baseline=local.review?.contentSync;
  const assets=direction==='push'?await localAssetHashes(local.xml,file.path):{};
  const assetsChanged=direction==='push'&&!sameAssets(assets,baseline?.localAssets);
  const localChanged=!baseline||local.xml!==baseline.localXML,cloudChanged=!baseline||comparableXML(remote.xml)!==comparableXML(baseline.cloudXML);
  const contentEqual=sourceSame||!!baseline&&!localChanged&&!cloudChanged;
  // A publication records both representations but never replaces the local draft.
  // Offer adoption as a separate, explicit decision instead of republishing it.
  // Changed local asset bytes still require publication, even if XML is unchanged.
  const refreshLocal=direction==='push'&&contentEqual&&local.xml!==remote.xml&&!assetsChanged;
  const refreshBoards=(direction==='pull'||refreshLocal)&&hasCloudWhiteboards(remote.xml);
  const adoptIdentity=local.xml!==remote.xml&&(sourceSame||direction==='pull');
  const reviewChanged=!!local.review&&local.review.document.xml!==local.xml;
  const equal=contentEqual&&!!baseline&&!refreshLocal&&!refreshBoards&&!adoptIdentity&&!reviewChanged&&!assetsChanged;
  const conflict=!contentEqual&&(direction==='push'?cloudChanged:localChanged);
  const warnings=direction==='push'&&!refreshLocal?syncPlan(local.xml,remote.xml,assetsChanged).warnings:[];
  if(!baseline&&!sourceSame)warnings.unshift('两端尚无共同同步基线；请确认首次同步采用哪一端的内容。');
  else if(conflict)warnings.unshift('目标端也有改动。确认后将采用所选来源，覆盖目标当前正文；两端快照会保留。');
  if(refreshBoards)warnings.push('更新本地时会刷新白板预览，原组件评论位置需重新确认。');
  if((await file.read()).revision!==revision)throw new FileError('读取预览期间本地已变化，请重新预览。','CONFLICT');
  return {revision,remote,assets,view:{id:randomUUID(),projectId:project.id,direction,...(refreshLocal?{action:'refresh-local' as const}:{}),status:equal?'equal':conflict?'conflict':'ready',localXML:local.xml,cloudXML:remote.xml,warnings,
    summary:equal?'两端没有待同步的内容。':refreshLocal?'飞书已包含此前发布的内容；仅将飞书回读正文和资源更新到本地，不改动飞书。':direction==='push'?'将本地正文发布到关联的飞书文档。':'将飞书正文及资源读取到本地文件。',expiresAt:new Date(Date.now()+300_000).toISOString()}};
}

/** Preserve offsets only inside an unchanged block with the same document identity. */
export function remapContentComments(before:string,after:string,comments:ReviewComment[]):ReviewComment[]{
  const oldBlocks=indexCloudBlocks(before),newBlocks=indexCloudBlocks(after);
  const signatures=(xml:string)=>{
    const result=new Map<string,string|undefined>();
    const walk=(nodes:ReturnType<typeof contentNodes>)=>{for(const n of nodes){if(n.attrs.id)result.set(n.attrs.id,result.has(n.attrs.id)?undefined:comparableXML(n.raw));if(n.tag!=='whiteboard')walk(n.children.filter(c=>typeof c!=='string') as ReturnType<typeof contentNodes>);}};walk(contentNodes(xml));return result;
  };
  const old=signatures(before),next=signatures(after);
  return comments.map(comment=>{
    const a=comment.anchor;if(a.state!=='attached')return comment;
    const block=oldBlocks.filter(b=>b.from<=a.from&&b.to>=a.to&&(!a.target||b.tag==='whiteboard')).sort((x,y)=>(x.to-x.from)-(y.to-y.from))[0];
    const candidates=block?newBlocks.filter(b=>b.id===block.id&&b.tag===block.tag):[];
    if(!block||oldBlocks.filter(b=>b.id===block.id).length!==1||candidates.length!==1||old.get(block.id)===undefined||old.get(block.id)!==next.get(block.id)||
      block.boardToken!==candidates[0].boardToken||(a.target&&a.target.board!==block.boardIdentity))
      return {...comment,anchor:{...a,state:'unverified'}};
    const delta=candidates[0].from-block.from;
    return {...comment,anchor:{...a,from:a.from+delta,to:a.to+delta}};
  });
}

export async function applyContent(file:LocalFile,project:ReviewProject,prepared:PreparedContent,transport:ContentTransport,historyRoot:string,options:ContentApplyOptions={}):Promise<ContentSyncResult>{
  return withReviewLock(file,async()=>{
    const {view}=prepared;
    if(view.projectId!==project.id||project.localPath!==file.path||!project.cloud||project.cloud.documentId!==prepared.remote.documentId)throw new FileError('项目绑定已变化，请重新预览。','CLOUD_BINDING');
    if(Date.now()>Date.parse(view.expiresAt))throw new FileError('预览已过期，请重新预览。','CONFLICT');
    let local=await file.read();checkLocal(local,prepared.revision,project);
    let remote=await transport.fetch(project.cloud.documentId);
    if(remote.documentId!==prepared.remote.documentId||remote.revision!==prepared.remote.revision||remote.xml!==prepared.remote.xml)
      throw new FileError('飞书内容在预览后已变化，请重新预览，当前未覆盖。','CONFLICT');
    if(view.direction==='push'&&!sameAssets(await localAssetHashes(local.xml,file.path),prepared.assets))throw new FileError('本地素材在预览后已变化，请重新预览。','CONFLICT');
    if(view.status==='equal')return {snapshot:local,project,summary:'两端没有待同步的内容。',warnings:[]};
    const evidence=await saveContentEvidence(historyRoot,local,remote),warnings=[...view.warnings];
    const originalXML=local.xml;
    const publishing=view.direction==='push'&&view.action!=='refresh-local';
    const adoptingPublished=publishing&&options.adoptPublished===true;
    const adopting=!publishing||adoptingPublished;
    const originallyAttached=new Set(local.review?.comments.filter(comment=>comment.anchor.state==='attached').map(comment=>comment.id)||[]);
    if(publishing){
      const writes=syncPlan(local.xml,remote.xml,!sameAssets(prepared.assets,local.review?.contentSync?.localAssets)).writes;
      const review=structuredClone(local.review||createReview(file.name,local.xml));
      review.comments=review.document.xml===local.xml?validateUnchangedLocalComments(local.xml,review.comments):remapContentComments(review.document.xml,local.xml,review.comments);
      review.document.xml=local.xml;review.document.updatedAt=now();
      review.contentSync||={version:1,documentId:project.cloud.documentId,localXML:local.xml,cloudXML:remote.xml,cloudRevision:remote.revision,syncedAt:now()};
      review.contentSync.pending={id:view.id,direction:'push',startedAt:now(),sourceXML:local.xml,cloudRevision:remote.revision};
      local=await file.save(local.xml,review,local.revision);
      try{
        for(let i=0;i<writes.length;i++){
          const fresh=await transport.fetch(project.cloud.documentId);
          if(fresh.documentId!==project.cloud.documentId||fresh.revision!==remote.revision||fresh.xml!==remote.xml)throw new Error('云端在分步发布中发生变化。');
          if((await file.read()).revision!==local.revision)throw new Error('本地在分步发布中发生变化。');
          const step=writes[i],contentPath=resolve(dirname(file.path),'.review-publish-'+randomUUID()+'.xml');
          await writeFile(contentPath,step.xml,{flag:'wx',mode:0o600});
          let referenceMapPath:string|undefined;
          try{
            if(remote.referenceMap&&Object.keys(remote.referenceMap as object).length){referenceMapPath=resolve(dirname(file.path),'.review-references-'+randomUUID()+'.json');await writeFile(referenceMapPath,JSON.stringify(remote.referenceMap),{flag:'wx',mode:0o600});}
            if(!sameAssets(await localAssetHashes(local.xml,file.path),prepared.assets))throw new Error('本地素材在分步发布中发生变化。');
            await transport.update({documentId:project.cloud.documentId,revision:remote.revision,command:step.command,contentPath,blockId:step.blockId,referenceMapPath});
          }finally{await unlink(contentPath);if(referenceMapPath)await unlink(referenceMapPath);}
          remote=await transport.fetch(project.cloud.documentId);
          if(remote.documentId!==project.cloud.documentId)throw new Error('回读文档身份不一致。');
          await writeFile(resolve(evidence,`step-${i+1}.json`),JSON.stringify(remote,null,2),{flag:'wx',mode:0o600});
          // A successful update receipt is insufficient if the readback is malformed.
          contentNodes(remote.xml);
        }
      }catch(error){
        if(error instanceof ContentCLIError&&error.receipt)await writeFile(resolve(evidence,'cli-error.json'),JSON.stringify(error.receipt,null,2),{flag:'wx',mode:0o600});
        throw new FileError('发布未能完整确认，已保留正文、快照及待定记录；请先核对飞书结果，勿重复发送。','SYNC_PENDING',502);
      }
    }
    await writeFile(resolve(evidence,'cloud-after.json'),JSON.stringify(remote,null,2),{flag:'wx',mode:0o600});
    await writeFile(resolve(evidence,'cloud.xml'),remote.xml,{flag:'wx',mode:0o600});
    if(publishing&&!adoptingPublished&&originalXML!==remote.xml)
      warnings.push(`飞书回读与本地原稿有差异，原稿未覆盖。双方备份保存在 ${evidence}；请预览核对，再决定是否采用回读。`);
    let resources=local.review?.resources;
    if(adopting){
      try{
        const cached=await cacheContentResources(file.path,remote.xml,resources,transport,options);resources=cached.resources;warnings.push(...cached.warnings);
        if(adoptingPublished){
          const confirmed=await transport.fetch(project.cloud.documentId);
          if(confirmed.documentId!==remote.documentId||confirmed.revision!==remote.revision||confirmed.xml!==remote.xml)
            throw new Error('回读资源期间云端正文又发生变化。');
        }
      }catch(error){
        if(adoptingPublished)throw new FileError('飞书已更新，本地更新未完成；原稿和备份已保留。请先核对结果，勿重复推送。','SYNC_PENDING',502);
        throw error;
      }
    }
    const fresh=await file.read();
    if(fresh.revision!==local.revision)throw new FileError(publishing?'正文已发布，但本地又有新修改，未覆盖。请核对待定记录。':'下载期间本地有新修改，未覆盖，请重新预览。','CONFLICT');
    const xml=adopting?remote.xml:originalXML,review=structuredClone(fresh.review||createReview(file.name,xml));
    let localAssets:Record<string,string>;
    try{
      localAssets=await localAssetHashes(xml,file.path);
      if(view.direction==='push'&&!sameAssets(xml===originalXML?localAssets:await localAssetHashes(originalXML,file.path),prepared.assets))
        throw new Error('发布后的素材与发出快照不同。');
    }catch(error){
      if(publishing)throw new FileError('正文已发布，但本地素材已变化或无法确认；已保留待定记录，未将新素材记为已发布。','SYNC_PENDING',502);
      if(view.action==='refresh-local')throw new FileError('本地素材在回读期间已变化，未覆盖，请重新预览。','CONFLICT');
      throw error;
    }
    const previousXML=review.document.xml,blocks=indexCloudBlocks(previousXML);
    if(!adopting){
      // Cloud IDs do not change the identity of the still-unchanged local draft.
      review.comments=validateUnchangedLocalComments(xml,review.comments);
    }else{
      review.comments=review.comments.map(comment=>{
        if(comment.anchor.state!=='attached')return comment;
        const affected=!!comment.anchor.target&&blocks.some(block=>block.tag==='whiteboard'&&
            /^[A-Za-z0-9_-]{1,512}$/.test(block.boardToken||'')&&block.boardIdentity===comment.anchor.target!.board);
        return affected?{...comment,anchor:{...comment.anchor,state:'unverified'}}:comment;
      });
      review.comments=remapContentComments(previousXML,xml,review.comments);
    }
    if(adopting){
      const uncertain=review.comments.filter(comment=>originallyAttached.has(comment.id)&&comment.anchor.state==='unverified').length;
      if(uncertain)warnings.push(`${uncertain} 条本地评论已保留，但采用回读后无法可靠确认引用位置，请核对后再同步这些评论。`);
    }
    review.document.xml=xml;review.document.updatedAt=now();
    if(resources)review.resources=resources;
    review.contentSync={version:1,documentId:remote.documentId,localXML:xml,cloudXML:remote.xml,cloudRevision:remote.revision,syncedAt:now(),localAssets};
    review.operations.push({id:view.id,type:publishing?'content.push':'content.pull',author:'我',at:now(),summary:(adoptingPublished?'发布并采用飞书正文与资源，旧稿已存档':publishing?'发布本地正文，保留原稿与飞书回读':view.action==='refresh-local'?'确认采用飞书回读与资源':'从飞书拉取正文与资源')+`；双方备份：${evidence}`});
    const snapshot=await file.save(xml,review,fresh.revision);
    return {snapshot,project,summary:adoptingPublished?'已推送并更新本地正文与资源，旧稿已存档，本地评论已保留。':!publishing?'已按确认更新本地正文与资源，保留本地评论；飞书未改动。':'已发布，保留本地原稿与飞书回读备份。可再次预览差异，决定是否采用回读。',warnings};
  });
}
