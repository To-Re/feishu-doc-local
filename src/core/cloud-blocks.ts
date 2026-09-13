import type { JSONContent } from '@tiptap/core';
import type { Anchor } from './types';
import type { CloudComment } from './cloud-types';
import { parseDocxXML } from './docxml';

export interface CloudBlock { id:string; tag:string; from:number; to:number; atom:boolean; boardToken?:string; boardIdentity?:string; }
const leaves = new Set(['protectedBlock','protectedInline','xmlInlineLatex','xmlBlockLatex','hardBreak','horizontalRule']);
/** Positions use the same atom/text/container sizes as the imported editor schema. */
export function indexCloudBlocks(xml:string):CloudBlock[] {
  const result:CloudBlock[]=[];
  function size(node:JSONContent):number {
    if(node.type==='text')return node.text?.length||0;
    if(leaves.has(node.type||''))return 1;
    return (node.type==='doc'?0:2)+(node.content||[]).reduce((sum,child)=>sum+size(child),0);
  }
  function visit(node:JSONContent,from:number) {
    const attrs=node.attrs?.lrAttrs||{}, id=attrs.id, atom=leaves.has(node.type||'');
    if(typeof id==='string'&&id)result.push({id,tag:node.attrs?.lrTag||'',from,to:from+size(node),atom,
      ...(node.attrs?.lrTag==='whiteboard'?{boardToken:attrs.token||attrs.src,
        boardIdentity:['token','src','id','path'].filter(key=>typeof attrs[key]==='string'&&attrs[key].trim()).map(key=>`${key}:${attrs[key]}`)[0]}:{}),
    });
    let position=from+(node.type==='doc'?0:1);
    for(const child of node.content||[]){visit(child,position);position+=size(child);}
  }
  visit(parseDocxXML(xml).content,0);return result;
}
export function localCloudBlock(anchor:Anchor,local:CloudBlock[],remote:CloudBlock[]):CloudBlock|undefined {
  if(anchor.state!=='attached')return;
  const candidates=local.filter(block=>block.from<=anchor.from&&block.to>=anchor.to&&(!anchor.target||block.tag==='whiteboard'))
    .sort((a,b)=>(a.to-a.from)-(b.to-b.from));
  const block=candidates[0];if(!block||local.filter(item=>item.id===block.id).length!==1)return;
  if(anchor.target&&anchor.target.board!==block.boardIdentity)return;
  const matches=remote.filter(item=>item.id===block.id&&item.tag===block.tag);
  if(matches.length!==1)return;
  if(block.tag==='whiteboard'&&block.boardToken!==matches[0].boardToken)return;
  return block;
}
export function cloudCommentAnchor(comment:CloudComment,blocks:CloudBlock[]):Anchor {
  const matches=comment.blockId?blocks.filter(block=>block.id===comment.blockId)
    :comment.boardToken?blocks.filter(block=>block.tag==='whiteboard'&&block.boardToken===comment.boardToken):[];
  const quote=comment.quote|| (comment.whole?'【全文评论】':'【飞书评论】');
  if(matches.length!==1)return {from:0,to:0,quote,state:'unverified'};
  const block=matches[0];
  if(comment.boardToken&&(block.tag!=='whiteboard'||block.boardToken!==comment.boardToken))return {from:0,to:0,quote,state:'unverified'};
  return {from:block.from+(block.atom?0:1),to:block.to-(block.atom?0:1),quote: block.tag==='whiteboard'?`【白板】${comment.quote||''}`:quote,state:'attached'};
}
