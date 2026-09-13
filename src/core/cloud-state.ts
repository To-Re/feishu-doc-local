import type { CloudSyncState } from './cloud-types';
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<512&&!/[\s\u0000-\u001f\u007f]/.test(value);
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const status=(value:unknown)=>value==='open'||value==='resolved';
export function isCloudSyncState(value:unknown):value is CloudSyncState {
  if(!record(value)||value.version!==1||!id(value.documentId)||typeof value.url!=='string'||!Array.isArray(value.links)||value.links.length>10000)return false;
  try {const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname))return false;}catch{return false;}
  if(value.lastSyncedAt!==undefined&&!date(value.lastSyncedAt))return false;
  const localIDs=new Set(),cloudIDs=new Set();
  for(const link of value.links){
    if(!record(link)||!id(link.localId)||!id(link.cloudId)||localIDs.has(link.localId)||cloudIDs.has(link.cloudId)||typeof link.body!=='string'||typeof link.cloudBody!=='string'||!status(link.status)||!record(link.replies)||!record(link.remote)||link.remote.id!==link.cloudId)return false;
    localIDs.add(link.localId);cloudIDs.add(link.cloudId);
    const replyIDs=new Set();
    for(const [localId,reply] of Object.entries(link.replies)){
      if(!id(localId)||!record(reply)||!id(reply.cloudId)||typeof reply.body!=='string'||replyIDs.has(reply.cloudId))return false;
      replyIDs.add(reply.cloudId);
    }
  }
  const p=value.pending;
  if(p!==undefined&&(!record(p)||!id(p.id)||!id(p.localId)||!date(p.startedAt)||!['create','reply','status'].includes(p.kind)||
    (p.kind!=='create'&&!id(p.cloudId))||(p.kind==='reply'&&!id(p.localReplyId))||
    (p.kind==='status'?!status(p.status):typeof p.body!=='string')))return false;
  return true;
}
