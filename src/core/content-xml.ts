import { SaxesParser } from 'saxes';

export interface ContentNode {tag:string;attrs:Record<string,string>;children:(ContentNode|string)[];raw:string;start:number;end:number;kind?:'comment'|'processinginstruction';}
export function contentNodes(xml:string):ContentNode[] {
  if(Buffer.byteLength(xml)>5_000_000)throw new Error('正文超过 5 MB。');
  const roots:ContentNode[]=[],stack:ContentNode[]=[];
  const parser=new SaxesParser({fragment:true,xmlns:false});let start=0,consumed=0;
  parser.on('error',()=>{throw new Error('正文不是合法 DocxXML。');});
  parser.on('doctype',()=>{throw new Error('正文不能包含实体声明。');});
  parser.on('opentagstart',()=>{start=xml.lastIndexOf('<',parser.position-1);});
  parser.on('opentag',tag=>{
    if(stack.length>255)throw new Error('正文嵌套过深。');
    const node:ContentNode={tag:tag.name,attrs:{...tag.attributes},children:[],raw:'',start,end:0};
    if(stack.length)stack.at(-1)!.children.push(node);else roots.push(node);stack.push(node);
    consumed=parser.position;
  });
  parser.on('closetag',()=>{const node=stack.pop()!;node.end=parser.position;node.raw=xml.slice(node.start,node.end);consumed=parser.position;});
  // Comments and processing instructions are source content too. Keep their exact
  // bytes and position rather than silently deleting them during an exchange.
  const trivia=(kind:'comment'|'processinginstruction',marker:string,end:number)=>{
    const start=xml.indexOf(marker,consumed);
    const node:ContentNode={kind,tag:'#'+kind,attrs:{},children:[],raw:xml.slice(start,end),start,end};
    if(stack.length)stack.at(-1)!.children.push(node);else roots.push(node);
    consumed=end;
  };
  parser.on('comment',()=>trivia('comment','<!--',parser.position+1));
  parser.on('processinginstruction',()=>trivia('processinginstruction','<?',parser.position));
  const text=(value:string)=>{if(stack.length)stack.at(-1)!.children.push(value);else if(value.trim())throw new Error('正文必须在 XML 块内。');};
  parser.on('text',text);parser.on('cdata',value=>{text(value);consumed=parser.position;});parser.write(xml).close();return roots;
}
const escaped=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
/** Strip document identities for creation/replacement, retaining IDs inside the drawing itself. */
export function exchangeXML(xml:string):string {
  function render(n:ContentNode,insideBoard=false):string {
    if(n.kind)return n.raw;
    const attrs=Object.entries(n.attrs).filter(([k])=>insideBoard||!['id','comment-refs'].includes(k)).map(([k,v])=>` ${k}="${escaped(v)}"`).join('');
    return `<${n.tag}${attrs}>${n.children.map(c=>typeof c==='string'?escaped(c):render(c,insideBoard||n.tag==='whiteboard')).join('')}</${n.tag}>`;
  }
  return contentNodes(xml).map(n=>render(n)).join('');
}
/** Compare XML structure, decoded text and attributes, ignoring only document/comment identities. */
export function comparableXML(xml:string):string {
  const normalize=(n:ContentNode,insideBoard=false):unknown=>n.kind?[n.kind,n.raw]:[n.tag,Object.entries(n.attrs).filter(([k])=>insideBoard||!['id','comment-refs'].includes(k)).sort(([a],[b])=>a.localeCompare(b)),
    n.children.reduce<(string|unknown)[]>((result,c)=>{
      if(typeof c==='string'&&typeof result.at(-1)==='string')result[result.length-1]=(result.at(-1) as string)+c;
      else result.push(typeof c==='string'?c:normalize(c,insideBoard||n.tag==='whiteboard'));return result;
    },[])];
  return JSON.stringify(contentNodes(xml).map(n=>normalize(n)));
}
export function contentBlockIDs(node:ContentNode):string[] {
  if(node.attrs.id)return [node.attrs.id];
  if(node.tag==='whiteboard'||node.kind)return [];
  return node.children.flatMap(c=>typeof c==='string'?[]:contentBlockIDs(c));
}
export interface ContentWrite {command:'overwrite'|'block_replace'|'append';blockId?:string;xml:string;}
export function planContentWrites(localXML:string,cloudXML:string):{writes:ContentWrite[];warnings:string[]} {
  if(comparableXML(localXML)===comparableXML(cloudXML))return {writes:[],warnings:[]};
  const local=contentNodes(localXML),remote=contentNodes(cloudXML);
  const keys=(nodes:ContentNode[])=>nodes.map(n=>contentBlockIDs(n).join(','));
  const a=keys(local),b=keys(remote),samePrefix=remote.length<=local.length&&remote.every((n,i)=>n.tag===local[i].tag&&
    (n.tag==='title'||n.kind||!b[i]?comparableXML(n.raw)===comparableXML(local[i].raw):b[i]===a[i]));
  const ids=b.flatMap(id=>id? id.split(','):[]);
  if(samePrefix&&ids.every(id=>/^[A-Za-z0-9_-]{1,512}$/.test(id))&&new Set(ids).size===ids.length&&
    !local.slice(remote.length).some(n=>n.tag==='title')){
    const writes:ContentWrite[]=[];
    remote.forEach((n,i)=>{if(comparableXML(n.raw)!==comparableXML(local[i].raw))writes.push({command:'block_replace',blockId:b[i],xml:exchangeXML(local[i].raw)});});
    if(local.length>remote.length)writes.push({command:'append',xml:exchangeXML(local.slice(remote.length).map(n=>n.raw).join(''))});
    return {writes,warnings:writes.some(w=>w.command==='block_replace')?['修改块可能获得新 ID；原评论会保留，无法可靠定位的位置标记待确认。']:[]};
  }
  return {writes:[{command:'overwrite',xml:exchangeXML(localXML)}],warnings:['本次结构变化需要替换飞书正文，原块 ID 可能改变，已有评论引用可能失效；将先保存两端快照。']};
}
