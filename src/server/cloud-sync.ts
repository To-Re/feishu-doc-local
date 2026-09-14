import { open, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReview, type Review, type Snapshot, type ReviewComment } from '../core/types';
import type { CloudComment, CloudIntent, CloudLink, CloudSyncReport, CloudTransport } from '../core/cloud-types';
import { indexCloudBlocks, cloudCommentAnchor, localCloudBlock, normalizeImportedCloudAnchors } from '../core/cloud-blocks';
import { invalidateAnchors } from '../core/anchors';
import { FileError, type openLocalFile } from './files';

type LocalFile=Awaited<ReturnType<typeof openLocalFile>>;
export interface CloudConnection {localPath:string;documentId:string;url:string;transport:CloudTransport;}
const clone=<T>(value:T):T=>structuredClone(value);
const now=()=>new Date().toISOString();

/** Only a user-triggered sync reaches this function. The lock spans the remote writes. */
export async function syncCloudComments(file:LocalFile,expectedRevision:string,connection:CloudConnection):Promise<{snapshot:Snapshot;report:CloudSyncReport}> {
  if(file.path!==connection.localPath)throw new FileError('这份本地稿件没有关联当前飞书文档。','CLOUD_BINDING',403);
  const lockPath=file.reviewPath+'.sync.lock';
  let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch(error){
    if((error as NodeJS.ErrnoException).code==='EEXIST')throw new FileError('此稿件正在同步，或上次同步未正常结束。请先核对同步记录。','CLOUD_BUSY',409);
    throw error;
  }
  const lockInfo=await lock.stat();
  try{return await runSync(file,expectedRevision,connection);}
  finally{
    await lock.close();
    try{const current=await lstat(lockPath);if(current.ino===lockInfo.ino&&current.dev===lockInfo.dev)await unlink(lockPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}

async function runSync(file:LocalFile,expectedRevision:string,{documentId,url,transport}:CloudConnection) {
  let snapshot=await file.read();
  if(snapshot.revision!==expectedRevision)throw new FileError('本地稿件或评论已变化，请读取新版本后再同步。','CONFLICT',409);
  let review=clone(snapshot.review||createReview(file.name,snapshot.xml));
  if(review.document.xml!==snapshot.xml)throw new FileError('正文已在外部修改，请先在页面读取新版本并确认评论位置。','CONFLICT',409);
  if(review.cloudSync&&review.cloudSync.documentId!==documentId)throw new FileError('评论记录关联了另一份飞书文档，未发送任何内容。','CLOUD_BINDING',409);
  if(review.contentSync?.pending)throw new FileError('正文同步尚未确认，请先核对记录再同步评论。','SYNC_PENDING',409);
  review.cloudSync||={version:1,documentId,url,links:[]};
  const report:CloudSyncReport={imported:0,created:0,replies:0,resolved:0,issues:[],syncedAt:now()};
  const issue=(message:string)=>{if(!report.issues.includes(message))report.issues.push(message);};
  const validBody=(body:string)=>{
    if(body.trim()&&[...body].length<=10000)return true;
    issue('有评论或回复为空或超过飞书的 10000 字符限制，已保留本地内容，未发送。');return false;
  };
  if(review.cloudSync.pending){issue('上次评论发送结果尚未确认；请先核对飞书与旁置 JSON 中的 pending 记录，当前不会重复发送。');return {snapshot,report};}
  let remote;
  try{remote=await transport.read();}catch{throw new FileError('飞书文档或评论未完整读到；未发送任何本地意见，请检查 CLI 配置、权限和网络。','CLOUD_READ',502);}
  if(remote.documentId!==documentId)throw new FileError('飞书回读文档与关联目标不一致。','CLOUD_BINDING',409);
  // Wiki and Docx links can address the same resolved document. Its verified
  // document ID is the binding identity; the URL is only a navigation link.
  review.cloudSync.url=url;
  const localBlocks=indexCloudBlocks(snapshot.xml),remoteBlocks=indexCloudBlocks(remote.xml);
  if(!localBlocks.some(block=>block.tag==='title'&&block.id===documentId)||!remoteBlocks.some(block=>block.tag==='title'&&block.id===documentId))
    throw new FileError('需要使用这份飞书文档导出的带块 ID 的 XML，才能准确同步评论。','CLOUD_BINDING',409);
  const remoteMap=new Map(remote.comments.map(comment=>[comment.id,comment]));
  if(remoteMap.size!==remote.comments.length)throw new FileError('飞书返回重复评论身份，未进行同步。','CLOUD_READ',502);
  const persist=async()=>{
    review.document.updatedAt=now();
    snapshot=await file.save(snapshot.xml,review,snapshot.revision);
  };

  // Import by immutable cloud comment/reply IDs, never by quote or matching body.
  for(const cloud of remote.comments){
    let link=review.cloudSync.links.find(item=>item.cloudId===cloud.id);
    if(!link){
      const localId=`cloud:${documentId}:${cloud.id}`;
      if(review.comments.some(item=>item.id===localId))throw new FileError('本地评论 ID 与云端导入标识冲突。','CLOUD_CONFLICT',409);
      const comment:ReviewComment={id:localId,author:cloud.author,body:cloud.body,createdAt:cloud.createdAt,status:cloud.status,
        anchor:cloudCommentAnchor(cloud,localBlocks),replies:[]};
      link={localId,cloudId:cloud.id,body:cloud.body,cloudBody:cloud.body,status:cloud.status,replies:{},remote:clone(cloud)};
      review.comments.push(comment);review.cloudSync.links.push(link);report.imported++;
    }
    const comment=review.comments.find(item=>item.id===link!.localId);
    if(!comment){issue('有已同步评论在本地被删除；保留云端评论，不自动删除或重新导入。');continue;}
    if(comment.anchor.state==='attached'&&!cloud.whole){
      // A selected quote can live inside a child paragraph while the remote
      // reference names its callout/list ancestor. Validate that stated scope.
      const currentBlock=localCloudBlock(comment.anchor,cloud.blockId?localBlocks.filter(block=>block.id===cloud.blockId):localBlocks,remoteBlocks);
      const location=cloudCommentAnchor(cloud,localBlocks);
      if(location.state!=='attached'||!currentBlock||(cloud.blockId&&currentBlock.id!==cloud.blockId)||
        (cloud.boardToken&&currentBlock.boardToken!==cloud.boardToken)){
        comment.anchor={...comment.anchor,state:'unverified'};
        issue('有已同步评论的原引用发生变化，已保留评论并标记位置待确认。');
      }
    }
    if(comment.body!==link.body){issue('有本地评论正文被改写；当前保留双方内容，不用新评论覆盖原线程。');}
    else if(cloud.body!==link.cloudBody){comment.body=cloud.body;link.body=cloud.body;link.cloudBody=cloud.body;}
    if(comment.status===link.status){comment.status=cloud.status;link.status=cloud.status;}
    // A locally changed status is sent below; do not erase it while pulling.
    for(const reply of cloud.replies){
      const mapped=Object.entries(link.replies).find(([,value])=>value.cloudId===reply.id);
      if(mapped){
        const local=comment.replies.find(item=>item.id===mapped[0]);
        if(local&&local.body===mapped[1].body){local.body=reply.body;mapped[1].body=reply.body;}
        else if(local&&local.body!==reply.body)issue('有已同步回复被本地改写；保留双方内容，未覆盖。');
      }else{
        const id=`cloud-reply:${reply.id}`;
        if(comment.replies.some(item=>item.id===id))throw new FileError('回复身份冲突，未覆盖本地回复。','CLOUD_CONFLICT',409);
        comment.replies.push({id,body:reply.body,author:reply.author,createdAt:reply.createdAt});
        link.replies={...link.replies,[id]:{cloudId:reply.id,body:reply.body}};report.imported++;
      }
    }
    link.remote=clone(cloud);
  }
  review=normalizeImportedCloudAnchors(review,snapshot.xml);
  await persist(); // CAS before any remote mutation; imports and binding become durable.

  let halt=false;
  async function send(intent:Omit<CloudIntent,'id'|'startedAt'>,write:()=>Promise<unknown>,apply:(draft:Review,receipt:any)=>void):Promise<boolean> {
    const pending:CloudIntent={...intent,id:randomUUID(),startedAt:now()};
    review.cloudSync!.pending=pending;
    await persist(); // An uncertain/crashed attempt can never silently resend.
    let receipt:unknown;
    try{receipt=await write();}
    catch{
      issue('一次飞书写入未确认，已保留发送记录并停止后续发送；核对前不会重试。');return false;
    }
    // A different local process may edit while the API is in flight. Merge only
    // this operation's receipt into its latest document; never restore stale text.
    const fresh=await file.read();
    const externalChange=fresh.revision!==snapshot.revision;
    const next=clone(fresh.review);
    if(!next?.cloudSync||next.cloudSync.documentId!==documentId||next.cloudSync.pending?.id!==pending.id){
      issue('飞书已返回回执，但本地同步记录发生变化。请核对后继续，未覆盖新文件。');snapshot=fresh;return false;
    }
    if(next.document.xml!==fresh.xml){next.comments=invalidateAnchors(next.comments);next.document.xml=fresh.xml;}
    apply(next,receipt);delete next.cloudSync.pending;next.document.updatedAt=now();
    try{snapshot=await file.save(fresh.xml,next,fresh.revision);review=clone(snapshot.review!);}
    catch{issue('飞书已处理，本地回执保存遇到冲突；请核对后继续，未重发。');snapshot=await file.read();return false;}
    if(externalChange){issue('同步期间本地文件又被修改；已保留新内容及已完成的云回执，其余意见留待下次同步。');halt=true;}
    return true;
  }

  for(const id of review.comments.map(comment=>comment.id)){
    if(halt)break;
    let comment=review.comments.find(item=>item.id===id)!;
    let link=review.cloudSync!.links.find(item=>item.localId===id);
    if(!link){
      if(comment.status==='resolved')continue;
      const block=localCloudBlock(comment.anchor,localBlocks,remoteBlocks);
      if(!block){issue('有本地评论找不到唯一的飞书块位置，已保留本地意见；请先发布正文并确认对应关系。');continue;}
      const original=clone(comment);
      const body=comment.anchor.target?`针对图中「${comment.anchor.target.label||comment.anchor.target.id}」：\n${comment.body}`:comment.body;
      if(!validBody(body))continue;
      if(!await send({kind:'create',localId:id,body},()=>transport.create(block.tag==='title'?undefined:block.id,body),(next,receipt:{id:string})=>{
        const cloud:CloudComment={id:receipt.id,body,author:original.author,createdAt:now(),status:'open',quote:original.anchor.quote,blockId:block.id,whole:block.tag==='title',replies:[]};
        next.cloudSync!.links.push({localId:id,cloudId:receipt.id,body:original.body,cloudBody:body,status:'open',replies:{},remote:cloud});
      }))break;
      report.created++;link=review.cloudSync!.links.find(item=>item.localId===id)!;remoteMap.set(link.cloudId,link.remote);
      if(halt)break;
    }
    const cloud=remoteMap.get(link.cloudId);
    if(!cloud){issue('有已同步评论不在完整云端列表中；保留本地记录，未重新创建。');continue;}
    comment=review.comments.find(item=>item.id===id)!;
    // The public API rejects replies to resolved threads. Restore first only
    // when the user explicitly reopened this thread locally.
    if(cloud.status==='resolved'&&comment.status==='open'&&link.status==='resolved'){
      const stableLink=link;
      if(!await send({kind:'status',localId:id,cloudId:link.cloudId,status:'open'},()=>transport.resolve(stableLink.cloudId,false),next=>{
        const mapped=next.cloudSync!.links.find(item=>item.localId===id)!;mapped.status='open';mapped.remote.status='open';
      }))break;
      report.resolved++;cloud.status='open';link=review.cloudSync!.links.find(item=>item.localId===id)!;
      if(halt)break;
    }
    for(const reply of comment.replies.filter(item=>!Object.hasOwn(link!.replies,item.id))){
      if(cloud.whole){issue('飞书全文评论不接受回复，新增回复已保留本地。');continue;}
      if(cloud.status==='resolved'){issue('已解决的飞书评论不接受回复，请先在本地重新打开该评论。');continue;}
      if(!validBody(reply.body))continue;
      const stableLink=link,original=clone(reply);
      if(!await send({kind:'reply',localId:id,cloudId:link.cloudId,localReplyId:reply.id,body:reply.body},()=>transport.reply(stableLink.cloudId,original.body),(next,receipt:{id:string})=>{
        const mapped=next.cloudSync!.links.find(item=>item.localId===id)!;
        mapped.replies={...mapped.replies,[original.id]:{cloudId:receipt.id,body:original.body}};
      }))return {snapshot:await file.read(),report};
      report.replies++;link=review.cloudSync!.links.find(item=>item.localId===id)!;
      if(halt)return {snapshot:await file.read(),report};
    }
    comment=review.comments.find(item=>item.id===id)!;
    if(comment.status!==link.status){
      const stableLink=link,desired=comment.status;
      if(cloud.status!==link.status&&cloud.status!==desired){issue('评论状态在两端发生冲突，未覆盖。');continue;}
      if(cloud.status!==desired){
        if(!await send({kind:'status',localId:id,cloudId:link.cloudId,status:desired},()=>transport.resolve(stableLink.cloudId,desired==='resolved'),next=>{
          const mapped=next.cloudSync!.links.find(item=>item.localId===id)!;mapped.status=desired;mapped.remote.status=desired;
        }))break;
        report.resolved++;
      }else{link.status=desired;await persist();}
    }
  }
  if(!report.issues.length){review.cloudSync!.lastSyncedAt=report.syncedAt;await persist();}
  return {snapshot:await file.read(),report};
}
