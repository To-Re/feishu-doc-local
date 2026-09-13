import type {ContentSyncState} from './projects';
import {localResourcePath} from './project-files';
export function isContentSyncState(value:unknown):value is ContentSyncState {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,any>;
  const date=(n:unknown)=>typeof n==='string'&&Number.isFinite(Date.parse(n));
  if(v.version!==1||typeof v.documentId!=='string'||!/^([A-Za-z0-9_-]+)?$/.test(v.documentId)||
    typeof v.localXML!=='string'||typeof v.cloudXML!=='string'||!Number.isSafeInteger(v.cloudRevision)||v.cloudRevision<0||!date(v.syncedAt))return false;
  if(v.localAssets!==undefined&&(!v.localAssets||typeof v.localAssets!=='object'||Array.isArray(v.localAssets)||
    Object.entries(v.localAssets).some(([path,hash])=>localResourcePath(path)!==path||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))))return false;
  const p=v.pending;
  return p===undefined||!!p&&typeof p==='object'&&!Array.isArray(p)&&typeof p.id==='string'&&!!p.id&&
    ['push','pull','create'].includes(p.direction)&&date(p.startedAt)&&typeof p.sourceXML==='string'&&
    (p.cloudRevision===undefined||Number.isSafeInteger(p.cloudRevision)&&p.cloudRevision>=0);
}
