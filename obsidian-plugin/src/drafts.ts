import type { EditorRecovery } from '../../src/browser/host';
import { validateBrowserReview } from '../../src/browser/review';
import { isAnchorTarget } from '../../src/core/anchors';
import { parseDocxXML } from '../../src/core/docxml';

interface DraftRecord {path:string;updatedAt:number;value:EditorRecovery;previousPaths?:string[];}
interface DraftData {version:1;drafts:{[key:string]:DraftRecord};}
export const safeDraftPath=(path:string)=>!!path&&!path.startsWith('/')&&!/[\\:\u0000-\u001f\u007f]/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
const object=(value:unknown):value is {[key:string]:unknown}=>!!value&&typeof value==='object'&&!Array.isArray(value);

export async function validateRecovery(value:unknown,path:string):Promise<EditorRecovery>{
  const fail=():never=>{throw new Error('保留草稿格式无效，原记录未删除。');};
  if(!object(value)||value.format!=='feishu-editor-draft'||value.version!==1||value.path!==path||!safeDraftPath(path)||
    typeof value.xml!=='string'||typeof value.revision!=='string'||typeof value.dirty!=='boolean'||typeof value.comment!=='string'||
    !object(value.replies)||Object.values(value.replies).some(reply=>typeof reply!=='string')||!Array.isArray(value.formula)||!Array.isArray(value.whiteboard))fail();
  const recovery=value as unknown as EditorRecovery;
  if(recovery.invalidSource!==null&&(!object(recovery.invalidSource)||typeof recovery.invalidSource.value!=='string'||typeof recovery.invalidSource.error!=='string'))fail();
  const anchor=recovery.pending;
  if(anchor!==null&&(!object(anchor)||!Number.isSafeInteger(anchor.from)||!Number.isSafeInteger(anchor.to)||anchor.from<0||anchor.to<anchor.from||
    typeof anchor.quote!=='string'||!['attached','deleted','unverified'].includes(anchor.state)||(anchor.target!==undefined&&!isAnchorTarget(anchor.target))))fail();
  for(const snapshots of [recovery.formula,recovery.whiteboard]){
    const ids=new Set<string>();
    for(const item of snapshots){if(!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||ids.has(item[0])||!object(item[1])||typeof item[1].value!=='string'||typeof item[1].revision!=='string')fail();ids.add(item[0]);}
  }
  if(new TextEncoder().encode(JSON.stringify(recovery)).length>25_000_000)throw new Error('草稿超过 25 MB，未替换原恢复记录。');
  parseDocxXML(recovery.xml);const review=await validateBrowserReview(recovery.review,path.split('/').at(-1)!);
  if(review.document.xml!==recovery.xml||review.pendingWrite)fail();
  return structuredClone(recovery);
}

/** Per-view recovery sessions; reopening a file never silently applies a draft. */
export class DraftStore {
  private data:DraftData={version:1,drafts:{}};
  private active=new Set<string>();
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private save:(value:DraftData)=>Promise<void>){}
  load(value:unknown){
    if(object(value)&&value.version===1&&object(value.drafts))this.data={version:1,drafts:{...value.drafts as DraftData['drafts']}};
  }
  list(){return Object.entries(this.data.drafts).filter(([,record])=>record&&typeof record.path==='string'&&safeDraftPath(record.path)&&Number.isFinite(record.updatedAt))
    .map(([id,record])=>({id,path:record.path,updatedAt:record.updatedAt,active:this.active.has(id)})).sort((a,b)=>b.updatedAt-a.updatedAt);}
  async get(id:string){const record=this.data.drafts[id];if(!record)throw new Error('未找到这份草稿。');return validateRecovery(record.value,record.path);}
  async open(path:string,preferred?:string){
    if(!safeDraftPath(path))throw new Error('草稿路径必须位于当前 Obsidian 库内。');
    const id=preferred||crypto.randomUUID();
    if(this.active.has(id))throw new Error('这份草稿已在另一页签中打开，请先关闭该页签。');
    if(preferred&&this.data.drafts[id]?.path!==path)throw new Error('草稿与当前文档不匹配，未替换恢复记录。');
    this.active.add(id);let recovery:EditorRecovery|null=null;
    try{if(preferred)recovery=await this.get(id);}catch(error){this.active.delete(id);throw error;}
    let closed=false;
    return{id,recovery,write:(value:EditorRecovery|null)=>closed?Promise.reject(new Error('此草稿会话已关闭。')):this.write(id,path,value),close:()=>{closed=true;this.active.delete(id);}};
  }
  private write(id:string,path:string,value:EditorRecovery|null){
    const input=value?structuredClone(value):null;
    return this.enqueue(async()=>{
      const checked=input?await validateRecovery(input,path):null;
      const next:DraftData={version:1,drafts:{...this.data.drafts}};
      if(checked)next.drafts[id]={path,updatedAt:Date.now(),value:checked};else delete next.drafts[id];
      await this.save(structuredClone(next));this.data=next;
    });
  }
  private enqueue(action:()=>Promise<void>){const operation=this.queue.catch(()=>undefined).then(action);this.queue=operation;return operation;}
  async relocate(oldPath:string,newPath:string){
    if(!safeDraftPath(oldPath)||!safeDraftPath(newPath))throw new Error('迁移草稿路径无效。');
    return this.enqueue(async()=>{
      const next=structuredClone(this.data);let changed=false;
      for(const [id,record]of Object.entries(next.drafts))if(record.path===oldPath){
        if(this.active.has(id))throw new Error('请先保存并关闭此文档的全部页签，再迁移草稿。');
        const value=await validateRecovery(record.value,oldPath);value.path=newPath;value.review.document.name=newPath.split('/').at(-1)!;
        next.drafts[id]={...record,path:newPath,value,previousPaths:[...(record.previousPaths||[]),oldPath]};changed=true;
      }
      if(changed){await this.save(structuredClone(next));this.data=next;}
    });
  }
  async copy(id:string,path:string){
    const value=await this.get(id);value.path=path;value.review.document.name=path.split('/').at(-1)!;
    const session=await this.open(path);try{await session.write(value);return session.id;}finally{session.close();}
  }
  async discard(id:string){return this.enqueue(async()=>{
    if(this.active.has(id))throw new Error('这份草稿仍在编辑，不能丢弃。');
    const next=structuredClone(this.data);delete next.drafts[id];await this.save(next);this.data=next;
  });}
  async settled(){await this.queue;}
}
