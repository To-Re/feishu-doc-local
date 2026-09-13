import { localResourcePath } from '../../src/core/project-files';
import { isWhiteboardSVGPath, resolveResource } from '../../src/core/resources';
import type { ResourceMapping } from '../../src/core/types';

export const MAX_DOCUMENT_BYTES=5_000_000;
export const MAX_REVIEW_BYTES=20_000_000;
export const reviewPath=(path:string)=>path.replace(/\.xml$/i,'.review.json');
export function resourcePath(documentPath:string,relative:string):string {
  const normalized=localResourcePath(relative);
  if(!normalized)throw new Error('资源必须位于当前 XML 的目录内。');
  const directory=documentPath.slice(0,documentPath.lastIndexOf('/')+1);
  return directory+normalized;
}
export interface ExistingComment {body:string;quote:string;author:string;resolved:boolean;replies:Array<{author:string;body:string}>;}
export interface ReviewData {resources?:unknown;comments:ExistingComment[];}
export function readReview(raw:string):ReviewData {
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||!('format'in value)||value.format!=='lark-review'||!('version'in value)||value.version!==1)
    throw new Error('旁置评论文件格式不受支持；原文件未修改。');
  const record=value as Record<string,unknown>;
  if(!Array.isArray(record.comments))throw new Error('旁置评论文件缺少评论列表；原文件未修改。');
  const comments=record.comments.flatMap((item:unknown)=>{
    if(!item||typeof item!=='object')return [];
    const comment=item as Record<string,any>;
    if(typeof comment.body!=='string'||typeof comment.author!=='string')return [];
    return [{body:comment.body,author:comment.author,quote:typeof comment.anchor?.quote==='string'?comment.anchor.quote:'',resolved:comment.status==='resolved',
      replies:Array.isArray(comment.replies)?comment.replies.flatMap((reply:any)=>reply&&typeof reply.author==='string'&&typeof reply.body==='string'?[{author:reply.author,body:reply.body}]:[]):[]}];
  });
  return {resources:record.resources,comments};
}
export function resolvePreview(resources:unknown,tag:string,attrs:Record<string,unknown>):ResourceMapping|undefined {
  const mapped=resolveResource(resources,tag,attrs);
  if(mapped)return mapped;
  if(tag==='whiteboard'&&typeof attrs.path==='string'&&attrs.path.startsWith('@')&&isWhiteboardSVGPath(attrs.path.slice(1)))
    return {tag:'whiteboard',attribute:'path',value:attrs.path,representation:'preview',path:attrs.path.slice(1)};
}
