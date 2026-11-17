import { SaxesParser } from 'saxes';
import { assertDocxXML } from '../../src/core/document-kind';
import { localResourcePath } from '../../src/core/project-files';
import { localMediaType, mediaMatches, isTextAttachment } from '../../src/core/local-media';
import { readReview, resolvePreview, type ReviewData } from '../../obsidian-plugin/src/document';

export interface PreviewSnapshot { xml:string; review:ReviewData; assets:Record<string,string>; texts:Record<string,string>; warnings:string[]; }
export const reviewName=(name:string)=>name.replace(/\.xml$/i,'.review.json');
export function referencedResources(xml:string,review:ReviewData):string[] {
  const paths=new Set<string>();
  const parser=new SaxesParser({fragment:true});
  parser.on('doctype',()=>{throw Error('不允许 DOCTYPE');});
  parser.on('opentag',tag=>{
    if(!['img','whiteboard','source'].includes(tag.name))return;
    const attrs=tag.attributes as Record<string,string>;
    const mapping=resolvePreview(review.resources,tag.name,attrs);
    const value=attrs.path?.startsWith('@')?attrs.path.slice(1):undefined;
    const normalized=localResourcePath(value);if(normalized)paths.add(normalized);
    const mapped=localResourcePath(mapping?.path);if(mapped)paths.add(mapped);
  });
  parser.write(xml).close();
  if(paths.size>200)throw Error('文档引用的资源超过 200 个，请拆分文档后预览。');
  return [...paths];
}
function rasterType(path:string,data:Uint8Array):string|undefined {
  const ascii=(a:number,b:number)=>Buffer.from(data.subarray(a,b)).toString('ascii');
  if(/\.png$/i.test(path)&&Buffer.from(data.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(/\.jpe?g$/i.test(path)&&data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  if(/\.gif$/i.test(path)&&['GIF87a','GIF89a'].includes(ascii(0,6)))return 'image/gif';
  if(/\.webp$/i.test(path)&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return 'image/webp';
  if(/\.avif$/i.test(path)&&ascii(4,8)==='ftyp'&&/avif|avis/.test(ascii(8,64)))return 'image/avif';
}
export async function makeSnapshot(xml:string,sidecar:string|undefined,read:(path:string,limit:number)=>Promise<Uint8Array>):Promise<PreviewSnapshot> {
  assertDocxXML(xml);
  const result:PreviewSnapshot={xml,review:{comments:[]},assets:Object.create(null),texts:Object.create(null),warnings:[]};
  if(sidecar!==undefined){try{result.review=readReview(sidecar);}catch{result.warnings.push('评论文件无法解析，正文仍可阅读；原文件未修改。');}}
  let total=0;
  for(const path of referencedResources(xml,result.review)){
    const media=localMediaType(path),text=/\.svg$/i.test(path)||isTextAttachment(path);
    if(!text&&!media&&!/\.(png|jpe?g|gif|webp|avif)$/i.test(path))continue;
    try{
      const limit=text?2_000_000:media?25_000_000:20_000_000;
      if(total>=80_000_000)throw Error('资源总量超过 80 MB');
      const remaining=Math.min(limit,80_000_000-total);
      const data=await read(path,remaining);
      if(data.length>remaining)throw Error('资源超过大小限制');
      total+=data.length;
      if(text)result.texts[path]=new TextDecoder('utf-8',{fatal:true}).decode(data);
      else {
        const type=media&&mediaMatches(data,path)?media:rasterType(path,data);
        if(!type)throw Error('资源内容与受支持格式不一致');
        result.assets[path]=`data:${type};base64,${Buffer.from(data).toString('base64')}`;
      }
    }catch{result.warnings.push(`资源不可用：${path}（缺失、越界、链接或格式／大小不受支持）`);}
  }
  return result;
}
