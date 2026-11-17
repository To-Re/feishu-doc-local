import { parseDocxXML } from './docxml';

const maximumXMLBytes=5_000_000;
const documentBlocks=new Set([
  'title','p','blockquote','pre','ul','ol','li','checkbox','table','grid','column','callout','hr',
  'latex','img','figure','source','whiteboard','sheet','bitable','iframe','html5-block','okr',
  ...Array.from({length:9},(_,index)=>'h'+(index+1)),
]);
const documentShells=new Set(['html','head','body','document','svg']);

/** Recognize the local DocxXML subset, not the origin of these bytes. A plain
 * <p> fragment remains compatible with existing local articles.
 * The shared parser is also deliberately permissive about unknown blocks, so
 * successful parsing alone must never identify an arbitrary XML document. */
export function assertDocxXML(xml:string):void{
  if(new TextEncoder().encode(xml).length>maximumXMLBytes)throw new Error('XML 超过 5 MB，未打开或修改。');
  const roots=parseDocxXML(xml).content.content||[];
  const namespace=(attrs:Record<string,unknown>)=>Object.keys(attrs).some(key=>key==='xmlns'||key.startsWith('xmlns:'));
  const known=roots.some(root=>documentBlocks.has(root.attrs?.lrTag)&&!namespace(root.attrs?.lrAttrs||{}));
  if(!known||roots.some(root=>documentShells.has(root.attrs?.lrTag)||namespace(root.attrs?.lrAttrs||{}))){
    throw new Error('这不是可识别的飞书 DocxXML。需要 title、p、h1–h9 等顶层文档块；普通 XML 请使用原来的源码编辑器打开。校验通过只说明符合本地文档子集，不代表文件来源。');
  }
}
