import type { TFile, Vault } from 'obsidian';
import { parseDocxXML } from '../../src/core/docxml';
import { safeDraftPath } from './drafts';

const maximumXMLBytes=5_000_000;
const documentBlocks=new Set([
  'title','p','blockquote','pre','ul','ol','li','checkbox','table','grid','column','callout','hr',
  'latex','img','figure','source','whiteboard','sheet','bitable','iframe','html5-block','okr',
  ...Array.from({length:9},(_,index)=>'h'+(index+1)),
]);
const documentShells=new Set(['html','head','body','document','svg']);

/** Recognize the local DocxXML subset, not the origin of these bytes. A plain
 * <p> fragment is intentionally accepted only through the explicit open flow.
 * The shared parser is also deliberately permissive about unknown blocks, so
 * successful parsing alone must never identify an arbitrary XML document. */
export function assertDocxXML(xml:string):void{
  if(new TextEncoder().encode(xml).length>maximumXMLBytes)throw new Error('XML 超过 5 MB，未打开或修改。');
  const roots=parseDocxXML(xml).content.content||[];
  const namespace=(attrs:Record<string,unknown>)=>Object.keys(attrs).some(key=>key==='xmlns'||key.startsWith('xmlns:'));
  const known=roots.some(root=>documentBlocks.has(root.attrs?.lrTag)&&!namespace(root.attrs?.lrAttrs||{}));
  if(!known||roots.some(root=>documentShells.has(root.attrs?.lrTag)||namespace(root.attrs?.lrAttrs||{}))){
    throw new Error('这不是可识别的飞书 DocxXML。需要 title、p、h1–h9 等顶层文档块；普通 XML 请按 Obsidian 原有方式打开。校验通过只说明符合本地文档子集，不代表文件来源。');
  }
}

/** Only inspect the selected vault file. No vault-wide content scan or sidecar
 * creation takes place while deciding whether this editor can open it. */
export async function assertDocxXMLFile(vault:Vault,file:TFile):Promise<void>{
  const path=file.path,config=vault.configDir;
  if(!safeDraftPath(path)||file.extension.toLowerCase()!=='xml'||(config&&(path===config||path.startsWith(config+'/'))))throw new Error('请选择库内的飞书 XML 文档，不读取 Obsidian 配置文件。');
  if(vault.getFileByPath(path)!==file)throw new Error('文档位置已改变，请重新选择。');
  const size=file.stat.size,mtime=file.stat.mtime;
  if(size>maximumXMLBytes)throw new Error('XML 超过 5 MB，未打开或修改。');
  const xml=await vault.read(file);
  if(file.path!==path||vault.getFileByPath(path)!==file||file.stat.size!==size||file.stat.mtime!==mtime)throw new Error('读取时文档已变化，请重新选择。');
  assertDocxXML(xml);
}
