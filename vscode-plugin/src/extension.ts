import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { makeSnapshot, reviewName, referencedResources } from './snapshot';
import { localResourcePath } from '../../src/core/project-files';

const VIEW='feishuDoc.reader',LEGACY='feishuDoc.legacyReader';
const decode=(data:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(data);
function sibling(uri:vscode.Uri,name:string){return uri.with({path:posix.join(posix.dirname(uri.path),name)});}
export async function readSafe(uri:vscode.Uri,limit:number,root?:vscode.Uri):Promise<Uint8Array>{
  if(!['file','vscode-remote'].includes(uri.scheme))throw Error('仅支持本地或远程工作区文件。');
  if(root){
    if(uri.scheme!==root.scheme||uri.authority!==root.authority)throw Error('资源越界');
    const relative=posix.relative(root.path,uri.path);if(!localResourcePath(relative))throw Error('资源越界');
    const parts=relative.split('/');let cursor=root;
    for(const part of parts){cursor=vscode.Uri.joinPath(cursor,part);const stat=await vscode.workspace.fs.stat(cursor);if(stat.type&vscode.FileType.SymbolicLink)throw Error('不读取符号链接资源');}
  }
  const before=await vscode.workspace.fs.stat(uri);
  if(before.type!==vscode.FileType.File||before.size>limit)throw Error('文件类型或大小不受支持');
  const data=await vscode.workspace.fs.readFile(uri);const after=await vscode.workspace.fs.stat(uri);
  if(data.length>limit||before.size!==after.size||before.mtime!==after.mtime||after.type!==vscode.FileType.File)throw Error('文件读取时已改变，请刷新');
  return data;
}
function shell(webview:vscode.Webview,extension:vscode.Uri){
  const nonce=randomBytes(18).toString('hex');const asset=(name:string)=>webview.asWebviewUri(vscode.Uri.joinPath(extension,'dist',name)).toString();
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${asset('webview.css')}"></head><body><header class="reader-toolbar"><strong>飞书文档</strong><span class="reader-badge">只读</span><span id="reader-status" role="status">正在读取…</span><button id="reader-refresh" title="重新读取当前文档、评论和本地资源">刷新</button><button id="reader-source" title="使用 VS Code 文本编辑器查看当前 XML 源码">查看源码</button></header><div class="reader-layout"><nav id="reader-outline" aria-label="文章目录"></nav><main><div id="reader-notices" role="status"></div><article id="reader-document" aria-label="飞书文档"></article><section id="reader-comments" aria-label="已有评论"></section></main></div><script nonce="${nonce}" src="${asset('webview.js')}"></script></body></html>`;
}
class Reader implements vscode.CustomReadonlyEditorProvider {
  constructor(private context:vscode.ExtensionContext){}
  async openCustomDocument(uri:vscode.Uri){if(!['file','vscode-remote'].includes(uri.scheme))throw Error('请选择工作区中的 XML 文件。');return {uri,dispose(){}};}
  async resolveCustomEditor(document:vscode.CustomDocument,panel:vscode.WebviewPanel){
    const uri=document.uri,root=uri.with({path:posix.dirname(uri.path)}),sidecar=sibling(uri,reviewName(posix.basename(uri.path)));
    panel.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'dist')]};
    let disposed=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined;
    let watched=new Set([uri.toString(),sidecar.toString()]);
    const directoryWatchers=new Map<string,vscode.Disposable[]>();
    const refresh=async()=>{
      const id=++generation;
      try{
        const opened=vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
        const xml=opened?.isDirty?opened.getText():decode(await readSafe(uri,5_000_000));
        let review:string|undefined;let reviewError=false;
        try{review=decode(await readSafe(sidecar,20_000_000,root));}catch(e){if(!(e instanceof vscode.FileSystemError&&e.code==='FileNotFound'))reviewError=true;}
        const snapshot=await makeSnapshot(xml,review,(path,limit)=>readSafe(vscode.Uri.joinPath(root,path),limit,root));
        if(disposed||id!==generation)return;
        const resources=referencedResources(xml,snapshot.review).map(path=>vscode.Uri.joinPath(root,path));
        watched=new Set([uri.toString(),sidecar.toString(),...resources.map(resource=>resource.toString())]);
        watchDirectories([root,...resources.map(resource=>resource.with({path:posix.dirname(resource.path)}))]);
        if(reviewError)snapshot.warnings.push('评论文件无法读取，正文仍可阅读。');
        await panel.webview.postMessage({type:'document',name:posix.basename(uri.path),snapshot});
      }catch(e){if(!disposed&&id===generation)await panel.webview.postMessage({type:'error',message:e instanceof Error?e.message:'文档无法读取'});}
    };
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void refresh(),180);};
    const changed=(changed:vscode.Uri)=>{if(watched.has(changed.toString()))schedule();};
    // Nonrecursive directory watches also work for loose files outside a
    // workspace, and avoid subscribing to an entire project tree.
    const watchDirectories=(directories:vscode.Uri[])=>{
      const wanted=new Set(directories.map(directory=>directory.toString()));
      for(const [key,listeners] of directoryWatchers)if(!wanted.has(key)){listeners.forEach(d=>d.dispose());directoryWatchers.delete(key);}
      for(const directory of directories){
        const key=directory.toString();if(directoryWatchers.has(key))continue;
        const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory,'*'));
        directoryWatchers.set(key,[watcher,watcher.onDidChange(changed),watcher.onDidCreate(changed),watcher.onDidDelete(changed)]);
      }
    };
    watchDirectories([root]);
    const listeners=[
      vscode.workspace.onDidChangeTextDocument(e=>{if(e.document.uri.toString()===uri.toString())schedule();}),
      panel.onDidChangeViewState(e=>{if(e.webviewPanel.visible)schedule();}),
      panel.webview.onDidReceiveMessage(async message=>{
        if(message?.type==='ready'||message?.type==='refresh')schedule();
        else if(message?.type==='source')await vscode.commands.executeCommand('vscode.openWith',uri,'default');
      })];
    panel.onDidDispose(()=>{disposed=true;generation++;clearTimeout(timer);listeners.forEach(d=>d.dispose());for(const entries of directoryWatchers.values())entries.forEach(d=>d.dispose());directoryWatchers.clear();});
    panel.webview.html=shell(panel.webview,this.context.extensionUri);
  }
}
export function activate(context:vscode.ExtensionContext){
  const reader=new Reader(context);
  context.subscriptions.push(...[VIEW,LEGACY].map(id=>vscode.window.registerCustomEditorProvider(id,reader,{supportsMultipleEditorsPerDocument:true})),
    vscode.commands.registerCommand('feishuDoc.preview',async (uri?:vscode.Uri)=>{
      uri=uri||vscode.window.activeTextEditor?.document.uri;
      if(!uri){const picked=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'飞书 XML':['xml']}});uri=picked?.[0];}
      if(uri)await vscode.commands.executeCommand('vscode.openWith',uri,/\.feishu\.xml$/i.test(uri.path)?VIEW:LEGACY);
    }));
}
