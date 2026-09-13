import {LOCAL_EDITOR_ACTION_EVENT,type LocalEditorActionRequest} from '../../src/browser/host';
export const SYNC_EVENT='feishu-doc-local:acquire-sync';
export interface SyncLease {release():Promise<void>;}
interface WorkspaceEvents {trigger(name:string,...args:unknown[]):void;}
/** Base plugin responds synchronously, then flushes every open view before resolving. */
export async function acquireSyncLease(workspace:WorkspaceEvents,path:string):Promise<SyncLease>{
  let result:Promise<SyncLease>|undefined;
  workspace.trigger(SYNC_EVENT,{path,acquire:(lease:Promise<SyncLease>)=>{if(result)throw new Error('检测到重复的本地编辑器同步响应。');result=lease;}});
  if(!result)throw new Error('请先安装并启用「本地飞书文档」基础插件，再执行飞书同步。');
  return result;
}
export async function withSyncLease<T>(workspace:WorkspaceEvents,path:string,run:()=>Promise<T>):Promise<T>{
  const lease=await acquireSyncLease(workspace,path);
  let failed:unknown;
  try{return await run();}catch(error){failed=error;throw error;}finally{
    try{await lease.release();}catch(error){
      if(failed)throw new Error((failed instanceof Error?failed.message:'同步未确认完成')+'；重新读取本地编辑器失败：'+(error instanceof Error?error.message:'请重新打开文档'));
      throw error;
    }
  }
}

/** Local editor navigation delegates to the base plugin, never private plugin APIs. */
export async function openLocalEditor(workspace:WorkspaceEvents,action:LocalEditorActionRequest['action'],path:string):Promise<void>{
  let result:Promise<void>|undefined;
  workspace.trigger(LOCAL_EDITOR_ACTION_EVENT,{action,path,accept:(value:Promise<void>)=>{if(result)throw new Error('检测到重复的本地编辑器响应。');result=value;}});
  if(!result)throw new Error('请先安装并启用「本地飞书文档」基础插件，再打开或新建文档。');
  await result;
}
