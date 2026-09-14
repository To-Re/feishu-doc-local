import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { FolderOpen, Plus, PencilLine, BookOpen, Code, MessageSquarePlus, MessageSquare, Bold, Italic, List, Quote, Copy, Check, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Reader, FormulaEditor } from '../ui/Reader';
import { ProjectExplorer, ResourcePreview, type ResourceScrollPosition } from '../ui/ProjectExplorer';
import { projectFiles, type ProjectFile } from '../core/project-files';
import { locateWhiteboardComponent } from '../ui/whiteboard-comments';
import { SourceEditor } from '../ui/SourceEditor';
import { WhiteboardEditor } from '../ui/WhiteboardEditor';
import { DocumentOutline, scrollToHeading } from '../ui/DocumentOutline';
import type { SourceDraftSnapshot } from '../ui/source-drafts';
import { containDialogFocus } from '../ui/Projects';
import { displayAuthor } from '../ui/comment-author';
import { invalidateAnchors } from '../core/anchors';
import { parseDocxXML } from '../core/docxml';
import { RESOURCE_REFRESH } from '../core/resources';
import { createReview, uid, type Anchor, type Review, type ReviewComment, type Snapshot } from '../core/types';
import { chooseBrowserDirectory, type BrowserDocument, type BrowserDocumentStore } from './files';
import type { EditorController, EditorHost, EditorRecovery } from './host';
import '../ui/styles.css';
import 'katex/dist/katex.min.css';
import './browser.css';

const example='<title>先在本地，把文章改好</title>\n<p>选择一个本地目录，打开或新建 XML。正文会保存到原文件，评论会写入旁边的 .review.json，AI 可以直接读取。</p>\n<h1>一份可以一起修改的文章</h1>\n<p>可以直接编辑正文，也可以选中一段文字留下意见。需要检查格式时，切换到源码模式。</p>\n<table><tr><th><p>文件</p></th><th><p>内容</p></th></tr><tr><td><p>文章.xml</p></td><td><p>正文与格式</p></td></tr><tr><td><p>文章.review.json</p></td><td><p>评论与修改记录</p></td></tr></table>\n<p>公式示例：<latex>E=mc^2</latex></p>';
interface Draft {document:BrowserDocument|null;xml:string;review:Review;revision:string;resourceRevision:string;version:number;savedVersion:number;}
const demo=():Draft=>({document:null,xml:example,review:createReview('只读示例.xml',example),revision:'',resourceRevision:'',version:0,savedVersion:0});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

export function BrowserApp({host}:{host?:EditorHost}={}) {
  const hostRef=useRef(host);hostRef.current=host;
  const hostToolbar=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(hostToolbar.current)return host?.mountToolbar?.(hostToolbar.current);},[host]);
  const initialRecovery=useRef(host?.initial.recovery?.path===host?.initial.document.handle.path?host?.initial.recovery:null).current;
  const [draft,setDraftState]=useState<Draft>(()=>{
    if(!host)return demo();const base=normalize(host.initial.document,host.initial.snapshot);
    return initialRecovery?{...base,xml:initialRecovery.xml,review:initialRecovery.review,revision:initialRecovery.revision,version:initialRecovery.dirty?1:0}:base;
  }),current=useRef(draft);
  const [store,setStoreState]=useState<BrowserDocumentStore|null>(host?.initial.store||null),storeRef=useRef(store);
  const [documents,setDocuments]=useState<string[]>([]),[viewKey,setViewKey]=useState(0);
  const [mode,setMode]=useState<'edit'|'read'|'source'>(initialRecovery?.invalidSource?'source':host?'edit':'read'),modeRef=useRef(mode);modeRef.current=mode;
  const [editor,setEditor]=useState<Editor|null>(null),editorRef=useRef(editor);editorRef.current=editor;
  const [busy,setBusyState]=useState(false),busyRef=useRef(false);
  const [hostLocked,setHostLockedState]=useState(false),hostLockedRef=useRef(false),syncActive=useRef(false);
  const [saving,setSavingState]=useState(false),savingRef=useRef(false);
  const initialConflict=!!initialRecovery&&initialRecovery.revision!==host?.initial.snapshot.revision;
  const [error,setError]=useState(initialConflict?'恢复草稿之后，本地文件已发生修改。草稿已保留，请核对后再重新读取。':''),[notice,setNotice]=useState(''),[permissionDenied,setPermissionDenied]=useState(false);
  const [conflict,setConflictState]=useState(initialConflict),conflictRef=useRef(initialConflict);
  const autoPaused=useRef(initialConflict),mounted=useRef(true),saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const saveInFlight=useRef<Promise<boolean>|null>(null),persistTail=useRef<Promise<void>>(Promise.resolve()),persistSignature=useRef<string|null>(null);
  const [selection,setSelection]=useState<Anchor|null>(null);
  const [pending,setPendingState]=useState<Anchor|null>(initialRecovery?.pending||null),pendingRef=useRef(pending);
  const [commentText,setCommentTextState]=useState(initialRecovery?.comment||''),commentTextRef=useRef(commentText);
  const [replyDrafts,setReplyDraftsState]=useState<Record<string,string>>(initialRecovery?.replies||{}),replyDraftsRef=useRef(replyDrafts);
  const [invalidSource,setInvalidSourceState]=useState<{value:string;error:string}|null>(initialRecovery?.invalidSource||null),invalidSourceRef=useRef(invalidSource);
  const sourceSnapshots=useRef({formula:initialRecovery?.formula||[] as SourceDraftSnapshot,whiteboard:initialRecovery?.whiteboard||[] as SourceDraftSnapshot});
  const sourceDrafts=useRef({formula:!!sourceSnapshots.current.formula.length,whiteboard:!!sourceSnapshots.current.whiteboard.length});
  const [sourceRevision,setSourceRevision]=useState(0);
  const [sourceDirty,setSourceDirty]=useState(false);
  const [sidebarTab,setSidebarTab]=useState<'files'|'outline'>(host?'outline':'files'),[navigationCollapsed,setNavigationCollapsed]=useState(false);
  const navigationId=useId();
  const [selectedResource,setSelectedResource]=useState<string|null>(null),resourcePositions=useRef(new Map<string,ResourceScrollPosition>());
  const [showResolved,setShowResolved]=useState(false),[replyOpen,setReplyOpen]=useState<Record<string,boolean>>({});
  const [commentsOpen,setCommentsOpen]=useState(true),commentsPanel=useRef<HTMLElement>(null),commentsId=useId();
  const [copiedPath,setCopiedPath]=useState('');
  const [createOpen,setCreateOpen]=useState(false),[newName,setNewName]=useState(''),[newTitle,setNewTitle]=useState(''),[createError,setCreateError]=useState('');
  const createDialog=useRef<HTMLFormElement>(null);
  const supported=typeof (window as Window&{showDirectoryPicker?:unknown}).showDirectoryPicker==='function';
  const saveRef=useRef<()=>Promise<boolean>>(async()=>false);

  function setDraft(next:Draft){current.current=next;setDraftState(next);}
  function updateEditable(){const editor=editorRef.current;if(editor&&!editor.isDestroyed)editor.setEditable(!busyRef.current&&!hostLockedRef.current&&!!current.current.document&&modeRef.current==='edit'&&!invalidSourceRef.current);}
  function setBusy(value:boolean){busyRef.current=value;setBusyState(value);updateEditable();}
  function setHostLocked(value:boolean){hostLockedRef.current=value;setHostLockedState(value);updateEditable();}
  function setConflict(value:boolean){conflictRef.current=value;setConflictState(value);}
  function setPending(value:Anchor|null){pendingRef.current=value;setPendingState(value);}
  function setCommentText(value:string){commentTextRef.current=value;setCommentTextState(value);}
  function setReplies(value:Record<string,string>){replyDraftsRef.current=value;setReplyDraftsState(value);}
  function setInvalidSource(value:typeof invalidSource){invalidSourceRef.current=value;setInvalidSourceState(value);}
  function hasDrafts(){return !!invalidSourceRef.current||!!pendingRef.current||!!commentTextRef.current.trim()||Object.values(replyDraftsRef.current).some(value=>value.trim())||sourceDrafts.current.formula||sourceDrafts.current.whiteboard||!!sourceSnapshots.current.formula.length||!!sourceSnapshots.current.whiteboard.length;}
  const formulaDraftChanged=useCallback((value:boolean)=>{sourceDrafts.current.formula=value;setSourceDirty(value||sourceDrafts.current.whiteboard);},[]);
  const whiteboardDraftChanged=useCallback((value:boolean)=>{sourceDrafts.current.whiteboard=value;setSourceDirty(value||sourceDrafts.current.formula);},[]);
  const sourceSnapshotChanged=useCallback((kind:'formula'|'whiteboard',value:SourceDraftSnapshot)=>{
    if(JSON.stringify(sourceSnapshots.current[kind])===JSON.stringify(value))return;
    sourceSnapshots.current[kind]=value;setSourceRevision(revision=>revision+1);
  },[]);
  function scheduleSave(){if(saveTimer.current)clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>void saveRef.current(),550);}
  function change(xml:string,review:Review,summary:string,type='document.edit'){
    const start=current.current;if(!start.document||busyRef.current||hostLockedRef.current)return;
    const now=new Date().toISOString();
    const operations=type==='document.edit'?review.operations.filter(operation=>operation.id!=='browser-current-edit'):review.operations;
    setDraft({...start,xml,version:start.version+1,review:{...review,document:{...review.document,xml,updatedAt:now},operations:[...operations,{id:type==='document.edit'?'browser-current-edit':uid(),type,author:'我',at:now,summary}]}});
    scheduleSave();
  }
  function normalize(document:BrowserDocument,snapshot:Snapshot):Draft {
    parseDocxXML(snapshot.xml);
    const review=snapshot.review||createReview(document.handle.name,snapshot.xml);
    const changedOutside=review.document.xml!==snapshot.xml;
    return{document,xml:snapshot.xml,review:changedOutside?{...review,comments:invalidateAnchors(review.comments),document:{...review.document,xml:snapshot.xml}}:review,revision:snapshot.revision,resourceRevision:document.resourceRevision,version:0,savedVersion:0};
  }
  function accept(next:Draft,newDocument=false){
    sourceSnapshots.current={formula:[],whiteboard:[]};sourceDrafts.current={formula:false,whiteboard:false};setSourceDirty(false);
    setDraft(next);setSelection(null);setPending(null);setCommentText('');setReplies({});setInvalidSource(null);setConflict(false);setError('');setPermissionDenied(false);autoPaused.current=false;
    if(newDocument){setSelectedResource(null);setCopiedPath('');setReplyOpen({});setShowResolved(false);setViewKey(value=>value+1);setMode(next.document?'edit':'read');modeRef.current=next.document?'edit':'read';}
  }
  async function performSave():Promise<boolean>{
    const sent=current.current;
    if(!sent.document||sent.version===sent.savedVersion)return true;
    if(savingRef.current||busyRef.current||invalidSourceRef.current||conflictRef.current||autoPaused.current)return false;
    savingRef.current=true;setSavingState(true);
    try{
      const saved=await sent.document.save(sent.xml,sent.review,sent.revision);
      if(!mounted.current||current.current.document!==sent.document)return false;
      const live=current.current;
      const resourceRevision=sent.document.resourceRevision;
      setDraft({...live,revision:saved.revision,resourceRevision,savedVersion:sent.version,...(live.version===sent.version?{review:saved.review||live.review}: {})});
      if(resourceRevision!==live.resourceRevision)refreshResources();setError('');
      return true;
    }catch(failure){
      if(mounted.current&&current.current.document===sent.document){setError(message(failure));autoPaused.current=true;setPermissionDenied(isPermissionError(failure));
        if(typeof failure==='object'&&failure!==null&&'status'in failure&&failure.status===409)setConflict(true);}
      return false;
    }finally{
      savingRef.current=false;if(mounted.current)setSavingState(false);
      if(mounted.current&&current.current.document===sent.document&&current.current.version!==current.current.savedVersion&&!autoPaused.current)scheduleSave();
    }
  }
  function save():Promise<boolean>{
    if(saveInFlight.current)return saveInFlight.current;
    const saving=performSave();saveInFlight.current=saving;
    void saving.then(()=>{if(saveInFlight.current===saving)saveInFlight.current=null;});return saving;
  }
  saveRef.current=save;
  function capture():EditorRecovery|null {
    const value=current.current;
    if(!value.document||(value.version===value.savedVersion&&!hasDrafts()))return null;
    return structuredClone({format:'feishu-editor-draft',version:1,path:value.document.handle.path,xml:value.xml,review:value.review,revision:value.revision,
      dirty:value.version!==value.savedVersion,pending:pendingRef.current,comment:commentTextRef.current,replies:replyDraftsRef.current,
      invalidSource:invalidSourceRef.current,formula:sourceSnapshots.current.formula,whiteboard:sourceSnapshots.current.whiteboard});
  }
  function persistRecovery(force=false):Promise<void> {
    const selectedHost=hostRef.current;if(!selectedHost)return Promise.resolve();
    const recovery=capture(),signature=JSON.stringify(recovery);
    if(!force&&persistSignature.current===signature)return persistTail.current;
    persistSignature.current=signature;
    const next=persistTail.current.catch(()=>undefined).then(()=>selectedHost.persistRecovery(recovery));
    persistTail.current=next;
    void next.catch(failure=>{if(mounted.current)setError('草稿恢复记录未保存：'+message(failure));});
    return next;
  }
  async function flush():Promise<boolean> {
    if(saveTimer.current){clearTimeout(saveTimer.current);saveTimer.current=null;}
    if(saveInFlight.current&&!await saveInFlight.current)return false;
    while(current.current.version!==current.current.savedVersion){
      if(busyRef.current||invalidSourceRef.current||conflictRef.current||autoPaused.current)return false;
      if(!await saveRef.current())return false;
    }
    return !invalidSourceRef.current&&!conflictRef.current;
  }
  async function prepareClose():Promise<void> {
    if(syncActive.current)throw new Error('正在同步文档，请等待同步结束再关闭。');
    setHostLocked(true);
    try{await flush();await persistRecovery(true);}
    catch(failure){setHostLocked(false);throw failure;}
  }
  async function acquireSync():Promise<{release():Promise<void>}> {
    if(syncActive.current||hostLockedRef.current||busyRef.current)throw new Error('文档正在处理，请稍后同步。');
    if(hasDrafts()||conflictRef.current)throw new Error('请先完成草稿并处理文件冲突，再同步文档。');
    syncActive.current=true;setHostLocked(true);
    try{if(!await flush())throw new Error('本地修改尚未保存，未开始同步。');await persistRecovery(true);}
    catch(failure){syncActive.current=false;setHostLocked(false);throw failure;}
    let released=false;
    return{async release(){
      if(released)return;released=true;
      try{
        const document=current.current.document;
        if(document&&mounted.current){const snapshot=await document.read();if(mounted.current&&current.current.document===document){accept(normalize(document,snapshot));refreshResources();await persistRecovery(true);}}
      }catch(failure){if(mounted.current){autoPaused.current=true;setError('同步后重新读取失败：'+message(failure));}throw failure;}
      finally{syncActive.current=false;if(mounted.current)setHostLocked(false);else hostLockedRef.current=false;}
    }};
  }
  const controllerActions=useRef<EditorController>({capture,flush,prepareClose,acquireSync});
  controllerActions.current={capture,flush,prepareClose,acquireSync};
  useEffect(()=>{
    if(!host)return;
    host.onReady({capture:()=>controllerActions.current.capture(),flush:()=>controllerActions.current.flush(),prepareClose:()=>controllerActions.current.prepareClose(),acquireSync:()=>controllerActions.current.acquireSync()});
    if(current.current.version!==current.current.savedVersion&&!conflictRef.current&&!invalidSourceRef.current)scheduleSave();
  },[host]);
  useEffect(()=>{if(host)void persistRecovery().catch(()=>undefined);},[host,draft,pending,commentText,replyDrafts,invalidSource,sourceRevision]);
  function refreshResources(){const editor=editorRef.current;if(editor&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta(RESOURCE_REFRESH,true).setMeta('addToHistory',false));}
  function isPermissionError(failure:unknown){return typeof failure==='object'&&failure!==null&&'status'in failure&&failure.status===403;}
  async function reauthorize(){
    const document=current.current.document;if(!document||busyRef.current||savingRef.current)return;
    // Request the original directory capability directly from this click, without replacing the draft.
    const permission=document.requestPermission();setBusy(true);
    try{await permission;if(!mounted.current||current.current.document!==document)return;setPermissionDenied(false);
      if(conflictRef.current){setError('目录已重新授权，文件冲突仍待处理。本页输入已保留，请确认是否重新读取本地文件。');return;}
      setError('');autoPaused.current=false;}
    catch(failure){if(mounted.current)setError(message(failure));return;}
    finally{if(mounted.current)setBusy(false);}
    if(mounted.current&&current.current.document===document)void (current.current.version===current.current.savedVersion?externalRef.current():saveRef.current());
  }
  function canLeave(){
    if(hostLockedRef.current){setNotice('正在同步或关闭文档，请稍候。');return false;}
    if(busyRef.current||savingRef.current){setNotice('正在处理本地文件，请稍候。');return false;}
    if(hasDrafts()){setNotice('请先完成或取消评论、回复、公式和白板草稿，并修正或还原无效源码，再切换文档。');return false;}
    if(current.current.version!==current.current.savedVersion||conflictRef.current){setNotice('本页改动尚未保存，请先处理保存问题。');return false;}
    setNotice('');return true;
  }
  async function chooseDirectory(){
    if(!canLeave())return;
    // The picker is called before any await so the click activation is retained.
    const choosing=chooseBrowserDirectory();setBusy(true);setError('');
    let nextStore:BrowserDocumentStore|null=null,nextDocument:BrowserDocument|null=null,accepted=false;
    try{
      nextStore=await choosing;if(!nextStore)return;
      const names=await nextStore.listDocuments();let next=demo(),openingError='';
      if(names.length){
        try{nextDocument=await nextStore.open(names[0]);next=normalize(nextDocument,await nextDocument.read());}
        catch(failure){nextDocument?.dispose();nextDocument=null;openingError='无法打开 '+names[0]+'：'+message(failure);}
      }
      if(!mounted.current)return;
      const oldDocument=current.current.document,oldStore=storeRef.current;
      storeRef.current=nextStore;setStoreState(nextStore);setDocuments(names);accept(next,true);accepted=true;if(openingError)setError(openingError);
      oldDocument?.dispose();oldStore?.dispose();
    }catch(failure){if(mounted.current)setError(message(failure));}
    finally{if(!accepted){nextDocument?.dispose();nextStore?.dispose();}if(mounted.current)setBusy(false);}
  }
  async function openDocument(name:string){
    const selectedStore=storeRef.current;if(!selectedStore||name===current.current.document?.handle.name||!canLeave())return;
    setBusy(true);setError('');let document:BrowserDocument|null=null,accepted=false;
    try{
      document=await selectedStore.open(name);const next=normalize(document,await document.read());
      if(!mounted.current||storeRef.current!==selectedStore)return;
      const previous=current.current.document;accept(next,true);accepted=true;previous?.dispose();
    }catch(failure){if(mounted.current)setError(message(failure));}
    finally{if(!accepted)document?.dispose();if(mounted.current)setBusy(false);}
  }
  async function refreshList(){
    const selectedStore=storeRef.current;if(!selectedStore)return;
    try{const names=await selectedStore.listDocuments();if(mounted.current&&storeRef.current===selectedStore)setDocuments(names);}
    catch(failure){if(mounted.current&&storeRef.current===selectedStore)setError(message(failure));}
  }
  async function createDocument(){
    const selectedStore=storeRef.current;if(!selectedStore||!newName.trim()||!canLeave())return;
    setBusy(true);setCreateError('');let document:BrowserDocument|null=null,accepted=false;
    try{
      document=await selectedStore.create(newName.trim(),newTitle.trim()||undefined);const next=normalize(document,await document.read());
      const names=await selectedStore.listDocuments();if(!mounted.current||storeRef.current!==selectedStore)return;
      const previous=current.current.document;accept(next,true);accepted=true;previous?.dispose();setDocuments(names);setCreateOpen(false);setNewName('');setNewTitle('');
    }catch(failure){if(mounted.current)setCreateError(message(failure));}
    finally{if(!accepted)document?.dispose();if(mounted.current)setBusy(false);}
  }
  async function checkExternal(){
    const start=current.current;if(!start.document||busyRef.current||hostLockedRef.current||savingRef.current||conflictRef.current)return;
    try{
      const latest=await start.document.read();
      if(!mounted.current||current.current.document!==start.document||busyRef.current||hostLockedRef.current||savingRef.current||current.current.version!==start.version||current.current.revision!==start.revision)return;
      if(latest.revision===start.revision){const resourceRevision=start.document.resourceRevision;if(resourceRevision!==start.resourceRevision){setDraft({...start,resourceRevision});refreshResources();}return;}
      if(start.version!==start.savedVersion||hasDrafts()){setConflict(true);autoPaused.current=true;setError('文件已由其他页面或 AI 修改。本页输入已保留，自动保存已暂停。');return;}
      accept(normalize(start.document,latest));setNotice('已读取本地文件的新修改。');
    }catch(failure){if(mounted.current&&current.current.document===start.document){setError(message(failure));setPermissionDenied(isPermissionError(failure));}}
  }
  const externalRef=useRef(checkExternal);externalRef.current=checkExternal;
  async function reload(){
    const start=current.current;if(!start.document||busyRef.current||hostLockedRef.current||savingRef.current)return;
    if((start.version!==start.savedVersion||hasDrafts())&&!window.confirm('重新读取会放弃本页尚未保存的正文与评论草稿。确定继续吗？'))return;
    setBusy(true);
    try{const next=normalize(start.document,await start.document.read());if(mounted.current&&current.current.document===start.document){accept(next,true);setNotice('已重新读取本地文件。');}}
    catch(failure){if(mounted.current){setError(message(failure));setPermissionDenied(isPermissionError(failure));}}finally{if(mounted.current)setBusy(false);}
  }
  useEffect(()=>{
    mounted.current=true;
    const interval=setInterval(()=>void externalRef.current(),2500),focus=()=>void externalRef.current();
    const leaving=(event:BeforeUnloadEvent)=>{if(savingRef.current||current.current.version!==current.current.savedVersion||hasDrafts()){event.preventDefault();event.returnValue='';}};
    window.addEventListener('focus',focus);window.addEventListener('beforeunload',leaving);
    return()=>{mounted.current=false;clearInterval(interval);if(saveTimer.current)clearTimeout(saveTimer.current);window.removeEventListener('focus',focus);window.removeEventListener('beforeunload',leaving);current.current.document?.dispose();storeRef.current?.dispose();};
  },[]);
  useEffect(()=>{
    if(!createOpen)return;const previous=document.activeElement as HTMLElement|null;
    createDialog.current?.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[createOpen]);
  function changeMode(next:typeof mode){
    if(busyRef.current||hostLockedRef.current||next===mode)return;
    if(invalidSourceRef.current){setNotice('源码尚未通过校验，请先修正或还原。');return;}
    if(next==='source'&&hasDrafts()){setNotice('请先完成或取消评论、回复、公式和白板草稿，再进入源码模式。');return;}
    if(next==='source')setSelection(null);setMode(next);modeRef.current=next;
  }
  function editSource(value:string){
    const start=current.current;if(!start.document||busyRef.current||hostLockedRef.current)return;
    const xml=start.xml.includes('\r\n')&&!start.xml.replaceAll('\r\n','').includes('\n')?value.replace(/\r?\n/g,'\r\n'):value;
    try{parseDocxXML(xml);}catch(failure){setInvalidSource({value,error:message(failure)});return;}
    setInvalidSource(null);if(xml===start.xml){scheduleSave();return;}
    change(xml,{...start.review,comments:invalidateAnchors(start.review.comments)},'在浏览器编辑 DocxXML 源码；旧评论位置待确认');
  }
  function addComment(){
    const start=current.current,anchor=pendingRef.current;if(!start.document||busyRef.current||hostLockedRef.current||!anchor||!commentTextRef.current.trim())return;
    const comment:ReviewComment={id:uid(),author:'我',createdAt:new Date().toISOString(),body:commentTextRef.current.trim(),status:'open',anchor,replies:[]};
    change(start.xml,{...start.review,comments:[...start.review.comments,comment]},'在浏览器添加选区评论','comment.add');setPending(null);setCommentText('');
  }
  function updateComment(id:string,update:(comment:ReviewComment)=>ReviewComment,summary:string){const start=current.current;change(start.xml,{...start.review,comments:start.review.comments.map(comment=>comment.id===id?update(comment):comment)},summary,'comment.update');}
  function revealComments(){setCommentsOpen(true);window.requestAnimationFrame(()=>{const panel=commentsPanel.current;(panel?.querySelector('.comment-composer')??panel)?.scrollIntoView?.({block:'nearest',inline:'nearest'});});}
  function startComment(){if(controlsLocked||!selection||pending)return;setPending(selection);setCommentText('');revealComments();}
  function navigateResource(file:ProjectFile){
    if(controlsLocked)return;
    if(invalidSourceRef.current&&file.kind!=='document'){setNotice('请先修正或还原无效源码，再查看资源。');return;}
    setSelectedResource(file.kind==='document'?null:file.path);
  }
  async function copyCurrentPath(value:string){
    try{await navigator.clipboard.writeText(value);if(mounted.current)setCopiedPath(value);}
    catch{if(mounted.current)setNotice('复制失败，可以选中文件路径后手动复制。');}
  }
  function locate(anchor:Anchor){
    if(!editor||editor.isDestroyed||anchor.state!=='attached'||anchor.from<0||anchor.to>editor.state.doc.content.size)return;
    if(invalidSourceRef.current){setNotice('请先修正或还原无效源码，再定位评论。');return;}
    setSelectedResource(null);
    const locating=()=>{
      if(editor.isDestroyed)return;
      if(anchor.target){
        const result=locateWhiteboardComponent(editor,anchor);
        if(!result.element){setNotice(result.reason||'白板组件位置待确认，评论已保留。');return;}
        editor.commands.setNodeSelection(anchor.from);
        editor.view.dom.querySelectorAll('.lr-whiteboard-component-selected').forEach(element=>element.classList.remove('lr-whiteboard-component-selected'));
        result.element.classList.add('lr-whiteboard-component-selected');result.element.scrollIntoView?.({block:'center',inline:'nearest'});setSelection(anchor);return;
      }
      const node=editor.state.doc.nodeAt(anchor.from),chain=editor.chain();
      const atom=node?.isAtom&&!node.isText&&anchor.to===anchor.from+node.nodeSize;
      if(atom)chain.setNodeSelection(anchor.from);else chain.setTextSelection({from:anchor.from,to:anchor.to});
      if(editor.isEditable)chain.focus().scrollIntoView().run();
      else{
        chain.run();const dom=editor.view.dom,doc=dom.ownerDocument,range=doc.createRange();dom.focus({preventScroll:true});
        const nodeDOM=atom?editor.view.nodeDOM(anchor.from):null;
        if(nodeDOM)range.selectNode(nodeDOM);
        else{const from=editor.view.domAtPos(anchor.from),to=editor.view.domAtPos(anchor.to);range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);}
        const native=doc.getSelection();native?.removeAllRanges();native?.addRange(range);editor.commands.scrollIntoView();
      }
    };
    if(modeRef.current==='source'){changeMode('read');window.requestAnimationFrame(locating);}else if(selectedResource)window.requestAnimationFrame(locating);else locating();
  }
  const saved=draft.version===draft.savedVersion;
  const controlsLocked=busy||hostLocked;
  function navigateHeading(position:number){
    if(invalidSourceRef.current){setNotice('请先修正或还原无效源码，再定位正文标题。');return false;}
    setSelectedResource(null);
    if(modeRef.current==='source'||selectedResource){
      if(modeRef.current==='source')changeMode('read');
      window.requestAnimationFrame(()=>scrollToHeading(editorRef.current,position));
      return true;
    }
    return scrollToHeading(editorRef.current,position);
  }
  const saveState=hostLocked?'正在处理文档':!draft.document?'只读示例':invalidSource?'源码未保存':conflict?'保存有冲突':saving?'正在保存到本地':!saved?'有未保存改动':sourceDirty?'有未应用的修改':pending||Object.values(replyDrafts).some(value=>value.trim())?'有未发送的评论草稿':'已保存到本地';
  const files=draft.document?projectFiles(draft.document.handle,draft.xml,draft.review):[];
  const selectedFile=files.find(file=>file.path===selectedResource),documentActive=!selectedFile||selectedFile.kind==='document';
  const path=draft.document?(selectedFile?draft.document.handle.path.slice(0,-draft.document.handle.name.length)+selectedFile.path:draft.document.handle.path):store?.directoryName||'';
  const formatTools=[
    {name:'加粗',icon:<Bold size={15}/>,run:()=>editor?.chain().focus().toggleBold().run()},
    {name:'斜体',icon:<Italic size={15}/>,run:()=>editor?.chain().focus().toggleItalic().run()},
    {name:'列表',icon:<List size={16}/>,run:()=>editor?.chain().focus().toggleBulletList().run()},
    {name:'行内代码',icon:<Code size={16}/>,run:()=>editor?.chain().focus().toggleCode().run()},
    {name:'引用',icon:<Quote size={15}/>,run:()=>editor?.chain().focus().toggleBlockquote().run()},
  ];
  const shownComments=draft.review.comments.filter(comment=>showResolved||comment.status==='open'||!!replyDrafts[comment.id]?.trim());
  return <div className={'browser-app'+(host?' browser-host-app':'')}>

    <header className="browser-header"><div className="browser-brand"><strong>本地飞书文档</strong><span>{host?.label||'浏览器版'}</span></div>
      {host?<fieldset className="browser-host-toolbar" disabled={controlsLocked}><div ref={hostToolbar}/></fieldset>:<div className="browser-file-actions"><button disabled={!supported||controlsLocked||saving} onClick={()=>void chooseDirectory()}><FolderOpen size={16}/>{store?'切换目录':'选择本地目录'}</button>
        <button disabled={!store||controlsLocked||saving} onClick={()=>{if(canLeave()){setCreateError('');setCreateOpen(true);}}}><Plus size={16}/>新建文档</button></div>}
      <span className="browser-save-state" role="status">{saveState}</span>
      <div className="browser-current-path"><span title={path}>{path||'示例尚未关联本地文件'}</span>{path&&<button aria-label="复制文件路径" title={copiedPath===path?'已复制文件路径':'复制文件路径'} onClick={()=>void copyCurrentPath(path)}>{copiedPath===path?<Check size={14}/>:<Copy size={14}/>}</button>}<span className="copy-announcement" role="status">{copiedPath===path&&path?'已复制文件路径':''}</span></div>
    </header>
    {!host&&!supported&&<p className="browser-banner" role="status">此浏览器不支持直接读写本地目录。请用支持 File System Access 的桌面 Chrome 或 Edge 打开本页；当前只能阅读示例。</p>}
    {!host&&!store&&supported&&<p className="browser-banner">授权一个本地目录后即可编辑。正文和评论直接写入其中的 XML 与 JSON；刷新页面后需要重新选择目录。</p>}
    {notice&&<p className="browser-banner">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={14}/></button></p>}
    {error&&<div className="browser-banner browser-error" role="alert"><span>{error}</span>{draft.document&&(permissionDenied?<button disabled={controlsLocked||saving} onClick={()=>void reauthorize()}>重新授权并重试</button>:conflict?<button disabled={controlsLocked||saving} onClick={()=>void reload()}>重新读取本地文件</button>:<button disabled={controlsLocked||saving} onClick={()=>{autoPaused.current=false;setError('');void (current.current.version===current.current.savedVersion?externalRef.current():saveRef.current());}}>重试</button>)}</div>}
    <div className={'browser-workspace'+(navigationCollapsed?' browser-navigation-collapsed':'')+(commentsOpen?'':' browser-comments-hidden')}>
      <aside className="browser-navigation" aria-label="文档导航">
      <div className="browser-navigation-heading">
        <button type="button" className="browser-navigation-toggle" aria-label={navigationCollapsed?'展开文档导航':'收起文档导航'} title={navigationCollapsed?'展开目录与文件':'收起目录与文件'} aria-expanded={!navigationCollapsed} aria-controls={navigationId} onClick={event=>{event.currentTarget.focus({preventScroll:true});setNavigationCollapsed(value=>!value);}}>
          {navigationCollapsed?<PanelLeftOpen size={18} aria-hidden="true"/>:<PanelLeftClose size={18} aria-hidden="true"/>}
        </button>
      <div className="browser-navigation-tabs mode-switch" role="group" aria-label="导航内容" hidden={navigationCollapsed}>
        <button className={sidebarTab==='files'?'selected':''} aria-pressed={sidebarTab==='files'} onClick={()=>setSidebarTab('files')}>文件</button>
        <button className={sidebarTab==='outline'?'selected':''} aria-pressed={sidebarTab==='outline'} onClick={()=>setSidebarTab('outline')}>目录</button>
      </div>
      </div>
      <div id={navigationId} className="browser-navigation-content" hidden={navigationCollapsed}>
      <div className="browser-navigation-outline" hidden={sidebarTab!=='outline'}><DocumentOutline editor={editor} revision={draft.xml} collapsed={false} showToggle={false} onToggle={()=>setNavigationCollapsed(value=>!value)} onNavigate={navigateHeading}/></div>
      <div className="browser-navigation-files" hidden={sidebarTab!=='files'}>{!host&&<div className="browser-documents" aria-label="目录文档"><h2>{store?.directoryName||'本地目录'}</h2>{documents.map(name=><button key={name} className={name===draft.document?.handle.name?'selected':''} aria-current={name===draft.document?.handle.name?'page':undefined} disabled={controlsLocked||saving} onClick={()=>void openDocument(name)}>{name}</button>)}
        {store&&!documents.length&&<p>目录中还没有 XML，可以新建文档。</p>}
        {store&&<button className="browser-refresh-list" disabled={busy} onClick={()=>void refreshList()}>刷新文档列表</button>}
      </div>}{draft.document&&<ProjectExplorer handle={draft.document.handle} xml={draft.xml} review={draft.review} selected={selectedResource||draft.document.handle.name} onSelect={navigateResource} dirty={!saved||!!invalidSource}/>}</div></div>
      </aside>
      <section className="browser-article" aria-label="文档编辑区"><div className="browser-toolbar"><div className="mode-switch" role="group" aria-label="文档模式">
        <button className={mode==='edit'?'selected':''} aria-pressed={mode==='edit'} disabled={!draft.document||controlsLocked||!!invalidSource} onClick={()=>{changeMode('edit');setSelectedResource(null);}}><PencilLine size={15}/>编辑</button>
        <button className={mode==='read'?'selected':''} aria-pressed={mode==='read'} disabled={controlsLocked||!!invalidSource} onClick={()=>{changeMode('read');setSelectedResource(null);}}><BookOpen size={15}/>只读</button>
        <button className={mode==='source'?'selected':''} aria-pressed={mode==='source'} disabled={controlsLocked} onClick={()=>{changeMode('source');setSelectedResource(null);}}><Code size={15}/>源码</button></div>
        {documentActive&&mode==='edit'&&<div className="browser-format-tools" role="group" aria-label="文字格式">{formatTools.map(tool=><button key={tool.name} title={tool.name} aria-label={tool.name} disabled={!draft.document||controlsLocked||!!invalidSource} onMouseDown={event=>event.preventDefault()} onClick={tool.run}>{tool.icon}</button>)}</div>}
        {documentActive&&draft.document&&mode!=='source'&&selection&&!pending&&<button className="browser-comment-selection" disabled={controlsLocked} onMouseDown={event=>event.preventDefault()} onClick={startComment}><MessageSquarePlus size={15}/>{selection.target?'评论选中组件':'评论选中内容'}</button>}
        {!documentActive&&<button className="return-document" onClick={()=>setSelectedResource(null)}>返回正文</button>}
        <button className="browser-comments-toggle" aria-label={commentsOpen?'收起评论面板':'展开评论面板'} aria-expanded={commentsOpen} aria-controls={commentsId} onClick={()=>{if(commentsOpen)setCommentsOpen(false);else revealComments();}}><MessageSquare size={15}/>评论 {draft.review.comments.filter(comment=>comment.status==='open').length}</button>
      </div>
      {invalidSource&&<p className="browser-banner" role="status">源码校验失败，输入保留在本页，尚未写入文件。<button disabled={controlsLocked} onClick={()=>{setInvalidSource(null);scheduleSave();}}>还原源码</button></p>}
      {documentActive&&mode==='source'&&<SourceEditor value={invalidSource?.value??draft.xml} error={invalidSource?.error} readOnly={!draft.document||controlsLocked} onChange={editSource}/>}
      <article className="browser-paper" hidden={!documentActive||mode==='source'}><Reader key={viewKey} xml={draft.xml} readOnly={!draft.document||mode!=='edit'||controlsLocked||!!invalidSource}
        assetURL={path=>draft.document?.assetURL(path)||'data:,'} readResourceText={async(path,signal)=>{if(!draft.document)throw new Error('示例没有本地资源');return(await draft.document.readResource(path,signal)).text;}}
        comments={draft.review.comments} getReview={()=>current.current.review} getDraft={()=>pendingRef.current} onReady={setEditor} onError={setError}
        onSelection={setSelection} onEdit={(xml,comments,anchor)=>{if(modeRef.current==='source'||invalidSourceRef.current||busyRef.current||hostLockedRef.current)return;setPending(anchor);change(xml,{...current.current.review,comments},'在浏览器编辑正文');}}/>
      </article>{!documentActive&&selectedFile&&draft.document&&<ResourcePreview key={draft.document.handle.id+':'+selectedFile.path} file={selectedFile} handle={draft.document.handle} xml={draft.xml} review={draft.review} initialScroll={resourcePositions.current.get(draft.document.handle.id+':'+selectedFile.path)} onScrollChange={position=>resourcePositions.current.set(draft.document!.handle.id+':'+selectedFile.path,position)} access={{assetURL:resource=>draft.document!.assetURL(resource),readResource:(resource,signal)=>draft.document!.readResource(resource,signal),refresh:async()=>{await draft.document!.read();}}}/>}</section>
      <aside ref={commentsPanel} id={commentsId} tabIndex={-1} hidden={!commentsOpen} className="browser-comments" aria-label="评论与内容编辑"><div className="browser-comments-heading"><h2>评论 <span>{draft.review.comments.filter(comment=>comment.status==='open').length}</span></h2><button aria-label="关闭评论面板" onClick={()=>setCommentsOpen(false)}><X size={16}/></button></div>
        <fieldset className="browser-source-controls" disabled={controlsLocked} hidden={!documentActive||!draft.document||mode==='source'}><FormulaEditor key={'formula:'+viewKey} editor={editor} readOnly={!draft.document||mode!=='edit'||controlsLocked||!!invalidSource} onDraftChange={formulaDraftChanged} persistence={{initial:sourceSnapshots.current.formula,onChange:value=>sourceSnapshotChanged('formula',value)}}/>
          <WhiteboardEditor key={'whiteboard:'+viewKey} editor={editor} readOnly={!draft.document||mode!=='edit'||controlsLocked||!!invalidSource} onDraftChange={whiteboardDraftChanged} persistence={{initial:sourceSnapshots.current.whiteboard,onChange:value=>sourceSnapshotChanged('whiteboard',value)}}/></fieldset>
        {pending&&<form className="comment-composer" onSubmit={event=>{event.preventDefault();addComment();}}><blockquote>{pending.quote}</blockquote>
          <textarea autoFocus aria-label="评论内容" value={commentText} disabled={controlsLocked} onChange={event=>setCommentText(event.target.value)}/>
          <div className="browser-comment-actions"><button type="button" disabled={controlsLocked} onClick={()=>{setPending(null);setCommentText('');}}>取消评论</button><button className="small-primary" disabled={controlsLocked||!commentText.trim()}>添加评论</button></div></form>}
        {!draft.review.comments.length&&!pending&&<p className="browser-muted">{draft.document?'在编辑或只读模式下选中正文，留下修改意见。':'选择本地目录后可以留下评论。'}</p>}
        {shownComments.map(comment=><article className="comment-card" key={comment.id}>
          <div className="browser-comment-heading"><strong title={comment.author}>{displayAuthor(comment.author,comment.id.startsWith('cloud:'))}</strong>{comment.status==='resolved'&&<span className="browser-comment-status">已解决</span>}</div>
          <button className="comment-quote" disabled={comment.anchor.state!=='attached'||!!invalidSource} onClick={()=>locate(comment.anchor)}>{comment.anchor.quote}</button>
          {comment.anchor.state!=='attached'&&<p className="browser-muted">引用位置待确认</p>}<p className="comment-body">{comment.body}</p>
          {comment.replies.map(reply=><div key={reply.id} className="reply"><strong title={reply.author}>{displayAuthor(reply.author,reply.id.startsWith('cloud-reply:'))}</strong><p>{reply.body}</p></div>)}
          <button className="browser-resolve" disabled={!draft.document||controlsLocked} onClick={()=>updateComment(comment.id,value=>({...value,status:value.status==='open'?'resolved':'open'}),'更新评论状态')}><Check size={13}/>{comment.status==='open'?'解决':'重新打开'}</button>
          <button className="browser-reply-toggle" disabled={!draft.document||controlsLocked} aria-expanded={!!replyOpen[comment.id]||!!replyDrafts[comment.id]?.trim()} onClick={()=>setReplyOpen({...replyOpen,[comment.id]:!replyOpen[comment.id]})}>回复</button>
          {(replyOpen[comment.id]||!!replyDrafts[comment.id]?.trim())&&<form onSubmit={event=>{event.preventDefault();const body=replyDrafts[comment.id]?.trim();if(!body||controlsLocked)return;updateComment(comment.id,value=>({...value,replies:[...value.replies,{id:uid(),author:'我',body,createdAt:new Date().toISOString()}]}),'回复评论');setReplies({...replyDraftsRef.current,[comment.id]:''});setReplyOpen({...replyOpen,[comment.id]:false});}}>
            <textarea aria-label={'回复评论：'+comment.body} placeholder="回复" value={replyDrafts[comment.id]||''} disabled={!draft.document||controlsLocked} onChange={event=>setReplies({...replyDraftsRef.current,[comment.id]:event.target.value})}/><button disabled={!replyDrafts[comment.id]?.trim()||controlsLocked}>发送回复</button></form>}
        </article>)}
        {draft.review.comments.some(comment=>comment.status==='resolved')&&<button className="resolved-toggle" onClick={()=>setShowResolved(value=>!value)}>{showResolved?'隐藏已解决评论':'查看已解决评论'}</button>}
        {draft.review.result&&<div className="ai-receipt"><strong>{draft.review.result.author} 的处理记录</strong><p>{draft.review.result.summary}</p></div>}
        {draft.document&&<p className="browser-muted">评论保存在 {draft.document.handle.reviewPath}。告诉 AI「我留下了意见」，即可继续改稿。</p>}
      </aside>
    </div>
    {createOpen&&<div className="modal-overlay project-modal" onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();setCreateOpen(false);}}}><form ref={createDialog} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-new-title" onKeyDown={containDialogFocus} onSubmit={event=>{event.preventDefault();void createDocument();}}>
      <fieldset className="sync-protected-controls" disabled={busy}><div className="project-dialog-heading"><h2 id="browser-new-title">新建本地文档</h2><button type="button" aria-label="关闭新建文档" disabled={busy} onClick={()=>setCreateOpen(false)}><X size={18}/></button></div>
        <label>文件名<input aria-label="新文档文件名" required value={newName} placeholder="文章.xml" onChange={event=>setNewName(event.target.value)}/></label>
        <label>文章标题<input aria-label="新文档标题" value={newTitle} onChange={event=>setNewTitle(event.target.value)}/></label>
        <p className="project-help">保存到已授权的 {store?.directoryName} 目录，已有文件不会被覆盖。</p>{createError&&<p role="alert" className="project-error">{createError}</p>}
        <div className="project-dialog-actions"><button type="button" disabled={busy} onClick={()=>setCreateOpen(false)}>取消</button><button className="primary" disabled={busy||!newName.trim()}>{busy?'正在创建…':'创建文档'}</button></div></fieldset>
    </form></div>}
  </div>;
}
