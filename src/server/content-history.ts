import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import type {ContentRestorePreview,ContentRestoreResult} from '../core/projects';
import {createReview,type Review,type Snapshot} from '../core/types';
import {localResourcePath} from '../core/project-files';
import {parseDocxXML} from '../core/docxml';
import {FileError,validateReview,type openLocalFile} from './files';
import {saveContentEvidence,withReviewLock,remapContentComments} from './content-sync';
import {snapshotResourceHashes} from './content-resources';

/** Kept by the trusted host between preview and explicit confirmation. */
export interface PreparedContentRestore {
  view:ContentRestorePreview;
  revision:string;
  archiveHash:string;
  resourceHashes:Record<string,string|null>;
}

type LocalFile=Awaited<ReturnType<typeof openLocalFile>>;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const now=()=>new Date().toISOString();
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sameHashes=(a:Record<string,string|null>,b:Record<string,string|null>)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(path=>Object.hasOwn(b,path)&&a[path]===b[path]);
const assertSettled=(snapshot:Pick<Snapshot,'review'>)=>{
  if(snapshot.review?.contentSync?.pending||snapshot.review?.cloudSync?.pending)
    throw new FileError('还有未确认的飞书操作，请先核对同步记录，再恢复本地快照。','SYNC_PENDING');
};

/** Read only a bounded, ordinary file under the already-verified snapshot directory. */
async function readArchiveText(folder:string,name:string,limit:number,optional=false):Promise<string|null>{
  if(await realpath(folder)!==folder)throw new FileError('快照目录已变化，未读取。','HISTORY_PATH');
  const path=resolve(folder,name);let handle;
  try{
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1||before.size>limit)throw new FileError('快照文件类型或大小不支持。','HISTORY_INVALID');
    const chunks:Buffer[]=[];let total=0;
    for(;;){const bytes=Buffer.allocUnsafe(Math.min(65_536,limit-total+1));const read=await handle.read(bytes,0,bytes.length,null);if(!read.bytesRead)break;total+=read.bytesRead;if(total>limit)throw new FileError('快照文件过大。','HISTORY_INVALID');chunks.push(bytes.subarray(0,read.bytesRead));}
    const after=await handle.stat(),current=await lstat(path);
    if(current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||await realpath(folder)!==folder)
      throw new FileError('快照文件在读取期间已变化，请重新预览。','CONFLICT');
    try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,total));}
    catch{throw new FileError('快照文件不是有效 UTF-8。','HISTORY_INVALID');}
  }catch(error){
    if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return null;
    if((error as NodeJS.ErrnoException).code==='ELOOP')throw new FileError('快照文件不能是软链接。','HISTORY_PATH');
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new FileError('快照文件已缺失，当前稿件未改动。','HISTORY_NOT_FOUND',404);
    throw error;
  }finally{await handle?.close();}
}

/** A shared history directory is never searched by time; the current document must name the snapshot. */
function lastEvidence(snapshot:Snapshot,historyRoot:string,additionalHistoryRoots:readonly string[]):{path:string;root:string;createdAt:string}{
  const roots=new Set([historyRoot,...additionalHistoryRoots].map(root=>resolve(root))),allowed=new Set(['content.pull','content.push','content.restore','project.create','project.bind']);
  for(const operation of [...(snapshot.review?.operations||[])].reverse()){
    if(!allowed.has(operation.type))continue;
    const marker='；双方备份：',index=operation.summary.lastIndexOf(marker);if(index<0)continue;
    const path=operation.summary.slice(index+marker.length);
    if(resolve(path)!==path||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(basename(path)))
      throw new FileError('当前稿件记录中的快照路径不受支持，未读取其他目录。','HISTORY_PATH');
    if(!roots.has(dirname(path)))throw new FileError('上一快照位于其他项目管理目录，请切回生成快照时的项目配置后再恢复。','HISTORY_PATH');
    return {path,root:dirname(path),createdAt:operation.at};
  }
  throw new FileError('这份文档还没有可恢复的同步快照。','HISTORY_NOT_FOUND',404);
}

async function readArchive(file:LocalFile,current:Snapshot,historyRoot:string,additionalHistoryRoots:readonly string[]){
  const evidence=lastEvidence(current,historyRoot,additionalHistoryRoots),root=evidence.root;
  try{
    for(const directory of [root,evidence.path]){
      const info=await lstat(directory);
      if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw new FileError('快照必须位于原历史目录，不能使用软链接。','HISTORY_PATH');
    }
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new FileError('这份文档的上一快照已不存在。','HISTORY_NOT_FOUND',404);throw error;}
  const xml=(await readArchiveText(evidence.path,'local.xml',5_000_000))!;
  const rawReview=(await readArchiveText(evidence.path,'local.review.json',25_000_000))!;
  const rawManifest=await readArchiveText(evidence.path,'manifest.json',2_000_000,true);
  let review:Review|null,manifest:Record<string,unknown>|null=null;
  try{
    parseDocxXML(xml);
    const value:unknown=JSON.parse(rawReview);review=value===null?null:validateReview(value,file.name);
    if(rawManifest!==null){
      const value:unknown=JSON.parse(rawManifest);
      if(!record(value)||value.version!==1||value.documentPath!==file.path||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||value.xmlHash!==digest(xml)||value.reviewHash!==digest(rawReview)||!record(value.resourceHashes)||
        Object.entries(value.resourceHashes).some(([path,hash])=>localResourcePath(path)!==path||hash!==null&&(typeof hash!=='string'||!/^[a-f\d]{64}$/.test(hash))))throw new Error('invalid manifest');
      manifest=value;
    }
  }catch{throw new FileError('快照内容损坏、校验不符或不属于当前文档，当前稿件未改动。','HISTORY_INVALID');}
  if(review&&Object.hasOwn(review,'pendingWrite'))throw new FileError('快照包含未完成的本地保存，不能直接恢复。','HISTORY_INVALID');
  assertSettled({review});
  const resourceHashes=await snapshotResourceHashes(file.path,{xml,review});
  if(Object.values(resourceHashes).some(hash=>hash===null))throw new FileError('旧稿引用的本地资源已缺失，请先找回这些资源，再恢复快照。','HISTORY_RESOURCE');
  if(manifest&&!sameHashes(resourceHashes,manifest.resourceHashes as Record<string,string|null>))throw new FileError('旧稿引用的资源与快照时不同，未恢复。请先找回原资源。','HISTORY_RESOURCE');
  return {...evidence,createdAt:manifest?.createdAt as string||evidence.createdAt,xml,review,resourceHashes,legacy:manifest===null,hash:digest(JSON.stringify([xml,rawReview,rawManifest]))};
}

/** Do not roll back acknowledged cloud identities or turn an old status/reply into a new cloud mutation. */
function restoredReview(file:LocalFile,current:Snapshot,archived:{xml:string;review:Review|null}):Review{
  const old=archived.review?.cloudSync,latest=current.review?.cloudSync;
  if(old?.links.some(link=>{
    const known=latest?.documentId===old.documentId?latest.links.find(item=>item.localId===link.localId&&item.cloudId===link.cloudId):undefined;
    return !known||Object.entries(link.replies).some(([id,reply])=>known.replies[id]?.cloudId!==reply.cloudId);
  }))throw new FileError('当前记录缺少快照中已发送评论的身份，无法安全恢复；请先核对评论同步记录。','HISTORY_SYNC_STATE');
  const review=structuredClone(archived.review||createReview(file.name,archived.xml));
  if(review.document.xml!==archived.xml)review.comments=remapContentComments(review.document.xml,archived.xml,review.comments);
  review.document.xml=archived.xml;review.document.updatedAt=now();
  review.comments=review.comments.map(comment=>{
    const linked=latest?.links.find(link=>link.localId===comment.id);
    return {...comment,...(linked?{status:current.review?.comments.find(item=>item.id===comment.id)?.status||linked.status}:{}),
      anchor:comment.anchor.state==='attached'?{...comment.anchor,state:'unverified'}:comment.anchor};
  });
  // Keep the latest cloud baselines/receipts even when the restored draft predates the first publication.
  if(current.review?.cloudSync)review.cloudSync=structuredClone(current.review.cloudSync);else delete review.cloudSync;
  if(current.review?.contentSync)review.contentSync=structuredClone(current.review.contentSync);else delete review.contentSync;
  review.operations=structuredClone(current.review?.operations||[]);
  return review;
}

export async function prepareContentRestore(file:LocalFile,revision:string,historyRoot:string,additionalHistoryRoots:readonly string[]=[]):Promise<PreparedContentRestore>{
  const current=await file.read();if(current.revision!==revision)throw new FileError('稿件已变化，请重新预览恢复。','CONFLICT');assertSettled(current);
  const archived=await readArchive(file,current,historyRoot,additionalHistoryRoots),restored=restoredReview(file,current,archived);
  if((await file.read()).revision!==revision)throw new FileError('读取快照期间稿件已变化，请重新预览。','CONFLICT');
  const warnings:string[]=[],uncertain=restored.comments.filter(comment=>comment.anchor.state==='unverified').length;
  if(JSON.stringify(current.review?.comments||[])!==JSON.stringify(restored.comments))
    warnings.push(`评论：当前 ${current.review?.comments.length||0} 条 → 快照 ${restored.comments.length} 条；当前评论会随恢复前的版本存档。`+
      (uncertain?` ${uncertain} 条评论引用需重新确认。`:'')+(current.review?.cloudSync?.links.length?' 已发送评论沿用当前身份和状态。':''));
  if(archived.legacy)warnings.push('这是早期快照，未记录资源的历史校验值；旧图片和附件须仍保留在原位置，请在恢复前核对。');
  return {view:{id:randomUUID(),localPath:file.path,snapshotPath:archived.path,createdAt:archived.createdAt,localXML:current.xml,snapshotXML:archived.xml,warnings,expiresAt:new Date(Date.now()+300_000).toISOString()},
    revision,archiveHash:archived.hash,resourceHashes:archived.resourceHashes};
}

export async function applyContentRestore(file:LocalFile,prepared:PreparedContentRestore,historyRoot:string,additionalHistoryRoots:readonly string[]=[]):Promise<ContentRestoreResult>{
  return withReviewLock(file,async()=>{
    if(prepared.view.localPath!==file.path)throw new FileError('恢复预览不属于当前文档。','HISTORY_PATH');
    if(!Number.isFinite(Date.parse(prepared.view.expiresAt))||Date.now()>Date.parse(prepared.view.expiresAt))throw new FileError('恢复预览已过期，请重新预览。','CONFLICT');
    const current=await file.read();if(current.revision!==prepared.revision)throw new FileError('正文或评论在预览后已变化，未恢复。','CONFLICT');assertSettled(current);
    const archived=await readArchive(file,current,historyRoot,additionalHistoryRoots);
    if(archived.path!==prepared.view.snapshotPath||archived.hash!==prepared.archiveHash||!sameHashes(archived.resourceHashes,prepared.resourceHashes))throw new FileError('快照或旧资源在预览后已变化，请重新预览。','CONFLICT');
    const review=restoredReview(file,current,archived);
    const backup=await saveContentEvidence(historyRoot,current,undefined,file.path);
    // Snapshotting the current version can take time; check the target resources again immediately before the CAS save.
    if(!sameHashes(await snapshotResourceHashes(file.path,archived),prepared.resourceHashes))throw new FileError('旧资源在恢复期间已变化，当前稿件未覆盖。','CONFLICT');
    review.operations.push({id:prepared.view.id,type:'content.restore',author:'我',at:now(),summary:`恢复本地快照；来源：${archived.path}；双方备份：${backup}`});
    const snapshot=await file.save(archived.xml,review,current.revision);
    return {snapshot,summary:'已恢复上一份本地快照；恢复前的版本已存档，飞书未改动。',warnings:prepared.view.warnings};
  });
}
