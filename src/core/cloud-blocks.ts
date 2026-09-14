import type { JSONContent } from '@tiptap/core';
import type { Anchor, Review } from './types';
import type { CloudComment } from './cloud-types';
import { parseDocxXML } from './docxml';

interface CloudTextRun { from:number; text:string; }
export interface CloudBlock { id:string; tag:string; from:number; to:number; atom:boolean; boardToken?:string; boardIdentity?:string; textRuns?:CloudTextRun[]; }
const leaves = new Set(['protectedBlock','protectedInline','xmlInlineLatex','xmlBlockLatex','hardBreak','horizontalRule']);
/** Positions use the same atom/text/container sizes as the imported editor schema. */
export function indexCloudBlocks(xml:string):CloudBlock[] {
  const result:CloudBlock[]=[];
  function size(node:JSONContent):number {
    if(node.type==='text')return node.text?.length||0;
    if(leaves.has(node.type||''))return 1;
    return (node.type==='doc'?0:2)+(node.content||[]).reduce((sum,child)=>sum+size(child),0);
  }
  function visit(node:JSONContent,from:number):CloudTextRun[] {
    const attrs=node.attrs?.lrAttrs||{}, id=attrs.id, atom=leaves.has(node.type||'');
    const block:CloudBlock|undefined=typeof id==='string'&&id?{id,tag:node.attrs?.lrTag||'',from,to:from+size(node),atom,
      ...(node.attrs?.lrTag==='whiteboard'?{boardToken:attrs.token||attrs.src,
        boardIdentity:['token','src','id','path'].filter(key=>typeof attrs[key]==='string'&&attrs[key].trim()).map(key=>`${key}:${attrs[key]}`)[0]}:{}),
    }:undefined;
    if(block)result.push(block);
    if(node.type==='text')return [{from,text:node.text||''}];
    if(atom)return node.type==='hardBreak'?[{from,text:'\n'}]:[];
    const runs:CloudTextRun[]=[];
    let position=from+(node.type==='doc'?0:1);
    for(const child of node.content||[]){
      for(const run of visit(child,position)){
        const previous=runs.at(-1);
        // Marks split text nodes without consuming positions. Containers and
        // opaque atoms create gaps, so a quote cannot silently cross them.
        if(previous&&previous.from+previous.text.length===run.from)
          runs[runs.length-1]={from:previous.from,text:previous.text+run.text};
        else runs.push(run);
      }
      position+=size(child);
    }
    if(block)block.textRuns=runs;
    return runs;
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
  if(block.atom||comment.whole)
    return {from:block.from+(block.atom?0:1),to:block.to-(block.atom?0:1),quote: block.tag==='whiteboard'?`【白板】${comment.quote||''}`:quote,state:'attached'};
  if(!comment.quote?.trim())return {from:0,to:0,quote,state:'unverified'};
  let from:number|undefined;
  for(const run of block.textRuns||[]){
    const offset=run.text.indexOf(comment.quote);
    if(offset<0)continue;
    // Include overlapping repetitions. The block ID proves scope, but never
    // chooses which occurrence the remote author actually selected.
    if(from!==undefined||run.text.indexOf(comment.quote,offset+1)>=0)return {from:0,to:0,quote,state:'unverified'};
    from=run.from+offset;
  }
  return from===undefined?{from:0,to:0,quote,state:'unverified'}
    :{from,to:from+comment.quote.length,quote,state:'attached'};
}

/** Repair only the exact broad ranges produced by the old cloud importer.
 * Local selections and invalidated/deleted positions have their own history;
 * a saved remote quote is not proof that those positions may be reassigned. */
export function normalizeImportedCloudAnchors<T extends Review>(review:T,xml:string):T {
  if(review.document.xml!==xml||!review.cloudSync?.links.length)return review;
  const sync=review.cloudSync;
  let blocks:CloudBlock[]|undefined,changed=false;
  const comments=review.comments.map(comment=>{
    if(comment.anchor.state!=='attached'||comment.anchor.target)return comment;
    const link=sync.links.find(item=>item.localId===comment.id);
    if(!link||comment.id!==`cloud:${sync.documentId}:${link.cloudId}`||link.remote.id!==link.cloudId||
      link.remote.whole||typeof link.remote.quote!=='string'||!link.remote.blockId||link.remote.boardToken)return comment;
    const cloud=link.remote;
    blocks||=indexCloudBlocks(xml);
    const matches=blocks.filter(block=>block.id===cloud.blockId);
    if(matches.length!==1||matches[0].atom)return comment;
    const block=matches[0],anchor=comment.anchor;
    if(anchor.from!==block.from+1||anchor.to!==block.to-1||anchor.quote!==(cloud.quote||'【飞书评论】'))return comment;
    const location=cloudCommentAnchor(cloud,blocks);
    if(location.state==='attached'&&location.from===anchor.from&&location.to===anchor.to)return comment;
    changed=true;
    return {...comment,anchor:location.state==='attached'?{...anchor,from:location.from,to:location.to}
      :{...anchor,state:'unverified' as const}};
  });
  return changed?{...review,comments}:review;
}
