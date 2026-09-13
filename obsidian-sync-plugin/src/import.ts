import {constants,type Stats} from 'node:fs';
import {lstat,mkdtemp,open,realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseDocxXML} from '../../src/core/docxml';
import {contentNodes,type ContentNode} from '../../src/core/content-xml';
import {createReview} from '../../src/core/types';
import type {ReviewProject} from '../../src/core/projects';
import {ContentCLIError,type ContentDocument,type ContentTransport} from '../../src/server/content-cli';
import {cacheContentResources} from '../../src/server/content-resources';
import {FileError,openLocalFile,validateReview} from '../../src/server/files';
import {validateProjectRegistrations,type ProjectStore} from '../../src/server/projects';

export interface PreparedImport {
  readonly xml:string;readonly documentId:string;readonly title:string;readonly url:string;
  readonly path:string;readonly vaultPath:string;readonly expiresAt:string;readonly warnings:readonly string[];
}
interface Directory {path:string;dev:number;ino:number;}
interface ImportTarget {path:string;reviewPath:string;vaultPath:string;directories:Directory[];}
export interface ImportPlan {view:PreparedImport;target:ImportTarget;remote:ContentDocument;sourceURL:string;}
export interface ImportResult {project:ReviewProject;vaultPath:string;warnings:string[];evidencePath:string;}
const fail=(message:string,code='CONFLICT'):never=>{throw new FileError(message,code);};
const sameFile=(before:Pick<Stats,'dev'|'ino'>,after:Stats)=>before.dev===after.dev&&before.ino===after.ino;

async function absent(path:string){
  try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  fail('目标 XML、相邻评论文件或同步锁已存在，请选择新的文件名。','ALREADY_EXISTS');
}
async function checkDirectories(target:ImportTarget){
  for(const before of target.directories){
    const current=await lstat(before.path);
    if(!current.isDirectory()||current.isSymbolicLink()||!sameFile(before,current)||await realpath(before.path)!==before.path)
      fail('导入目录已变化，请重新选择目标并预览。','PATH_CHANGED');
  }
}
async function checkTarget(target:ImportTarget){
  await checkDirectories(target);
  await absent(target.path);await absent(target.reviewPath);await absent(target.reviewPath+'.sync.lock');
}
async function newTarget(vaultRoot:string,input:string):Promise<ImportTarget>{
  if(typeof input!=='string'||!input||input!==input.trim()||isAbsolute(input)||!(/\.xml$/i.test(input))||
    /[\\:\u0000-\u001f\u007f]/.test(input)||input.split('/').some(part=>!part||part.startsWith('.')||part!==part.trim()))
    fail('请填写仓库内的新 XML 相对路径；不能包含隐藏目录、链接或上级路径。','INVALID_PATH');
  const root=await realpath(vaultRoot),path=resolve(root,input),part=relative(root,path);
  if(!part||part==='..'||part.startsWith('..'+sep)||isAbsolute(part))fail('导入目标必须位于当前 Obsidian 仓库内。','INVALID_PATH');
  const directories:Directory[]=[];
  let cursor=root;
  for(const segment of ['',...input.split('/').slice(0,-1)]){
    if(segment)cursor=join(cursor,segment);
    let info:Stats;
    try{info=await lstat(cursor);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')fail('目标父目录不存在，请先在仓库中创建目录。','NOT_FOUND');throw error;}
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(cursor)!==cursor)
      fail('导入目标不支持链接目录或特殊文件。','INVALID_PATH');
    directories.push({path:cursor,dev:info.dev,ino:info.ino});
  }
  const target={path,reviewPath:path.replace(/\.xml$/i,'.review.json'),vaultPath:part.split(sep).join('/'),directories};
  await checkTarget(target);return target;
}
async function checkDuplicates(store:ProjectStore,target:ImportTarget,documentId?:string){
  const entries=await store.list();
  if(entries.some(project=>project.localPath===target.path||documentId&&project.cloud?.documentId===documentId))
    fail('这份本地稿件或飞书文档已经属于另一个项目，请直接打开已有项目。','PROJECT_DUPLICATE');
}
function validateSourceURL(input:string){
  if(typeof input!=='string')fail('请填写飞书 Docx 或 Wiki 链接。','INVALID_REQUEST');
  const url=input.trim(),token=/\/(?:docx|wiki)\/([A-Za-z0-9_-]+)\/?$/.exec(url)?.[1]||'invalid';
  validateProjectRegistrations([{id:'import-check',name:'导入',localPath:resolve('/','import.xml'),defaultDirection:'pull',
    cloud:{documentId:token,url},createdAt:new Date().toISOString()}]);
  return url;
}
function inspectCloud(xml:string){
  const nodes=contentNodes(xml),parsed=parseDocxXML(xml);
  function visit(items:(ContentNode|string)[]){for(const node of items){
    if(typeof node==='string')continue;
    // A fetched document must never acquire access to a coincidentally named
    // private vault file, even when its local resource path stays in the vault.
    if(['img','source','whiteboard'].includes(node.tag)&&Object.hasOwn(node.attrs,'path'))
      fail('云端 XML 含本地资源 path，不能自动关联仓库文件；请使用带官方 token 的云端资源。','UNSAFE_RESOURCE');
    visit(node.children);
  }}visit(nodes);
  const text=(items:(ContentNode|string)[]):string=>items.map(node=>typeof node==='string'?node:text(node.children)).join('');
  return {title:text(nodes.find(node=>node.tag==='title')?.children||[]).trim(),warnings:parsed.warnings};
}

export async function prepareCloudImport(vaultRoot:string,input:{url:string;path:string},store:ProjectStore,transport:ContentTransport,active:()=>void):Promise<ImportPlan>{
  active();const target=await newTarget(vaultRoot,input.path),sourceURL=validateSourceURL(input.url);
  await checkDuplicates(store,target);
  const remote=await transport.fetch(sourceURL);active();
  const inspected=inspectCloud(remote.xml);
  validateProjectRegistrations([{id:'import-check',name:'导入',localPath:target.path,defaultDirection:'pull',
    cloud:{documentId:remote.documentId,url:remote.url},createdAt:new Date().toISOString()}]);
  await checkTarget(target);await checkDuplicates(store,target,remote.documentId);active();
  const view:PreparedImport=Object.freeze({xml:remote.xml,documentId:remote.documentId,title:inspected.title||basename(target.path,'.xml'),
    url:remote.url,path:target.path,vaultPath:target.vaultPath,expiresAt:new Date(Date.now()+300_000).toISOString(),warnings:Object.freeze([...inspected.warnings])});
  return {view,target,remote:structuredClone(remote),sourceURL};
}

/** Exclusive writes only. Partial results and source evidence remain available
 * for recovery; no failure path unlinks potentially user-modified documents. */
export async function importCloudDocument(plan:ImportPlan,store:ProjectStore,transport:ContentTransport,active:()=>void):Promise<ImportResult>{
  const {target,view}=plan;
  const current=()=>{active();if(Date.now()>Date.parse(view.expiresAt))fail('导入预览已过期，请重新预览。');};
  current();await checkTarget(target);await checkDuplicates(store,target,view.documentId);
  const remote=await transport.fetch(plan.sourceURL);current();
  if(remote.documentId!==plan.remote.documentId||remote.url!==plan.remote.url||remote.revision!==plan.remote.revision||remote.xml!==plan.remote.xml)
    fail('飞书文档内容、版本或关联已变化，请重新预览后导入。');
  inspectCloud(remote.xml);await checkTarget(target);await checkDuplicates(store,target,remote.documentId);current();
  const evidence=await mkdtemp(join(dirname(target.path),'.review-import-')),info=await lstat(evidence);
  const evidenceDirectory={path:evidence,dev:info.dev,ino:info.ino};
  const safe=async()=>{await checkDirectories({...target,directories:[...target.directories,evidenceDirectory]});};
  const write=async(path:string,text:string)=>{
    await safe();const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(text,'utf8');await file.sync();}finally{await file.close();}
    await safe();
    const directory=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await directory.sync();}finally{await directory.close();}
  };
  const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
  try{
    await write(join(evidence,'cloud.xml'),remote.xml);await write(join(evidence,'cloud.json'),json(remote));
    await write(join(evidence,'intent.json'),json({path:target.path,vaultPath:target.vaultPath,documentId:remote.documentId,createdAt:new Date().toISOString()}));
    const resources=await cacheContentResources(target.path,remote.xml,undefined,{download:async input=>{
      current();await checkTarget(target);const result=await transport.download(input);current();await checkTarget(target);return result;
    }},{directoryPrefix:'feishu-assets-'});
    const review=createReview(basename(target.path),remote.xml),warnings=[...view.warnings,...resources.warnings];
    review.resources=resources.resources;
    review.contentSync={version:1,documentId:remote.documentId,localXML:remote.xml,cloudXML:remote.xml,cloudRevision:remote.revision,syncedAt:new Date().toISOString(),localAssets:{}};
    review.operations.push({id:randomUUID(),type:'project.create',author:'我',at:new Date().toISOString(),summary:`从飞书导入新本地稿件；原文及恢复记录：${evidence}`});
    validateReview(review,basename(target.path));const raw=json(review);
    await write(join(evidence,'local.review.json'),raw);
    // Resource downloads may take minutes. Re-read the cloud and revalidate all
    // targets immediately before making the new document discoverable.
    const latest=resources.resources.items.length?await transport.fetch(plan.sourceURL):remote;current();
    if(latest.documentId!==remote.documentId||latest.url!==remote.url||latest.revision!==remote.revision||latest.xml!==remote.xml)
      fail('资源下载期间飞书文档已变化，请重新预览后导入。');
    await checkTarget(target);await checkDuplicates(store,target,remote.documentId);current();
    await write(target.path,remote.xml);active();await write(target.reviewPath,raw);
    const file=await openLocalFile(target.path,{readOnly:true}),snapshot=await file.read();
    if(snapshot.xml!==remote.xml||JSON.stringify(snapshot.review)!==JSON.stringify(review))fail('新文件在导入期间被修改，已保留双方内容，请核对恢复记录。');
    active();
    const project=await store.register({name:view.title.slice(0,200),localPath:target.path,defaultDirection:'pull',cloud:{documentId:remote.documentId,url:remote.url}});
    // Registration is durable. Failure to save an extra receipt must not turn
    // successful import into an invitation to create the same document again.
    try{await write(join(evidence,'completed.json'),json({project,vaultPath:target.vaultPath}));}
    catch{warnings.push('文档及项目已建立，完成回执未写入；请保留原文恢复记录。');}
    return {project,vaultPath:target.vaultPath,warnings,evidencePath:evidence};
  }catch(error){
    try{
      await write(join(evidence,'error.json'),json({message:error instanceof Error?error.message:'导入未完成',code:error instanceof FileError?error.code:undefined}));
      if(error instanceof ContentCLIError&&error.receipt)await write(join(evidence,'cli-error.json'),json(error.receipt));
    }catch{/* A changed evidence directory must never redirect recovery writes. */}
    throw new FileError(`${error instanceof Error?error.message:'导入未完成'} 已保留原文和恢复记录：${evidence}。请核对目标文件后重新预览；已有文件不会被覆盖。`,error instanceof FileError?error.code:'IMPORT_INCOMPLETE');
  }
}
