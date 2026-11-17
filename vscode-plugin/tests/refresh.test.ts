import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const host=vi.hoisted(()=>({provider:undefined as any,watchers:[] as any[],textListeners:[] as any[],documents:[] as any[],files:new Map<string,string>()}));
vi.mock('vscode',()=>{
 class Uri{scheme='file';authority='';constructor(public path:string){}with(change:any){return Object.assign(new Uri(change.path??this.path),this,change);}toString(){return 'file://'+this.path;}static joinPath(root:Uri,path:string){return new Uri(root.path+'/'+path);}}
 class FileSystemError extends Error{code='FileNotFound';}
 const emitter=()=>{const handlers:Function[]=[];return{event:(fn:Function)=>{handlers.push(fn);return{dispose:vi.fn()};},fire:(event:unknown)=>handlers.forEach(fn=>fn(event))};};
 return {Uri,FileSystemError,FileType:{File:1,SymbolicLink:64},RelativePattern:class {constructor(public baseUri:any,public pattern:string){}},
  workspace:{get textDocuments(){return host.documents;},fs:{stat:async(uri:Uri)=>{const file=host.files.get(uri.path);if(file===undefined)throw new FileSystemError();return{type:1,size:new TextEncoder().encode(file).length,mtime:1};},readFile:async(uri:Uri)=>new TextEncoder().encode(host.files.get(uri.path))},
   createFileSystemWatcher:(pattern:any)=>{const change=emitter(),create=emitter(),remove=emitter();const watcher={pattern,dispose:vi.fn(),change,create,remove,onDidChange:change.event,onDidCreate:create.event,onDidDelete:remove.event};host.watchers.push(watcher);return watcher;},
   onDidChangeTextDocument:(fn:Function)=>{host.textListeners.push(fn);return{dispose(){}};}},
  window:{registerCustomEditorProvider:(_id:string,provider:any)=>{host.provider=provider;return{dispose(){}};}},commands:{registerCommand:()=>({dispose(){}})}};
});
import * as vscode from 'vscode';
import { activate } from '../src/extension';
beforeEach(()=>{vi.useFakeTimers();host.files.clear();host.watchers=[];host.documents=[];host.textListeners=[];});
afterEach(()=>vi.useRealTimers());
it('watches loose-file directories nonrecursively, refreshes source and comments, and releases subscriptions',async()=>{
 const uri=new (vscode.Uri as any)('/fixture/article.feishu.xml');host.files.set(uri.path,'<p>磁盘原文</p>');
 let message!:Function,dispose!:Function;const postMessage=vi.fn();
 const panel:any={webview:{asWebviewUri:(uri:any)=>uri,cspSource:'fixture',postMessage,onDidReceiveMessage:(fn:Function)=>{message=fn;return{dispose(){}};}},onDidChangeViewState:()=>({dispose(){}}),onDidDispose:(fn:Function)=>dispose=fn};
 activate({subscriptions:[],extensionUri:new (vscode.Uri as any)('/extension')} as any);await host.provider.resolveCustomEditor({uri},panel);
 expect(host.watchers[0].pattern.pattern).toBe('*');expect(host.watchers[0].pattern.baseUri.path).toBe('/fixture');
 message({type:'ready'});await vi.advanceTimersByTimeAsync(200);expect(postMessage.mock.lastCall?.[0].snapshot.xml).toBe('<p>磁盘原文</p>');
 host.documents=[{uri,isDirty:false,getText:()=>'<p>旧的缓存</p>'}];host.files.set(uri.path,'<p>外部更新</p>');
 host.watchers[0].change.fire(uri);await vi.advanceTimersByTimeAsync(200);expect(postMessage.mock.lastCall?.[0].snapshot.xml).toBe('<p>外部更新</p>');
 const sidecar=new (vscode.Uri as any)('/fixture/article.feishu.review.json');host.files.set(sidecar.path,JSON.stringify({format:'lark-review',version:1,comments:[{author:'读者',body:'新增评论'}]}));
 host.watchers[0].create.fire(sidecar);await vi.advanceTimersByTimeAsync(200);expect(postMessage.mock.lastCall?.[0].snapshot.review.comments[0].body).toBe('新增评论');
 const count=postMessage.mock.calls.length;host.watchers[0].change.fire(new (vscode.Uri as any)('/fixture/unrelated'));await vi.advanceTimersByTimeAsync(200);expect(postMessage).toHaveBeenCalledTimes(count);
 host.documents[0]={uri,isDirty:true,getText:()=>'<p>未保存源码</p>'};host.textListeners[0]({document:host.documents[0]});await vi.advanceTimersByTimeAsync(200);expect(postMessage.mock.lastCall?.[0].snapshot.xml).toBe('<p>未保存源码</p>');
 dispose();expect(host.watchers[0].dispose).toHaveBeenCalled();
});
