import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,realpath,lstat,rename} from 'node:fs/promises';
import {dirname,resolve,relative,extname,sep} from 'node:path';
import {contentNodes,type ContentNode} from '../core/content-xml';
import type {ResourceManifest,ResourceMapping,Snapshot} from '../core/types';
import {localResourcePath,projectFiles} from '../core/project-files';
import {isResourceMapping} from '../core/resources';
import {FileError} from './files';

type Downloader={download(input:{token:string;type:'media'|'whiteboard';outputPath:string}):Promise<{path:string}>};
/** Obsidian indexes visible directories; the server keeps its private default. */
export interface ContentResourceOptions {directoryPrefix?:'feishu-assets-';}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const MAX_RESOURCE=50_000_000;
/** Bounded, nonblocking reads reject special files and detect replacement while reading. */
async function resourceBytes(base:string,path:string):Promise<Buffer>{
  const file=await realpath(path);
  if(!file.startsWith(base+sep))throw new FileError('素材真实路径超出文章目录。','INVALID_PATH',400);
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.nlink!==1)throw new FileError('素材必须是普通文件，不能是硬链接或特殊文件。','INVALID_PATH',400);
    if(before.size>MAX_RESOURCE)throw new FileError('素材超过 50 MB。','TOO_LARGE',413);
    const chunks:Buffer[]=[];let total=0;
    for(;;){
      const chunk=Buffer.allocUnsafe(Math.min(65_536,MAX_RESOURCE-total+1));
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;
      total+=bytesRead;if(total>MAX_RESOURCE)throw new FileError('素材超过 50 MB。','TOO_LARGE',413);
      chunks.push(chunk.subarray(0,bytesRead));
    }
    const after=await handle.stat(),current=await lstat(file);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||
      current.dev!==before.dev||current.ino!==before.ino||current.isSymbolicLink()||await realpath(path)!==file)
      throw new FileError('读取期间素材已变化，请重新预览。','CONFLICT');
    return Buffer.concat(chunks,total);
  }finally{await handle.close();}
}
export function hasCloudWhiteboards(xml:string):boolean {
  const visit=(nodes:(ContentNode|string)[]):boolean=>nodes.some(n=>typeof n!=='string'&&(n.tag==='whiteboard'?
    /^[A-Za-z0-9_-]{1,512}$/.test(n.attrs.token||n.attrs.src||''):visit(n.children)));
  return visit(contentNodes(xml));
}
export async function localAssetHashes(xml:string,path:string):Promise<Record<string,string>> {
  const base=await realpath(dirname(path)),result:Record<string,string>=Object.create(null);
  async function visit(nodes:(ContentNode|string)[]):Promise<void>{for(const node of nodes){
    if(typeof node==='string')continue;
    if(['img','source','whiteboard'].includes(node.tag)&&node.attrs.path){
      const local=node.attrs.path.startsWith('@')?localResourcePath(node.attrs.path.slice(1).trim()):undefined;
      if(!local)throw new FileError('正文包含不安全的本地素材路径。','INVALID_PATH',400);
      result[local]=hash(await resourceBytes(base,resolve(base,local)));
    }
    if(node.tag!=='whiteboard')await visit(node.children);
  }}
  await visit(contentNodes(xml));return result;
}

/** Historical references remain in place. Record their bytes, including a missing-file marker. */
export async function snapshotResourceHashes(path:string,snapshot:Pick<Snapshot,'xml'|'review'>):Promise<Record<string,string|null>> {
  const base=await realpath(dirname(path)),result:Record<string,string|null>=Object.create(null);
  const validatePaths=(nodes:(ContentNode|string)[])=>{for(const node of nodes){
    if(typeof node==='string')continue;
    if(['img','source','whiteboard'].includes(node.tag)&&node.attrs.path&&(!node.attrs.path.startsWith('@')||!localResourcePath(node.attrs.path.slice(1))))
      throw new FileError('快照正文包含不安全的本地资源路径。','INVALID_PATH',400);
    if(node.tag!=='whiteboard')validatePaths(node.children);
  }};validatePaths(contentNodes(snapshot.xml));
  const resources=projectFiles({name:path.split(sep).at(-1)!,path,reviewPath:path.replace(/\.xml$/i,'.review.json')},snapshot.xml,snapshot.review).filter(item=>item.kind==='resource');
  for(const resource of resources){
    const relativePath=localResourcePath(resource.path);
    if(!relativePath||relativePath!==resource.path)throw new FileError('快照资源路径不安全。','INVALID_PATH',400);
    try{
      let component=base;
      for(const part of relativePath.split('/')){
        component=resolve(component,part);
        if((await lstat(component)).isSymbolicLink())throw new FileError('快照资源不能使用软链接。','INVALID_PATH',400);
      }
      result[relativePath]=hash(await resourceBytes(base,resolve(base,relativePath)));
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')result[relativePath]=null;else throw error;}
  }
  return result;
}

/** Cache only resources explicitly present in the fetched XML, under a fresh private directory. */
export async function cacheContentResources(path:string,xml:string,previous:ResourceManifest|undefined,transport:Downloader,options:ContentResourceOptions={}):Promise<{resources:ResourceManifest;warnings:string[]}> {
  if(options.directoryPrefix!==undefined&&options.directoryPrefix!=='feishu-assets-')throw new FileError('资源目录前缀不受支持。','INVALID_PATH',400);
  const base=await realpath(dirname(path)),items:ResourceMapping[]=[],warnings:string[]=[];
  const selected:{tag:'img'|'source'|'whiteboard';attribute:'src'|'token';value:string;name:string}[]=[];
  const seen=new Set<string>();
  function visit(nodes:(ContentNode|string)[]){for(const n of nodes){if(typeof n==='string')continue;
    if(['img','source','whiteboard'].includes(n.tag)){
      const attribute=n.attrs.token?'token':'src',value=n.attrs[attribute];
      if(n.tag==='source'&&attribute!=='token'){warnings.push('附件缺少官方 token，未自动下载。');continue;}
      if(value&&/^[A-Za-z0-9_-]{1,512}$/.test(value)){
        const key=`${n.tag}:${attribute}:${value}`;
        if(!seen.has(key)){seen.add(key);selected.push({tag:n.tag as 'img'|'source'|'whiteboard',attribute,value,name:n.attrs.name||''});}
      }
    }
    if(n.tag!=='whiteboard')visit(n.children);
  }}visit(contentNodes(xml));
  if(selected.length>100)throw new FileError('单次资源同步最多 100 项，原本地稿件未被覆盖。','TOO_LARGE',413);
  let folder='';
  for(const asset of selected){
    const old=previous?.items.find(i=>i.tag===asset.tag&&i.attribute===asset.attribute&&i.value===asset.value);
    // A native whiteboard can change without changing its token or DocxXML.
    // An explicit pull/adoption always obtains a new preview for that token.
    if(old&&asset.tag!=='whiteboard'&&isResourceMapping(old)&&(!options.directoryPrefix||!old.path.split('/').some(part=>part.startsWith('.')))){
      try{await resourceBytes(base,resolve(base,old.path));items.push(old);continue;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    if(!folder){
      folder=resolve(base,(options.directoryPrefix||'.review-assets-')+randomUUID());await mkdir(folder,{mode:0o700});
      if(await realpath(folder)!==folder)throw new FileError('资源目录发生变化。','PATH_CHANGED');
    }
    let extension=asset.tag==='whiteboard'?'.jpg':asset.tag==='img'?'.bin':extname(asset.name).toLowerCase();
    if(!/^\.[a-z0-9]{1,8}$/.test(extension))extension='.bin';
    const file=resolve(folder,hash(Buffer.from(asset.tag+':'+asset.attribute+':'+asset.value)).slice(0,24)+extension);
    const receipt=await transport.download({token:asset.value,type:asset.tag==='whiteboard'?'whiteboard':'media',outputPath:file});
    if(resolve(receipt.path)!==file||await realpath(file)!==file)throw new FileError('素材下载回执路径不匹配。','RESOURCE_DOWNLOAD');
    const bytes=await resourceBytes(base,file);let final=file;
    if(asset.tag==='img'||asset.tag==='whiteboard'){
      const actual=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'.png':bytes[0]===255&&bytes[1]===216?'.jpg':bytes.subarray(0,3).toString()==='GIF'?'.gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'.webp':null;
      if(!actual)throw new FileError('下载的图片或白板预览不是支持的图像，原稿未被覆盖。','RESOURCE_DOWNLOAD');
      final=file.slice(0,-extension.length)+actual;if(final!==file)await rename(file,final);
    }
    const common={value:asset.value,path:relative(base,final).split(sep).join('/')};
    if(asset.tag==='whiteboard')items.push({...common,tag:'whiteboard',attribute:asset.attribute,representation:'preview'});
    else if(asset.tag==='img')items.push({...common,tag:'img',attribute:asset.attribute,representation:'original'});
    else items.push({...common,tag:'source',attribute:'token',representation:'original'});
  }
  return {resources:{version:1,items},warnings};
}
