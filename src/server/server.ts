import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { DocumentHandle, Review } from '../core/types';
import { openLocalFile, FileError, type FileHooks } from './files';
import { syncCloudComments, type CloudConnection } from './cloud-sync';
import type { ProjectStore } from './projects';
import type { ContentTransport } from './content-cli';
import type { ReviewProject } from '../core/projects';
import { createReviewProject } from './project-create';
import { bindReviewProject } from './project-bind';
import { prepareContent, applyContent, type PreparedContent } from './content-sync';

const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.ico':'image/x-icon'};
interface Options {
  fileHooks?: FileHooks; picker?: () => Promise<string | null>; cloud?:CloudConnection;
  projects?:{store:ProjectStore;transport?:ContentTransport;comments?:(project:ReviewProject)=>CloudConnection|undefined;historyRoot:string};
  projectSettings?:{
    read():Promise<{shared:boolean;path:string}>;
    setShared(enabled:boolean,path?:string):Promise<{shared:boolean;path:string}>;
    defaultSharedPath:string;
  };
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 30_000_000) throw new FileError('保存内容过大。', 'TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string,unknown>;
  } catch { throw new FileError('请求需要 JSON 对象。', 'INVALID_REQUEST', 400); }
}
async function pickXML() {
  try {
    const {stdout} = await promisify(execFile)('/usr/bin/osascript', ['-e', 'POSIX path of (choose file with prompt "选择要编辑的 XML 文档")']);
    return stdout.replace(/\r?\n$/, '');
  } catch (error) {
    if (String((error as Error).message).includes('(-128)')) return null;
    throw new FileError('文件选择窗口未能打开，请稍后重试。', 'PICKER_FAILED', 500);
  }
}

export async function createLocalServer(staticRoot: string, initialPath: string, options: Options = {}) {
  const root = await realpath(staticRoot);
  await stat(resolve(root, 'index.html'));
  const csrf = randomUUID();
  const documents = new Map<string,Awaited<ReturnType<typeof openLocalFile>>>();
  const canonical = new Map<string,DocumentHandle>();
  const openings = new Map<string,Promise<DocumentHandle>>();
  async function openDocument(input: string): Promise<DocumentHandle> {
    if (!input || !isAbsolute(input) || !/\.xml$/i.test(input)) throw new FileError('需要 XML 文件完整路径。', 'INVALID_PATH', 400);
    let path: string;
    try { path = await realpath(input); } catch { throw new FileError('XML 文件不存在或不可读取。', 'NOT_FOUND', 404); }
    const existing = canonical.get(path);
    if (existing) { await documents.get(existing.id)!.read(); return existing; }
    const active = openings.get(path);
    if (active) return active;
    const promise = (async () => {
      const file = await openLocalFile(input, options.fileHooks);
      const handle = {id:randomUUID(), name:file.name, path:file.path, reviewPath:file.reviewPath};
      documents.set(handle.id, file); canonical.set(file.path, handle);
      return handle;
    })();
    openings.set(path, promise);
    try { return await promise; } finally { openings.delete(path); }
  }
  let current = await openDocument(initialPath);
  if(options.projects){
    const store=options.projects.store;
    const entries=await store.list(),existing=entries.find(p=>p.localPath===current.path);
    if(!existing)await store.register({name:current.name.replace(/\.xml$/i,''),localPath:current.path,defaultDirection:'pull',
      ...(options.cloud?.localPath===current.path?{cloud:{documentId:options.cloud.documentId,url:options.cloud.url}}:{})});
    else if(options.cloud?.localPath===current.path&&existing.cloud?.documentId!==options.cloud.documentId)
      throw new FileError('启动关联与已有项目索引不一致，请核对配置。','CLOUD_BINDING');
  }
  async function currentProject(path=current.path){return (await options.projects?.store.list())?.find(p=>p.localPath===path);}
  async function connection(path:string){
    if(options.projects){const project=await currentProject(path);return project?options.projects.comments?.(project):undefined;}
    return options.cloud?.localPath===path?options.cloud:undefined;
  }
  async function session(handle=current){
    const project=await currentProject(handle.path),linked=await connection(handle.path);
    const cloud=linked?{url:linked.url,documentId:linked.documentId,localPath:linked.localPath}:undefined;
    return {csrf,document:handle,homeDirectory:homedir(),nativePicker:process.platform==='darwin'||!!options.picker,...(project?{project}:{}),...(cloud?{cloud}:{})};
  }
  async function openedProject(project:ReviewProject,warning?:string){
    const handle=await openDocument(project.localPath);
    const snapshot=await documents.get(handle.id)!.read();
    current=handle;
    return {session:await session(handle),snapshot,projects:await options.projects!.store.list(),...(warning?{warning}:{})};
  }
  const previews=new Map<string,PreparedContent>();
  let creating=false;
  let openingRequests=0;
  let picking = false;
  const syncing=new Set<string>();
  const server = createServer(async (request, response) => {
    const port = (server.address() as {port:number}).port;
    const host = `127.0.0.1:${port}`;
    const origin = `http://${host}`;
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site')
        throw new FileError('仅允许本机同源页面访问。', 'FORBIDDEN', 403);
      const url = new URL(request.url || '/', origin);
      if (url.pathname.startsWith('/api/')) {
        const mutation = request.method !== 'GET';
        if (mutation && (request.headers['x-csrf-token'] !== csrf || request.headers['content-type']?.split(';')[0].trim() !== 'application/json'))
          throw new FileError('请求未授权或格式不正确。', 'FORBIDDEN', 403);
        if (request.method === 'GET' && url.pathname === '/api/session') {
          json(response,await session()); return;
        }
        if(options.projectSettings&&options.projects&&url.pathname==='/api/project-settings'){
          const settings=options.projectSettings;
          if(request.method==='GET'){json(response,{...await settings.read(),defaultSharedPath:settings.defaultSharedPath});return;}
          if(request.method==='POST'){
            const input=await body(request);
            if(typeof input.shared!=='boolean'||input.path!==undefined&&typeof input.path!=='string'||Object.keys(input).some(k=>!['shared','path'].includes(k)))
              throw new FileError('项目管理设置不正确。','INVALID_REQUEST',400);
            if(creating||openingRequests||syncing.size)throw new FileError('请等待当前项目创建或同步完成，再切换管理目录。','PROJECT_BUSY');
            if(!(await currentProject()))throw new FileError('请先选择已登记的项目，再切换管理目录。','PROJECT_REQUIRED');
            if(creating||openingRequests||syncing.size)throw new FileError('请等待当前项目创建或同步完成，再切换管理目录。','PROJECT_BUSY');
            creating=true;
            try{
              const path=current.path,value=await settings.setShared(input.shared,input.path as string|undefined);
              const project=(await options.projects.store.list()).find(p=>p.localPath===path);
              if(!project)throw new FileError('新管理目录中找不到当前稿件，请核对项目索引。','PROJECT_FORMAT');
              json(response,{...await openedProject(project),settings:{...value,defaultSharedPath:settings.defaultSharedPath}});
            }finally{creating=false;}
            return;
          }
        }
        if(options.projects&&url.pathname==='/api/projects'){
          const {store,transport,historyRoot}=options.projects;
          if(request.method==='GET'){
            const projects=await store.list();
            json(response,{projects,activeProjectId:projects.find(p=>p.localPath===current.path)?.id,cloudAvailable:!!transport});return;
          }
          if(request.method==='POST'){
            const input=await body(request);
            if(creating||openingRequests||syncing.size||picking)throw new FileError('正在创建、关联或同步项目，请等待本次完成。','PROJECT_BUSY');
            creating=true;
            try{
              const result=await createReviewProject(input,store,transport,historyRoot,{adoptPublished:true});
              json(response,await openedProject(result.project,result.warning));
            }finally{creating=false;}
            return;
          }
        }
        const projectRoute=/^\/api\/projects\/([A-Za-z0-9_-]+)\/(open|preview|sync|bind)$/.exec(url.pathname);
        if(options.projects&&projectRoute&&request.method==='POST'){
          const {store,transport,historyRoot}=options.projects;
          const input=await body(request);
          if(projectRoute[2]==='bind'){
            if(creating||openingRequests||syncing.size||picking)throw new FileError('项目正在创建、切换或同步，请等待完成后再关联。','PROJECT_BUSY');
            creating=true;
            let bindingPath:string|undefined;
            try{
              const project=await store.get(projectRoute[1]);
              if(!project)throw new FileError('项目不存在。','NOT_FOUND',404);
              bindingPath=project.localPath;syncing.add(bindingPath);
              const handle=await openDocument(project.localPath),file=documents.get(handle.id)!;
              const result=await bindReviewProject(input,project,file,store,transport,historyRoot,{adoptPublished:true});
              previews.clear();
              json(response,await openedProject(result.project,result.warning));
            }finally{if(bindingPath)syncing.delete(bindingPath);creating=false;}
            return;
          }
          const project=await store.get(projectRoute[1]);
          if(!project)throw new FileError('项目不存在。','NOT_FOUND',404);
          if(projectRoute[2]==='open'){
            if(Object.keys(input).length)throw new FileError('打开项目参数不正确。','INVALID_REQUEST',400);
            if(creating||openingRequests||syncing.size)throw new FileError('项目正在创建、关联或同步，请等待完成后再切换。','PROJECT_BUSY');
            creating=true;
            try{json(response,await openedProject(project));}finally{creating=false;}
            return;
          }
          if(!transport||!project.cloud)throw new FileError('这个项目尚未配置飞书同步。','CLOUD_UNAVAILABLE',400);
          const handle=await openDocument(project.localPath),file=documents.get(handle.id)!;
          if(creating||openingRequests)throw new FileError('项目管理信息正在切换，请稍后再同步。','PROJECT_BUSY');
          if(syncing.has(file.path))throw new FileError('当前稿件正在同步，请等待完成。','CLOUD_BUSY');
          if(projectRoute[2]==='preview'){
            if(typeof input.revision!=='string'||!['pull','push'].includes(input.direction as string)||Object.keys(input).some(k=>!['revision','direction'].includes(k)))
              throw new FileError('预览参数不正确。','INVALID_REQUEST',400);
            const prepared=await prepareContent(file,project,input.revision,input.direction as 'pull'|'push',transport);
            for(const [key,value] of previews)if(Date.parse(value.view.expiresAt)<=Date.now())previews.delete(key);
            if(previews.size>=100)previews.delete(previews.keys().next().value!);
            previews.set(prepared.view.id,prepared);json(response,prepared.view);return;
          }
          if(typeof input.previewId!=='string'||(input.adoptPublished!==undefined&&typeof input.adoptPublished!=='boolean')||Object.keys(input).some(k=>!['previewId','adoptPublished'].includes(k)))throw new FileError('同步参数不正确。','INVALID_REQUEST',400);
          const prepared=previews.get(input.previewId);
          if(!prepared||prepared.view.projectId!==project.id)throw new FileError('预览不存在或属于其他项目，请重新预览。','CONFLICT');
          previews.delete(input.previewId);syncing.add(file.path);
          try{json(response,await applyContent(file,project,prepared,transport,historyRoot,{adoptPublished:input.adoptPublished===true}));}
          finally{syncing.delete(file.path);}
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/open') {
          const input = await body(request);
          if (typeof input.path !== 'string') throw new FileError('需要文章完整路径。', 'INVALID_PATH', 400);
          if(creating||syncing.size)throw new FileError('项目正在创建、关联或同步，请等待完成后再切换。','PROJECT_BUSY');
          // Concurrent opens share the canonical handle promise. Keep their
          // barrier separate from exclusive project mutations until all finish.
          openingRequests++;
          try{current = await openDocument(input.path); json(response,current);}finally{openingRequests--;}
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/pick') {
          await body(request);
          if(creating||openingRequests||syncing.size)throw new FileError('项目正在创建、关联或同步，请等待完成后再选文件。','PROJECT_BUSY');
          if (process.platform !== 'darwin' && !options.picker) throw new FileError('当前系统请填写文档完整路径。', 'PICKER_UNAVAILABLE', 400);
          if (picking) throw new FileError('文件选择窗口已经打开。', 'PICKER_BUSY');
          picking = true;
          try {
            const path = await (options.picker || pickXML)();
            if (path === null) json(response,null);
            else { current = await openDocument(path); json(response,current); }
          } finally { picking = false; }
          return;
        }
        if (url.pathname === '/api/document' || url.pathname === '/api/asset' || url.pathname === '/api/resource' || url.pathname === '/api/cloud-sync') {
          const file = documents.get(url.searchParams.get('id') || '');
          if (!file) throw new FileError('文档会话不存在，请重新打开文档。', 'NOT_FOUND', 404);
          if(url.pathname==='/api/cloud-sync'&&request.method==='POST'){
            const input=await body(request);
            const cloud=await connection(file.path);
            if(!cloud)throw new FileError('这份稿件尚未关联飞书文档。','CLOUD_BINDING',403);
            if(typeof input.revision!=='string'||Object.keys(input).some(key=>key!=='revision'))throw new FileError('同步参数不正确。','INVALID_REQUEST',400);
            if(creating||openingRequests)throw new FileError('项目管理信息正在切换，请稍后再同步。','PROJECT_BUSY');
            if(syncing.has(file.path))throw new FileError('当前稿件正在同步，请等待完成。','CLOUD_BUSY',409);
            syncing.add(file.path);
            try{json(response,await syncCloudComments(file,input.revision,cloud));}finally{syncing.delete(file.path);}
            return;
          }
          if (url.pathname === '/api/document' && request.method === 'GET') { json(response,await file.read()); return; }
          if (url.pathname === '/api/document' && request.method === 'PUT') {
            if(syncing.has(file.path))throw new FileError('当前稿件正在同步，输入仍保留，请稍后保存。','CLOUD_BUSY',409);
            const input = await body(request);
            if(syncing.has(file.path))throw new FileError('当前稿件正在同步，输入仍保留，请稍后保存。','CLOUD_BUSY',409);
            if (typeof input.xml !== 'string' || typeof input.revision !== 'string') throw new FileError('保存参数不正确。', 'INVALID_REQUEST', 400);
            json(response,await file.save(input.xml,input.review as Review,input.revision)); return;
          }
          if (url.pathname === '/api/asset' && request.method === 'GET') {
            const image = await file.asset(url.searchParams.get('path') || '');
            response.writeHead(200,{'Content-Type':mime[image.extension]}); response.end(image.data); return;
          }
          if (url.pathname === '/api/resource' && request.method === 'GET') {
            json(response,await file.resource(url.searchParams.get('path') || '')); return;
          }
        }
        throw new FileError('接口不存在。', 'NOT_FOUND', 404);
      }
      if (!['GET','HEAD'].includes(request.method || '')) throw new FileError('请求方法不支持。', 'METHOD_NOT_ALLOWED', 405);
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new FileError('路径编码不正确。', 'INVALID_PATH', 400); }
      const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!target.startsWith(root + sep)) throw new FileError('路径越界。', 'FORBIDDEN', 403);
      let file: string;
      try { file = await realpath(target); } catch { throw new FileError('文件不存在。', 'NOT_FOUND', 404); }
      if (!file.startsWith(root + sep)) throw new FileError('静态文件路径越界。', 'FORBIDDEN', 403);
      const data = await readFile(file);
      response.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream'});
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof FileError) json(response,{error:error.message,code:error.code},error.status);
      else json(response,{error:'本地文件操作失败，请检查文件是否仍存在并可写。',code:'FILE_IO'},500);
    }
  });
  return server;
}
