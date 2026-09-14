import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { BookOpen, PencilLine, MessageSquarePlus, Check, ArrowUp, X, Bold, Italic, List, Code, Quote, ChevronDown, MessageSquare, PanelLeftClose, PanelLeftOpen, Copy, ExternalLink } from 'lucide-react';
import { createReview, uid, type Anchor, type DocumentHandle, type Review, type ReviewComment, type Session, type Snapshot } from '../core/types';
import { invalidateAnchors } from '../core/anchors';
import { parseDocxXML } from '../core/docxml';
import { FormulaEditor, Reader } from './Reader';
import { SourceEditor } from './SourceEditor';
import { WhiteboardEditor } from './WhiteboardEditor';
import { ProjectExplorer, ResourcePreview } from './ProjectExplorer';
import { DocumentOutline, scrollToHeading } from './DocumentOutline';
import { projectFiles } from '../core/project-files';
import { locateWhiteboardComponent } from './whiteboard-comments';
import { readWhiteboardSource } from '../core/whiteboard-source';
import type { CloudSyncReport } from '../core/cloud-types';
import { CloudSync } from './CloudSync';
import { Projects, ProjectActionButton, readProjectPreference, writeProjectPreference, type ProjectSettings } from './Projects';
import { ContentSync, ContentSyncControls } from './ContentSync';
import { HistoryRestore } from './HistoryRestore';
import { BindCloud } from './BindCloud';
import { OpenDocumentDialog } from './OpenDocumentDialog';
import { ProjectCreationNotice } from './ProjectCreationNotice';
import type { BindProjectInput, ContentPreview, ContentRestorePreview, ContentRestoreResult, ContentSyncResult, CreateProjectInput, ProjectList, ProjectOpenResult, ReviewProject, SyncDirection } from '../core/projects';
import './document-paths.css';
import type { SourceDraftSnapshot } from './source-drafts';

interface Draft {handle:DocumentHandle; xml:string; review:Review; revision:string; version:number; savedVersion:number;}
class APIError extends Error {constructor(message:string,readonly status:number) {super(message);}}
function displayAuthor(author:string,fromCloud:boolean) {
  return fromCloud&&/^(?:ou_|on_|cli_)[A-Za-z0-9_-]+$/.test(author)?'飞书用户':author;
}

function CommentCard({comment,reply,setReply,onResolve,onReply,onLocate}:{comment:ReviewComment;reply:string;setReply:(value:string)=>void;onResolve:()=>void;onReply:(body:string)=>void;onLocate:()=>void}) {
  const [replying,setReplying] = useState(!!reply);
  const author=displayAuthor(comment.author,comment.id.startsWith('cloud:'));
  return <article className={'comment-card '+(comment.status==='resolved'?'resolved':'')}>
    <div className="comment-author"><span className="avatar">{author.slice(0,1)}</span><strong title={author!==comment.author?comment.author:undefined}>{author}</strong><time>{new Date(comment.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>
    <button className="comment-quote" onClick={onLocate} disabled={comment.anchor.state!=='attached'}>{comment.anchor.quote}</button>
    {comment.anchor.state !== 'attached' && <span className="anchor-state">{comment.anchor.state==='deleted'?'引用内容已删除':'正文已改变，引用位置待确认'}</span>}
    <p className="comment-body">{comment.body}</p>
    {comment.replies.map(r=>{const name=displayAuthor(r.author,r.id.startsWith('cloud-reply:'));return <div className="reply" key={r.id}><strong title={name!==r.author?r.author:undefined}>{name}</strong><p>{r.body}</p></div>;})}
    <div className="comment-actions"><button onClick={()=>setReplying(!replying)}>回复</button><button onClick={onResolve}>{comment.status==='open'?<><Check size={14}/>解决</>:'重新打开'}</button></div>
    {replying && <form onSubmit={e=>{e.preventDefault();if(reply.trim()){onReply(reply.trim());setReply('');setReplying(false);}}}><textarea data-review-draft aria-label="回复评论" value={reply} onChange={e=>setReply(e.target.value)} autoFocus/><button className="small-primary" disabled={!reply.trim()}>回复</button></form>}
  </article>;
}

export function App() {
  const [session,setSession] = useState<Session|null>(null);
  const [draft,setDraftState] = useState<Draft|null>(null);
  const current = useRef<Draft|null>(null);
  const [mode,setMode] = useState<'edit'|'read'|'source'>('edit');
  const [xmlDraft,setXMLDraftState] = useState<{value:string;error:string}|null>(null);
  const xmlDraftRef = useRef<typeof xmlDraft>(null);
  const [editor,setEditor] = useState<Editor|null>(null);
  const [selection,setSelection] = useState<Anchor|null>(null);
  const [componentSelected,setComponentSelected] = useState(false);
  const [pending,setPendingState] = useState<Anchor|null>(null);
  const pendingRef = useRef<Anchor|null>(null);
  const [body,setBodyState] = useState(''),bodyRef=useRef('');
  const [replyDrafts,setReplyDraftsState]=useState<Record<string,string>>({}),replyDraftsRef=useRef(replyDrafts);
  const [error,setError] = useState('');
  const [conflict,setConflict] = useState(false);
  const blocked = useRef(false);
  const [saving,setSaving] = useState(false);
  const savingRef = useRef(false);
  const [opening,setOpening] = useState(false);
  const [syncing,setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [syncReport,setSyncReport] = useState<CloudSyncReport|null>(null);
  const [syncError,setSyncError] = useState('');
  const [projects,setProjects] = useState<ProjectList|null>(null);
  const projectListRequest=useRef(0);
  const projectSettingsRequest=useRef(0);
  const [projectSettings,setProjectSettings] = useState<ProjectSettings|null>(null);
  const [projectError,setProjectError] = useState('');
  const [creatingProject,setCreatingProject] = useState(false);
  const [bindingProject,setBindingProject] = useState<ReviewProject|null>(null);
  const [projectRestoreNeeded,setProjectRestoreNeeded] = useState(false);
  const [workspaceTask,setWorkspaceTask] = useState<'project'|'content'|'restore'|'pick'|null>(null);
  const [direction,setDirection] = useState<SyncDirection>('pull');
  const [contentPreviewOpen,setContentPreviewOpen] = useState(false);
  const [contentPreview,setContentPreview] = useState<{value:ContentPreview;handleId:string;revision:string;version:number}|null>(null);
  const [previewExpired,setPreviewExpired] = useState(false);
  const [contentError,setContentError] = useState('');
  const [contentMessage,setContentMessage] = useState('');
  const [restoreOpen,setRestoreOpen] = useState(false);
  const [restorePreview,setRestorePreview] = useState<{value:ContentRestorePreview;projectId:string;handleId:string;revision:string;version:number}|null>(null);
  const [restoreExpired,setRestoreExpired] = useState(false);
  const [restoreError,setRestoreError] = useState('');
  const [pathDialog,setPathDialog] = useState(false);
  const [path,setPath] = useState('');
  const [pathError,setPathError] = useState('');
  const [showResolved,setShowResolved] = useState(false);
  const [notice,setNotice] = useState('');
  const [copiedPath,setCopiedPath] = useState<{kind:'file'|'cloud';value:string}|null>(null);
  useEffect(()=>{
    if(!copiedPath)return;
    const timeout=setTimeout(()=>setCopiedPath(null),2000);
    return()=>clearTimeout(timeout);
  },[copiedPath]);
  const [creationNotices,setCreationNotices] = useState<Map<string,string>>(()=>new Map());
  const [treeOpen,setTreeOpen] = useState(()=>window.innerWidth>900);
  const [navigationTab,setNavigationTab] = useState<'outline'|'files'>('outline');
  const lastVisualMode=useRef<'edit'|'read'>('edit');
  const outlineNavigation=useRef<{id:string;position:number}|null>(null);
  const [reviewOpen,setReviewOpen] = useState(false);
  const [narrow,setNarrow] = useState(()=>window.innerWidth<=1200);
  const [compact,setCompact] = useState(()=>window.innerWidth<=560);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewCloseButton = useRef<HTMLButtonElement>(null);
  const reviewReturnFocus = useRef<HTMLElement|null>(null);
  const reviewFocusPending = useRef(false);
  const sourceDrafts = useRef({formula:false,whiteboard:false});
  const sourceSnapshots=useRef({formula:[] as SourceDraftSnapshot,whiteboard:[] as SourceDraftSnapshot});
  const sourceSnapshotChanged=useCallback((kind:'formula'|'whiteboard',value:SourceDraftSnapshot)=>{
    if(JSON.stringify(sourceSnapshots.current[kind])===JSON.stringify(value))return;
    sourceSnapshots.current[kind]=value;
  },[]);
  const [sourceDirty,setSourceDirty] = useState(false);
  const formulaDraftChanged=useCallback((dirty:boolean)=>{sourceDrafts.current.formula=dirty;setSourceDirty(dirty||sourceDrafts.current.whiteboard);},[]);
  const whiteboardDraftChanged=useCallback((dirty:boolean)=>{sourceDrafts.current.whiteboard=dirty;setSourceDirty(dirty||sourceDrafts.current.formula);},[]);
  const header = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const [headerHeight,setHeaderHeight] = useState(174);
  const [selectedPath,setSelectedPath] = useState<string|null>(null);
  const positions = useRef(new Map<string,{page:number;preview:{top:number;left:number}}>());
  const navigation = useRef<{id:string;path:string;anchor?:Anchor}|null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const mounted = useRef(true);
  const apiRef = useRef<Session|null>(null);
  const saveRef = useRef<()=>Promise<boolean>>(async()=>false);
  const saveInFlight=useRef<Promise<boolean>|null>(null);

  function setDraft(next:Draft) { current.current=next;setDraftState(next); }
  function setPending(next:Anchor|null) {pendingRef.current=next;setPendingState(next);}
  function setBody(value:string){bodyRef.current=value;setBodyState(value);}
  function setReplies(value:Record<string,string>){replyDraftsRef.current=value;setReplyDraftsState(value);}
  function setXMLDraft(next:typeof xmlDraft) {xmlDraftRef.current=next;setXMLDraftState(next);}
  function hasCommentDraft() {return !!xmlDraftRef.current || sourceDrafts.current.formula || sourceDrafts.current.whiteboard || !!sourceSnapshots.current.formula.length || !!sourceSnapshots.current.whiteboard.length || !!pendingRef.current || !!bodyRef.current.trim() || Object.values(replyDraftsRef.current).some(value=>value.trim());}
  function draftMessage(other:string) {return xmlDraftRef.current?'源码尚未通过校验，请先修正或还原源码，再继续。':other;}
  function changeMode(next:typeof mode) {
    if(next===mode||syncingRef.current)return;
    if(next==='source'&&hasCommentDraft()&&!xmlDraftRef.current){setNotice('请先发送或取消评论、回复，应用或还原公式、白板修改，再编辑源码。');return;}
    if(next==='edit'&&xmlDraftRef.current)return;
    if(next!=='source')lastVisualMode.current=next;
    setMode(next);setSelection(null);setComponentSelected(false);setNotice('');
  }
  function editSource(input:string) {
    const d=current.current;
    if(!d||mode!=='source'||syncingRef.current||opening)return;
    // Textareas expose LF even for CRLF files. Keep the existing line ending style.
    const xml=d.xml.includes('\r\n')&&!d.xml.replaceAll('\r\n','').includes('\n')?input.replace(/\r?\n/g,'\r\n'):input;
    try {parseDocxXML(xml);}
    catch(e){setXMLDraft({value:xml,error:e instanceof Error?e.message:String(e)});return;}
    setXMLDraft(null);
    if(xml===d.xml)return;
    setSelection(null);setPending(null);
    changed(xml,{...d.review,comments:invalidateAnchors(d.review.comments),operations:[...d.review.operations.filter(o=>o.id!=='current-edit'),{id:'current-edit',type:'document.edit',author:'我',at:new Date().toISOString(),summary:'在浏览器编辑 DocxXML 源码；旧评论保留，引用位置需要确认'}]});
  }
  function editorHasFocus() {return !!document.activeElement?.closest('.document-content,textarea,input');}
  async function api<T>(url:string,method='GET',value?:unknown):Promise<T> {
    const response = await fetch(url,{method,headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':apiRef.current?.csrf||''})},body:value===undefined?undefined:JSON.stringify(value)});
    const result = await response.json();
    if(!response.ok) throw new APIError(result.error || '本地文件服务暂时不可用',response.status);
    return result;
  }
  function refreshProjects(restoreRecent=false) {
    const request=++projectListRequest.current;
    void api<ProjectList>('/api/projects').then(list=>{
      if(!mounted.current||request!==projectListRequest.current)return;
      setProjects(list);
      if(restoreRecent){
        const recent=readProjectPreference('last-project'),d=current.current;
        if(recent&&recent!==apiRef.current?.project?.id&&list.projects.some(project=>project.id===recent)){
          if(d&&d.version===d.savedVersion&&!syncingRef.current&&!savingRef.current&&!hasCommentDraft()&&!editorHasFocus())void switchProject(recent);
        }else if(apiRef.current?.project)writeProjectPreference('last-project',apiRef.current.project.id);
      }
    })
      .catch(e=>{if(mounted.current&&request===projectListRequest.current)setProjectError(e instanceof Error?e.message:String(e));});
  }
  function refreshProjectSettings() {
    const request=++projectSettingsRequest.current;
    void api<ProjectSettings>('/api/project-settings').then(settings=>{if(mounted.current&&request===projectSettingsRequest.current)setProjectSettings(settings);})
      .catch(e=>{if(mounted.current&&request===projectSettingsRequest.current)setProjectError(e instanceof Error?e.message:String(e));});
  }
  function accept(handle:DocumentHandle,snapshot:Snapshot) {
    if(current.current?.handle.id!==handle.id) {
      if(current.current)navigation.current={id:handle.id,path:handle.name};
      setSelectedPath(null);
      setSyncReport(null);setSyncError('');
      setContentPreviewOpen(false);setContentPreview(null);setContentError('');setContentMessage('');
      setRestoreOpen(false);setRestorePreview(null);setRestoreError('');
    }
    const review = snapshot.review || createReview(handle.name,snapshot.xml);
    const changedOutside = review.document.xml !== snapshot.xml;
    const nextReview = changedOutside ? {...review,comments:invalidateAnchors(review.comments),document:{...review.document,xml:snapshot.xml}} : review;
    setDraft({handle,xml:snapshot.xml,review:nextReview,revision:snapshot.revision,version:0,savedVersion:0});
    setXMLDraft(null);
    setSelection(null);setPending(null);setBody('');setReplies({});setError('');setConflict(false);blocked.current=false;
    if(snapshot.recovery) setNotice('已恢复上次中断的保存。');
    else if(changedOutside) setNotice('已读取外部修改；旧评论保留，引用位置需要确认。');
  }
  function changed(xml:string,review:Review) {
    const prev=current.current;if(!prev)return;
    const now=new Date().toISOString();
    setDraft({...prev,xml,review:{...review,document:{...review.document,xml,updatedAt:now}},version:prev.version+1});
    if(timer.current)clearTimeout(timer.current);
    if(!syncingRef.current)timer.current=setTimeout(()=>void saveRef.current(),550);
  }
  async function performSave():Promise<boolean> {
    const sent=current.current;
    if(!sent || blocked.current || savingRef.current) return false;
    if(sent.version===sent.savedVersion)return true;
    savingRef.current=true;setSaving(true);
    try {
      const snapshot=await api<Snapshot>('/api/document?id='+encodeURIComponent(sent.handle.id),'PUT',{xml:sent.xml,review:sent.review,revision:sent.revision});
      const live=current.current;
      if(live && live.handle.id===sent.handle.id) {
        setDraft({...live,revision:snapshot.revision,savedVersion:sent.version});
        setError('');
      }
      return true;
    } catch(e) {
      // A lost response may follow a successful disk commit. Read the pair before
      // declaring a conflict; only the exact submitted payload is our receipt.
      try {
        const check=await api<Snapshot>('/api/document?id='+encodeURIComponent(sent.handle.id));
        if(check.xml===sent.xml && JSON.stringify(check.review)===JSON.stringify(sent.review)) {
          const live=current.current;
          if(live&&live.handle.id===sent.handle.id)setDraft({...live,revision:check.revision,savedVersion:sent.version});
          setError('');return true;
        }
      } catch { /* Keep the original save error and the unsaved editor state. */ }
      if(e instanceof APIError && e.status===409){blocked.current=true;setConflict(true);}
      setError(e instanceof Error?e.message:String(e));return false;
    } finally {
      savingRef.current=false;if(mounted.current)setSaving(false);
      const live=current.current;
      if(!syncingRef.current && !blocked.current && live && live.version>sent.version && live.version!==live.savedVersion) {
        timer.current=setTimeout(()=>void saveRef.current(),200);
      }
    }
  }
  function save():Promise<boolean>{
    if(saveInFlight.current)return saveInFlight.current;
    const operation=performSave();saveInFlight.current=operation;
    void operation.then(()=>{if(saveInFlight.current===operation)saveInFlight.current=null;});return operation;
  }
  saveRef.current=save;
  useEffect(()=>{
    mounted.current=true;
    void (async()=>{
      try{const info=await api<Session>('/api/session');apiRef.current=info;setSession(info);const snap=await api<Snapshot>('/api/document?id='+encodeURIComponent(info.document.id));if(mounted.current){accept(info.document,snap);if(info.project){setDirection(info.project.defaultDirection);setProjects({projects:[info.project],activeProjectId:info.project.id,cloudAvailable:false});refreshProjects(true);refreshProjectSettings();}}}
      catch(e){setError(e instanceof Error?e.message:String(e));}
    })();
    const interval=setInterval(()=>void (async()=>{
      const d=current.current;
      if(!d||syncingRef.current||savingRef.current||blocked.current||d.version!==d.savedVersion||hasCommentDraft()||editorHasFocus())return;
      try{
        const snap=await api<Snapshot>('/api/document?id='+encodeURIComponent(d.handle.id));
        const live=current.current;
        if(live!==d||snap.revision===d.revision||syncingRef.current||savingRef.current||hasCommentDraft()||editorHasFocus())return;
        accept(d.handle,snap);setNotice('已同步本地文件中的更新。');
      }catch(e){setError(e instanceof Error?e.message:String(e));}
    })(),1800);
    const beforeUnload=(e:BeforeUnloadEvent)=>{const d=current.current;if(syncingRef.current||(d&&d.version!==d.savedVersion)||hasCommentDraft()){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',beforeUnload);
    const refreshOnFocus=()=>{if(apiRef.current?.project&&!syncingRef.current)refreshProjects();};
    window.addEventListener('focus',refreshOnFocus);
    return()=>{mounted.current=false;clearInterval(interval);if(timer.current)clearTimeout(timer.current);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('focus',refreshOnFocus);};
  },[]);
  useEffect(()=>{
    if(!contentPreview){setPreviewExpired(false);return;}
    const remaining=Date.parse(contentPreview.value.expiresAt)-Date.now();
    if(!Number.isFinite(remaining)||remaining<=0){setPreviewExpired(true);return;}
    setPreviewExpired(false);const timeout=setTimeout(()=>setPreviewExpired(true),Math.min(remaining,2147483647));
    return()=>clearTimeout(timeout);
  },[contentPreview]);
  useEffect(()=>{
    if(!restorePreview){setRestoreExpired(false);return;}
    const remaining=Date.parse(restorePreview.value.expiresAt)-Date.now();
    if(!Number.isFinite(remaining)||remaining<=0){setRestoreExpired(true);return;}
    setRestoreExpired(false);const timeout=setTimeout(()=>setRestoreExpired(true),Math.min(remaining,2147483647));
    return()=>clearTimeout(timeout);
  },[restorePreview]);
  async function openDocument(native:boolean) {
    if(syncingRef.current||savingRef.current)return;
    const d=current.current;
    if(d && d.version!==d.savedVersion && !(await save()))return;
    if(current.current && current.current.version!==current.current.savedVersion){setNotice('最新输入还在保存，请等保存完成后再切换文档。');return;}
    if(hasCommentDraft()){setNotice(draftMessage(sourceDrafts.current.formula||sourceDrafts.current.whiteboard?'有尚未应用的公式或白板修改，请回到对应内容应用或还原后再切换文档。':'请先添加或取消正在输入的评论，再切换文档。'));return;}
    if(!native && !pathDialog){setPathError('');setPathDialog(true);return;}
    setOpening(true);setError('');setPathError('');
    const start=current.current;
    let accepted=false;
    try{
      const handle=await api<DocumentHandle|null>(native?'/api/pick':'/api/open','POST',native?{}:{path:path.trim()});
      if(!handle)return;
      const snap=await api<Snapshot>('/api/document?id='+encodeURIComponent(handle.id));
      const live=current.current;
      if(hasCommentDraft() || (live && start && (live.handle.id!==start.handle.id || live.version!==start.version))) {
        (native?setError:setPathError)('切换期间当前文档又有修改，已保留当前内容。请等保存完成后重试。');return;
      }
      accept(handle,snap);accepted=true;setNotice('');
      if(apiRef.current?.project||projects){
        const info=await api<Session>('/api/session');
        if(current.current?.handle.id===handle.id&&info.document.id===handle.id){apiRef.current=info;setSession(info);if(info.project)setDirection(info.project.defaultDirection);}
      }
    }catch(e){(native||accepted?setError:setPathError)(e instanceof Error?e.message:String(e));}
    finally{setOpening(false);if(accepted)setPathDialog(false);}
  }
  function updateComment(id:string,fn:(c:ReviewComment)=>ReviewComment,summary:string) {
    const d=current.current;if(!d)return;
    changed(d.xml,{...d.review,comments:d.review.comments.map(c=>c.id===id?fn(c):c),operations:[...d.review.operations,{id:uid(),type:'comment',author:'我',at:new Date().toISOString(),summary}]});
  }
  function addComment() {
    const d=current.current;const anchor=pendingRef.current;
    if(!d||!anchor||!body.trim())return;
    const now=new Date().toISOString();
    changed(d.xml,{...d.review,comments:[...d.review.comments,{id:uid(),author:'我',body:body.trim(),createdAt:now,status:'open',anchor,replies:[]}],operations:[...d.review.operations,{id:uid(),type:'comment.add',author:'我',at:now,summary:'添加评论'}]});
    setPending(null);setBody('');setSelection(null);
  }
  async function syncComments() {
    const start=current.current,cloud=apiRef.current?.cloud;
    if(!start||!cloud||start.handle.path!==cloud.localPath||start.review.cloudSync?.pending||syncingRef.current||savingRef.current||opening||blocked.current)return;
    if(hasCommentDraft()) {
      setSyncError(draftMessage(sourceDrafts.current.formula||sourceDrafts.current.whiteboard?'请先应用或还原公式、白板修改，再同步飞书评论。':'请先发送或取消正在输入的评论、回复，再同步飞书评论。'));return;
    }
    syncingRef.current=true;setSyncing(true);setSyncError('');setSyncReport(null);
    if(timer.current){clearTimeout(timer.current);timer.current=null;}
    // Freeze the actual contenteditable immediately, before React applies readOnly.
    editor?.setEditable(false);
    try {
      if(!(await save())){setSyncError('本地修改尚未保存，未开始同步飞书评论。');return;}
      const sent=current.current;
      if(!sent||sent.handle.id!==start.handle.id||sent.version!==sent.savedVersion||hasCommentDraft()) {
        setSyncError('保存期间又有新输入，已保留当前内容，请完成保存后再同步。');return;
      }
      const result=await api<{snapshot:Snapshot;report:CloudSyncReport}>('/api/cloud-sync?id='+encodeURIComponent(sent.handle.id),'POST',{revision:sent.revision});
      const live=current.current;
      if(!mounted.current)return;
      if(!live||live.handle.id!==sent.handle.id)return;
      if(live.version!==sent.version||live.revision!==sent.revision||hasCommentDraft()) {
        // An unexpected programmatic edit must survive even though ordinary UI input is locked.
        blocked.current=true;setConflict(true);
        setError('同步期间当前页面又有修改，已保留页内输入。请核对磁盘中的同步结果后再处理冲突。');return;
      }
      if(result.snapshot.xml!==sent.xml) {
        blocked.current=true;setConflict(true);
        setError('同步期间磁盘正文发生变化，已保留当前页面，请核对后重新载入。');return;
      }
      accept(sent.handle,result.snapshot);setSyncReport(result.report);
    } catch(e) {
      if(mounted.current&&current.current?.handle.id===start.handle.id)
        setSyncError('同步未完成：'+(e instanceof Error?e.message:String(e))+'。请先核对目标文档与本地记录。');
    } finally {
      syncingRef.current=false;if(mounted.current)setSyncing(false);
      const live=current.current;
      if(mounted.current&&live?.handle.id===start.handle.id&&editor&&!editor.isDestroyed)editor.setEditable(mode==='edit');
      if(mounted.current&&!blocked.current&&live?.handle.id===start.handle.id&&live.version!==live.savedVersion)
        timer.current=setTimeout(()=>void saveRef.current(),550);
    }
  }
  function canBeginProject() {
    if(projectRestoreNeeded){setProjectError('请先重新选择项目，恢复当前文档关联后再创建。');return false;}
    if(syncingRef.current||savingRef.current||opening||blocked.current)return false;
    if(hasCommentDraft()){setProjectError(draftMessage('请先发送或取消评论、回复，应用或还原公式、白板修改，再切换项目。'));return false;}
    setProjectError('');return true;
  }
  function unchanged(sent:Draft) {
    const live=current.current;
    return !!live&&live.handle.id===sent.handle.id&&live.version===sent.version&&live.revision===sent.revision&&!hasCommentDraft();
  }
  async function projectTask(kind:'project'|'content'|'restore'|'pick',action:(sent:Draft)=>Promise<boolean>):Promise<boolean> {
    const start=current.current;
    const showError=kind==='content'?setContentError:kind==='restore'?setRestoreError:setProjectError;
    if(!start||syncingRef.current||savingRef.current||opening||blocked.current)return false;
    if(hasCommentDraft()){showError(draftMessage('请先发送或取消评论、回复，应用或还原公式、白板修改，再继续。'));return false;}
    syncingRef.current=true;setWorkspaceTask(kind);showError('');
    if(timer.current){clearTimeout(timer.current);timer.current=null;}
    editor?.setEditable(false);
    try {
      if(!(await save())){showError('本地修改尚未保存，请先处理保存问题。');return false;}
      if(!mounted.current)return false;
      const sent=current.current;
      if(!sent||sent.handle.id!==start.handle.id||sent.version!==sent.savedVersion||hasCommentDraft()){
        showError('保存期间又有新输入，已保留，请完成保存后再继续。');return false;
      }
      return await action(sent);
    }catch(e){if(mounted.current)showError(e instanceof Error?e.message:String(e));return false;}
    finally{
      syncingRef.current=false;
      if(mounted.current){
        setWorkspaceTask(null);
        const live=current.current;
        if(live?.handle.id===start.handle.id&&editor&&!editor.isDestroyed)editor.setEditable(mode==='edit');
        if(!blocked.current&&live?.handle.id===start.handle.id&&live.version!==live.savedVersion)timer.current=setTimeout(()=>void saveRef.current(),550);
      }
    }
  }
  function acceptProject(sent:Draft,result:ProjectOpenResult,created=false) {
    if(!mounted.current)return false;
    if(created&&result.warning&&result.session.project){
      const projectId=result.session.project.id,warning=result.warning;
      setCreationNotices(previous=>new Map(previous).set(projectId,warning));
    }
    if(!unchanged(sent)){setProjectError('项目操作已返回，但当前页又有输入，已保留当前稿件；请核对后重新选择项目。');return false;}
    apiRef.current=result.session;setSession(result.session);
    if(result.session.project)writeProjectPreference('last-project',result.session.project.id);
    setProjectRestoreNeeded(false);
    setProjects(previous=>({projects:result.projects,activeProjectId:result.session.project?.id,cloudAvailable:previous?.cloudAvailable||false}));refreshProjects();
    if(result.session.project)setDirection(result.session.project.defaultDirection);
    accept(result.session.document,result.snapshot);setContentPreviewOpen(false);setContentPreview(null);setContentError('');setContentMessage('');
    setRestoreOpen(false);setRestorePreview(null);setRestoreError('');
    setNotice(created?'':result.warning||'');return true;
  }
  async function switchProject(id:string) {
    if(!id||!projectRestoreNeeded&&id===apiRef.current?.project?.id&&apiRef.current.project.localPath===current.current?.handle.path)return;
    await projectTask('project',async sent=>acceptProject(sent,await api<ProjectOpenResult>('/api/projects/'+encodeURIComponent(id)+'/open','POST',{})));
  }
  async function createProject(input:CreateProjectInput) {
    if(projectRestoreNeeded){setProjectError('请先关闭此窗口并重新选择项目，恢复当前文档关联。');return false;}
    return projectTask('project',async sent=>acceptProject(sent,await api<ProjectOpenResult>('/api/projects','POST',input),true));
  }
  function beginBinding() {
    const project=apiRef.current?.project;
    if(!project||project.cloud||project.localPath!==current.current?.handle.path||!canBeginProject())return;
    setBindingProject(project);
  }
  async function bindProject(input:Omit<BindProjectInput,'revision'>) {
    const project=bindingProject;
    if(!project||projectRestoreNeeded||apiRef.current?.project?.id!==project.id)return false;
    return projectTask('project',async sent=>{
      const result=await api<ProjectOpenResult>('/api/projects/'+encodeURIComponent(project.id)+'/bind','POST',{...input,revision:sent.revision} satisfies BindProjectInput);
      if(result.session.project?.id!==project.id||result.session.document.path!==sent.handle.path)throw new Error('关联回执与当前项目不一致，请核对后重新打开项目。');
      return acceptProject(sent,result,true);
    });
  }
  async function changeSharedProjects(shared:boolean,path?:string):Promise<boolean> {
    if(!projectSettings)return false;
    if(projectSettings.shared===shared&&(!shared||!path||path===projectSettings.path))return true;
    return projectTask('project',async sent=>{
      ++projectSettingsRequest.current;
      const result=await api<ProjectOpenResult&{settings:ProjectSettings}>('/api/project-settings','POST',{shared,...(shared&&path?{path}:{})});
      if(!acceptProject(sent,result))return false;
      setProjectSettings(result.settings);return true;
    });
  }
  async function pickProjectPath():Promise<string|null> {
    let chosen:string|null=null;
    await projectTask('pick',async sent=>{
      const previous=apiRef.current?.project;
      if(!previous||previous.localPath!==sent.handle.path)throw new Error('请先选择一个项目，再浏览本地文件。');
      let picked:DocumentHandle|null=null;
      try{picked=await api<DocumentHandle|null>('/api/pick','POST',{});}
      finally{
        try{
          const restored=await api<ProjectOpenResult>('/api/projects/'+encodeURIComponent(previous.id)+'/open','POST',{});
          if(restored.session.project?.id!==previous.id||restored.session.document.id!==sent.handle.id)throw new Error('project mismatch');
          if(mounted.current){apiRef.current=restored.session;setSession(restored.session);}
        }catch{
          if(mounted.current)setProjectRestoreNeeded(true);
          throw new Error('文件选择后未能恢复当前项目，请关闭此窗口并重新选择项目后再创建。');
        }
      }
      if(!unchanged(sent))throw new Error('选择文件期间又有新输入，已保留当前稿件，请重新选择。');
      chosen=picked?.path||null;return true;
    });
    return chosen;
  }
  async function previewContent(selectedDirection:SyncDirection=direction) {
    const project=apiRef.current?.project;
    if(!project?.cloud||project.localPath!==current.current?.handle.path||syncingRef.current||savingRef.current||opening||blocked.current)return;
    setDirection(selectedDirection);setContentPreviewOpen(true);setContentPreview(null);setContentMessage('');setContentError('');
    await projectTask('content',async sent=>{
      const value=await api<ContentPreview>('/api/projects/'+encodeURIComponent(project.id)+'/preview','POST',{revision:sent.revision,direction:selectedDirection});
      if(!mounted.current)return false;
      if(!unchanged(sent)){setContentError('预览期间又有新输入，已保留当前稿件，请重新预览。');return false;}
      if(value.projectId!==project.id||value.direction!==selectedDirection)throw new Error('预览与当前项目或同步方向不一致，请重新预览。');
      setContentMessage('');setContentPreview({value,handleId:sent.handle.id,revision:sent.revision,version:sent.version});return true;
    });
  }
  async function applyPreparedContent(sent:Draft,project:ReviewProject,preview:ContentPreview) {
    const result=await api<ContentSyncResult>('/api/projects/'+encodeURIComponent(project.id)+'/sync','POST',{previewId:preview.id,adoptPublished:true});
    if(!mounted.current)return false;
    if(!unchanged(sent)){
      blocked.current=true;setConflict(true);setError('同步期间又有新输入，已保留页内改稿。请核对磁盘结果后处理冲突。');return false;
    }
    if(result.project.id!==project.id)throw new Error('同步回执与当前项目不一致，请重新打开项目。');
    const nextSession={...apiRef.current!,project:result.project,...(result.project.cloud?{cloud:{...result.project.cloud,localPath:result.project.localPath}}:{cloud:undefined})};
    apiRef.current=nextSession;setSession(nextSession);setProjects(previous=>previous?{...previous,projects:previous.projects.map(item=>item.id===project.id?result.project:item)}:previous);
    accept(sent.handle,result.snapshot);setContentPreviewOpen(false);setContentPreview(null);setContentMessage([result.summary,...result.warnings].join(' '));return true;
  }
  async function executeContent() {
    const preview=contentPreview,project=apiRef.current?.project,d=current.current;
    if(!contentPreviewOpen||!preview||!project||!d||preview.value.status==='equal'||syncingRef.current)return;
    const matches=(sent:Draft)=>preview.value.projectId===apiRef.current?.project?.id&&preview.value.direction===direction&&preview.handleId===sent.handle.id&&preview.version===sent.version&&preview.revision===sent.revision&&Number.isFinite(Date.parse(preview.value.expiresAt))&&Date.parse(preview.value.expiresAt)>Date.now();
    if(previewExpired||!matches(d)){
      setContentError('当前文档已改变或预览已过期，请重新预览后再同步。');return;
    }
    const completed=await projectTask('content',sent=>{
      if(!matches(sent))throw new Error('当前文档已改变或预览已过期，请重新预览后再同步。');
      return applyPreparedContent(sent,project,preview.value);
    });
    if(!completed&&mounted.current)setPreviewExpired(true);
  }

  async function previewRestore() {
    const project=apiRef.current?.project;
    if(!project||project.localPath!==current.current?.handle.path||projectRestoreNeeded||syncingRef.current||savingRef.current||opening||blocked.current)return;
    setRestoreOpen(true);setRestorePreview(null);setRestoreError('');setContentPreviewOpen(false);setContentPreview(null);setContentMessage('');
    await projectTask('restore',async sent=>{
      const value=await api<ContentRestorePreview>('/api/projects/'+encodeURIComponent(project.id)+'/restore-preview','POST',{revision:sent.revision});
      if(!mounted.current)return false;
      if(!unchanged(sent))throw new Error('读取快照期间又有新输入，已保留当前稿件，请重新预览。');
      if(value.localPath!==sent.handle.path||apiRef.current?.project?.id!==project.id)throw new Error('快照与当前文档不一致，请重新选择项目。');
      setRestorePreview({value,projectId:project.id,handleId:sent.handle.id,revision:sent.revision,version:sent.version});return true;
    });
  }
  async function executeRestore() {
    const preview=restorePreview,project=apiRef.current?.project,d=current.current;
    if(!restoreOpen||!preview||!project||!d||syncingRef.current)return;
    const matches=(sent:Draft)=>preview.projectId===apiRef.current?.project?.id&&preview.value.localPath===sent.handle.path&&preview.handleId===sent.handle.id&&preview.version===sent.version&&preview.revision===sent.revision&&Number.isFinite(Date.parse(preview.value.expiresAt))&&Date.parse(preview.value.expiresAt)>Date.now();
    if(restoreExpired||!matches(d)){setRestoreError('当前文档已改变或恢复预览已过期，请重新预览。');return;}
    const completed=await projectTask('restore',async sent=>{
      if(!matches(sent))throw new Error('当前文档已改变或恢复预览已过期，请重新预览。');
      const result=await api<ContentRestoreResult>('/api/projects/'+encodeURIComponent(project.id)+'/restore','POST',{previewId:preview.value.id});
      if(!mounted.current)return false;
      if(!unchanged(sent)){
        blocked.current=true;setConflict(true);setError('恢复期间又有新输入，已保留页内改稿。请核对磁盘结果后处理冲突。');return false;
      }
      accept(sent.handle,result.snapshot);setRestoreOpen(false);setRestorePreview(null);setRestoreError('');setContentMessage([result.summary,...result.warnings].join(' '));return true;
    });
    if(!completed&&mounted.current)setRestoreExpired(true);
  }

  async function reloadDisk() {
    if(syncingRef.current||!current.current || !window.confirm('本地文件已由其他窗口或 AI 修改。重新载入会放弃本页尚未保存的改动。确定重新载入吗？'))return;
    const start=current.current;
    try{
      const snap=await api<Snapshot>('/api/document?id='+encodeURIComponent(start.handle.id));
      if(current.current!==start||hasCommentDraft()){setNotice('读取期间又有新输入，已保留当前稿件。');return;}
      accept(start.handle,snap);
    }
    catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  async function copyPath(value:string,kind:'file'|'cloud') {
    try { await navigator.clipboard.writeText(value);if(mounted.current)setCopiedPath({kind,value}); }
    catch { if(mounted.current)setNotice(kind==='file'?'复制失败，可选中文件路径后手动复制。':'复制失败，可从“打开飞书文档”链接手动复制地址。'); }
  }
  function locate(anchor:Anchor) {
    if(anchor.state!=='attached'||!editor)return;
    if(anchor.target) {
      const result=locateWhiteboardComponent(editor,anchor);
      if(!result.element){setNotice(result.reason||'白板组件位置待确认，评论已保留。');return;}
      editor.commands.setNodeSelection(anchor.from);
      editor.view.dom.querySelectorAll('.lr-whiteboard-component-selected').forEach(element=>element.classList.remove('lr-whiteboard-component-selected'));
      result.element.classList.add('lr-whiteboard-component-selected');
      result.element.scrollIntoView({block:'center',inline:'nearest'});
      setSelection(anchor);setComponentSelected(true);setReviewOpen(false);return;
    }
    const node=editor.state.doc.nodeAt(anchor.from), chain=editor.chain();
    const atom=node?.isAtom&&!node.isText&&anchor.to===anchor.from+node.nodeSize;
    if(atom)chain.setNodeSelection(anchor.from);
    else chain.setTextSelection({from:anchor.from,to:anchor.to});
    if(editor.isEditable)chain.focus().scrollIntoView().run();
    else {
      chain.run();
      // ProseMirror does not take focus in read-only mode. Establish the native
      // selection as well, so scrolling and visible highlighting use this quote.
      const dom=editor.view.dom, document=dom.ownerDocument, range=document.createRange();
      dom.focus({preventScroll:true});
      const nodeDOM=atom?editor.view.nodeDOM(anchor.from):null;
      if(nodeDOM)range.selectNode(nodeDOM);
      else {
        const from=editor.view.domAtPos(anchor.from),to=editor.view.domAtPos(anchor.to);
        range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);
      }
      const nativeSelection=document.getSelection();
      nativeSelection?.removeAllRanges();nativeSelection?.addRange(range);
      editor.commands.scrollIntoView();
    }
    setReviewOpen(false);
  }
  function navigate(path:string,anchor?:Anchor) {
    const d=current.current;if(!d)return;
    if(xmlDraftRef.current&&path!==d.handle.name){setNotice(draftMessage(''));return;}
    const previous=selectedPath||d.handle.name;
    if(anchor&&mode==='source'){
      navigation.current={id:d.handle.id,path,anchor};setSelectedPath(path);changeMode('read');return;
    }
    if(previous===path){if(anchor)locate(anchor);return;}
    const key=d.handle.id+':'+previous;
    positions.current.set(key,{page:window.scrollY,preview:positions.current.get(key)?.preview||{top:0,left:0}});
    navigation.current={id:d.handle.id,path,anchor};
    setSelectedPath(path);
  }
  function navigateOutline(position:number) {
    const d=current.current;if(!d||syncingRef.current||opening)return false;
    if(xmlDraftRef.current){setNotice('源码尚未通过校验，请先修正或还原源码，再通过目录返回正文。输入已保留。');return false;}
    const previous=selectedPath||d.handle.name;
    if(previous!==d.handle.name){const key=d.handle.id+':'+previous;positions.current.set(key,{page:window.scrollY,preview:positions.current.get(key)?.preview||{top:0,left:0}});}
    if(previous!==d.handle.name||mode==='source'){
      navigation.current=null;outlineNavigation.current={id:d.handle.id,position};
      setSelectedPath(d.handle.name);if(mode==='source')setMode(lastVisualMode.current);
    }else scrollToHeading(editor,position);
    setNotice('');return true;
  }
  useLayoutEffect(()=>{
    const target=navigation.current;
    if(!draft||!target||target.id!==draft.handle.id||target.path!==(selectedPath||draft.handle.name))return;
    navigation.current=null;
    if(target.anchor)locate(target.anchor);
    else window.scrollTo({top:positions.current.get(target.id+':'+target.path)?.page||0,left:0,behavior:'auto'});
  },[draft?.handle.id,selectedPath,editor,mode]);
  useLayoutEffect(()=>{
    const target=outlineNavigation.current;
    if(!target||!draft||target.id!==draft.handle.id||mode==='source'||(selectedPath&&selectedPath!==draft.handle.name))return;
    outlineNavigation.current=null;scrollToHeading(editor,target.position);
  },[draft?.handle.id,selectedPath,editor,mode]);
  useLayoutEffect(()=>{
    if(!header.current)return;
    const measure=()=>{setHeaderHeight(header.current!.getBoundingClientRect().height);setNarrow(window.innerWidth<=1200);setCompact(window.innerWidth<=560);};
    measure();
    window.addEventListener('resize',measure);
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(header.current);
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[!!draft]);
  useEffect(()=>{
    editor?.view.setProps({scrollThreshold:{top:headerHeight+16,bottom:20,left:0,right:0},scrollMargin:{top:headerHeight+16,bottom:20,left:0,right:0}});
  },[editor,headerHeight]);
  useLayoutEffect(()=>{
    if(reviewOpen&&narrow&&reviewFocusPending.current){reviewFocusPending.current=false;reviewCloseButton.current?.focus({preventScroll:true});}
  },[reviewOpen,narrow]);
  function revealReview(focusPanel=false,trigger?:HTMLElement) {
    if(trigger)reviewReturnFocus.current=trigger;
    reviewFocusPending.current=focusPanel&&narrow;
    setReviewOpen(true);if(sidebar.current)sidebar.current.scrollTop=0;
    if(focusPanel&&narrow&&reviewOpen){reviewFocusPending.current=false;reviewCloseButton.current?.focus({preventScroll:true});}
  }
  function closeReview() {setReviewOpen(false);reviewFocusPending.current=false;(reviewReturnFocus.current?.isConnected?reviewReturnFocus.current:reviewButton.current)?.focus({preventScroll:true});}
  function selected(anchor:Anchor|null) {
    if(mode==='source'||xmlDraftRef.current)return;
    setSelection(anchor);setComponentSelected(!!anchor?.target);
    editor?.view.dom.querySelectorAll('.lr-whiteboard-component-selected').forEach(element=>element.classList.remove('lr-whiteboard-component-selected'));
    if(anchor?.target&&editor)locateWhiteboardComponent(editor,anchor).element?.classList.add('lr-whiteboard-component-selected');
    if(!anchor?.target)revealSelectedSource();
  }
  function revealSelectedSource() {
    setComponentSelected(false);
    editor?.view.dom.querySelectorAll('.lr-whiteboard-component-selected').forEach(element=>element.classList.remove('lr-whiteboard-component-selected'));
    const node=editor?.state.selection instanceof NodeSelection?editor.state.selection.node:null;
    if(mode==='edit'&&node&&(node.type.name==='xmlInlineLatex'||node.type.name==='xmlBlockLatex'||(node.attrs.lrTag==='whiteboard'&&readWhiteboardSource(node.attrs.rawXML))))revealReview();
  }
  if(!draft)return <main className="loading"><BookOpen size={28}/><p>{error||'正在打开本地文档…'}</p></main>;
  const openCount=draft.review.comments.filter(c=>c.status==='open').length;
  const comments=draft.review.comments.filter(c=>showResolved||c.status==='open');
  const saved=!saving&&draft.version===draft.savedVersion;
  const activeProject=!projectRestoreNeeded&&session?.project?.localPath===draft.handle.path?session.project:undefined;
  const legacyCloud=!projectRestoreNeeded&&!session?.project&&session?.cloud?.localPath===draft.handle.path?session.cloud:undefined;
  const cloud=activeProject?.cloud?{...activeProject.cloud,localPath:activeProject.localPath}:legacyCloud;
  const workspaceLocked=syncing||workspaceTask!==null;
  const previewStale=!!contentPreview&&(previewExpired||contentPreview.value.direction!==direction||contentPreview.handleId!==draft.handle.id||contentPreview.version!==draft.version||contentPreview.revision!==draft.revision||contentPreview.value.projectId!==activeProject?.id);
  const restoreStale=!!restorePreview&&(restoreExpired||restorePreview.handleId!==draft.handle.id||restorePreview.version!==draft.version||restorePreview.revision!==draft.revision||restorePreview.projectId!==activeProject?.id);
  const files=projectFiles(draft.handle,draft.xml,draft.review);
  const selectedFile=files.find(file=>file.path===selectedPath)||files[0];
  const documentActive=selectedFile.kind==='document';
  const selectedFullPath=draft.handle.path.slice(0,draft.handle.path.lastIndexOf('/')+1)+selectedFile.path;
  const filePathCopied=copiedPath?.kind==='file'&&copiedPath.value===selectedFullPath;
  const cloudPathCopied=copiedPath?.kind==='cloud'&&copiedPath.value===cloud?.url;
  const formatTools=[
    {name:'加粗',icon:<Bold size={15}/>,run:()=>editor?.chain().focus().toggleBold().run()},
    {name:'斜体',icon:<Italic size={15}/>,run:()=>editor?.chain().focus().toggleItalic().run()},
    {name:'列表',icon:<List size={16}/>,run:()=>editor?.chain().focus().toggleBulletList().run()},
    {name:'行内代码',icon:<Code size={16}/>,run:()=>editor?.chain().focus().toggleCode().run()},
    {name:'引用',icon:<Quote size={15}/>,run:()=>editor?.chain().focus().toggleBlockquote().run()},
  ];
  return <div className="app" onInputCapture={()=>setNotice('')} style={{'--workspace-header-height':headerHeight+'px'} as React.CSSProperties}>
    <fieldset className="sync-protected-controls" disabled={workspaceLocked}>
    <div className="workspace-header" ref={header} onClickCapture={event=>{if((event.target as Element).closest('.project-operations>summary,.project-action-button,.format-overflow>summary,.project-picker-trigger'))setReviewOpen(false);}}>
    <header className="document-context" aria-label="文档工作区">
      <div className="project-context"><div className="document-identity"><button type="button" className="file-panel-toggle" aria-label={treeOpen?'收起文档导航':'展开文档导航'} title={treeOpen?'收起目录与文件':'展开目录与文件'} aria-controls="document-navigation" aria-expanded={treeOpen} onClick={event=>{event.currentTarget.focus({preventScroll:true});setTreeOpen(value=>!value);}}>{treeOpen?<PanelLeftClose size={20}/>:<PanelLeftOpen size={20}/>}</button>
        {projects?<Projects active={activeProject} list={projects} busy={workspaceLocked||saving||opening} error={projectError} nativePicker={!!session?.nativePicker} homeDirectory={session?.homeDirectory} requiresProjectSelection={projectRestoreNeeded} settings={projectSettings} onSharedChange={changeSharedProjects} onBegin={canBeginProject} onSwitch={id=>void switchProject(id)} onCreate={createProject} onPick={pickProjectPath} onOpen={()=>void openDocument(session?.nativePicker||false)} onRestore={()=>void previewRestore()} onCreatingChange={setCreatingProject}/>:<><strong className="local-document-name">{draft.handle.name}</strong><ProjectActionButton kind="open" busy={workspaceLocked||saving||opening} onClick={()=>void openDocument(session?.nativePicker||false)}/></>}
      </div><nav className="file-path-bar" aria-label="当前文件"><span className="file-path-kind">{documentActive?'正文':'资源'}</span>
        <span className="file-path-value"><span className="file-path-measure" aria-hidden="true">{selectedFullPath}</span><input aria-label="当前文件路径" readOnly title={selectedFullPath} value={selectedFullPath} onFocus={event=>event.currentTarget.select()}/></span>
        <button type="button" className={'path-copy-button'+(filePathCopied?' copied':'')} aria-label="复制文件路径" title={filePathCopied?'已复制文件路径':'复制文件路径'} onClick={()=>void copyPath(selectedFullPath,'file')}>{filePathCopied?<Check size={14} aria-hidden="true"/>:<Copy size={14} aria-hidden="true"/>}</button>
      </nav></div>
      <div className="remote-context"><div className="remote-actions">{activeProject&&!activeProject.cloud&&<button type="button" className="open-cloud-document" disabled={workspaceLocked||saving||opening||conflict} onClick={beginBinding}>关联飞书<ExternalLink size={13}/></button>}{cloud&&<a className="open-cloud-document" href={cloud.url} title={cloud.url} target="_blank" rel="noopener noreferrer">打开飞书文档<ExternalLink size={13}/></a>}
        {activeProject?.cloud&&<ContentSyncControls busy={workspaceTask==='content'} disabled={workspaceLocked||saving||opening||conflict} onPreview={()=>void previewContent()}/>}
      </div><div className="document-status">{activeProject?.cloud&&!documentActive?<span className="sync-source-name" title={draft.handle.name}>正文同步：{draft.handle.name}</span>:cloud&&<span className="cloud-binding-path"><span className="cloud-binding" aria-label="当前飞书绑定" title={cloud.url}>{cloud.url.replace(/^https?:\/\//,'')}</span><button type="button" className={'path-copy-button'+(cloudPathCopied?' copied':'')} aria-label="复制飞书链接" title={cloudPathCopied?'已复制飞书链接':'复制飞书链接'} onClick={()=>void copyPath(cloud.url,'cloud')}>{cloudPathCopied?<Check size={14} aria-hidden="true"/>:<Copy size={14} aria-hidden="true"/>}</button></span>}<span className={'save-state '+(saved&&!sourceDirty&&!xmlDraft?'saved':'')}><span/>{conflict?'保存有冲突':xmlDraft?'源码未保存':saving?'正在保存':sourceDirty?'有未应用的修改':saved?'已保存到本地':'等待保存'}</span></div></div>
      <span className="copy-announcement" role="status">{filePathCopied?'已复制文件路径':cloudPathCopied?'已复制飞书链接':''}</span>
    </header>
    <div className="workspace-bar">{documentActive?<div className="mode-switch" role="group" aria-label="文档模式"><button aria-pressed={mode==='edit'} className={mode==='edit'?'selected':''} onClick={()=>changeMode('edit')}><PencilLine size={15}/>编辑</button><button aria-pressed={mode==='read'} className={mode==='read'?'selected':''} onClick={()=>changeMode('read')}><BookOpen size={15}/>只读</button><button aria-pressed={mode==='source'} className={mode==='source'?'selected':''} onClick={()=>changeMode('source')}><Code size={15}/>源码</button></div>:<span className="resource-mode-label">资源 · 只读</span>}
      {mode==='edit'&&documentActive&&(compact?<details className="format-overflow" onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))event.currentTarget.open=false;}} onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();event.stopPropagation();}}}><summary tabIndex={0}>格式<ChevronDown size={12}/></summary><div aria-label="文字格式">{formatTools.map(tool=><button key={tool.name} onMouseDown={e=>e.preventDefault()} onClick={event=>{event.currentTarget.closest('details')!.open=false;tool.run();}}>{tool.icon}{tool.name}</button>)}</div></details>:<div className="format-tools" aria-label="文字格式">{formatTools.map(tool=><button title={tool.name} aria-label={tool.name} key={tool.name} onMouseDown={e=>e.preventDefault()} onClick={tool.run}>{tool.icon}</button>)}</div>)}
      {documentActive&&mode==='source'&&<span className="mode-hint">DocxXML · 校验通过后自动保存</span>}
      {documentActive&&mode!=='source'&&!xmlDraft&&selection&&!pending&&<button className="selection-action" onMouseDown={e=>e.preventDefault()} onClick={event=>{setPending(selection);setBody('');revealReview(false,event.currentTarget);}}><MessageSquarePlus size={17}/>{selection.target?'评论选中组件':'评论选中内容'}</button>}{!documentActive&&<button className="return-document" onClick={()=>navigate(draft.handle.name)}>返回正文</button>}<button ref={reviewButton} className="comment-count" aria-label="查看评论" aria-expanded={narrow?reviewOpen:undefined} aria-controls="review-panel" onClick={event=>revealReview(true,event.currentTarget)}><MessageSquare size={15}/><span className="comment-label">评论</span><span className="comment-number">{openCount}</span></button>
    </div>
    </div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span>{conflict?<button onClick={()=>void reloadDisk()}>重新载入磁盘版本</button>:<button onClick={()=>{setError('');void save();}}>重试保存</button>}</div>}
    {xmlDraft&&<div className="notice" role="status"><span>源码尚未通过校验，输入已保留但未保存。修正或还原后可继续编辑正文；只读预览显示最近有效内容。</span><button onClick={()=>{setXMLDraft(null);setNotice('已还原到最近有效源码。');}}>还原源码</button></div>}
    {notice&&<div className="notice">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={14}/></button></div>}
    {projectError&&!creatingProject&&!bindingProject&&<div className="error-banner project-error" role="alert">{projectError}</div>}
    {activeProject&&<HistoryRestore project={activeProject} open={restoreOpen} busy={workspaceTask==='restore'} disabled={workspaceLocked||saving||opening||conflict} preview={restorePreview?.value||null} stale={restoreStale} error={restoreError} onPreview={()=>void previewRestore()} onExecute={()=>void executeRestore()} onClose={()=>{setRestoreOpen(false);setRestorePreview(null);setRestoreError('');}}/>}
    {!activeProject?.cloud&&contentMessage&&<p className="content-sync-status" role="status">{contentMessage}</p>}
    {bindingProject&&<BindCloud project={bindingProject} cloudAvailable={!!projects?.cloudAvailable} busy={workspaceTask!==null} error={projectError} onClose={()=>{setBindingProject(null);setProjectError('');}} onBind={bindProject}/>}{activeProject?.cloud&&<ContentSync project={activeProject} direction={direction} open={contentPreviewOpen} busy={workspaceTask==='content'} disabled={workspaceLocked||saving||opening||conflict} preview={contentPreview?.value||null} stale={previewStale} error={contentError} message={contentMessage} onDirection={value=>void previewContent(value)} onPreview={()=>void previewContent()} onExecute={()=>void executeContent()} onClose={()=>{setContentPreviewOpen(false);setContentPreview(null);setContentError('');}}/>}
    {activeProject&&creationNotices.has(activeProject.id)&&<ProjectCreationNotice message={creationNotices.get(activeProject.id)!} onClose={()=>setCreationNotices(previous=>{const next=new Map(previous);next.delete(activeProject.id);return next;})}/>}
    <main className={'workspace project-workspace '+(treeOpen?'tree-open':'tree-closed')}>
      <aside id="document-navigation" className="document-navigation" hidden={!treeOpen} aria-label="目录与文件">
        <div className="document-navigation-tabs" role="group" aria-label="导航内容">
          <button type="button" aria-pressed={navigationTab==='outline'} className={navigationTab==='outline'?'selected':''} onMouseDown={event=>event.preventDefault()} onClick={()=>setNavigationTab('outline')}>目录</button>
          <button type="button" aria-pressed={navigationTab==='files'} className={navigationTab==='files'?'selected':''} onMouseDown={event=>event.preventDefault()} onClick={()=>setNavigationTab('files')}>文件</button>
        </div>
        <div hidden={navigationTab!=='outline'}><DocumentOutline editor={editor} revision={draft.xml} collapsed={false} showToggle={false} onToggle={()=>setTreeOpen(value=>!value)} onNavigate={navigateOutline}/></div>
        <ProjectExplorer key={draft.handle.id} open={treeOpen&&navigationTab==='files'} handle={draft.handle} xml={draft.xml} review={draft.review} selected={selectedFile.path} onSelect={file=>navigate(file.path)} dirty={!saved||!!xmlDraft}/>
      </aside>
      <div className="document-stage"><section hidden={!documentActive||mode==='source'} className={'paper '+(mode==='read'?'read-mode':'')} onClick={event=>{if((event.target as Element).closest('.document-content'))revealSelectedSource();}}>
      <Reader key={draft.handle.id} xml={draft.xml} readOnly={mode!=='edit'||!!xmlDraft||workspaceLocked} assetURL={p=>'/api/asset?id='+encodeURIComponent(draft.handle.id)+'&path='+encodeURIComponent(p)} comments={draft.review.comments} getReview={()=>current.current!.review} getDraft={()=>pendingRef.current} onReady={setEditor} onError={setError} onSelection={selected} onEdit={(xml,comments,anchor)=>{if(mode==='source'||xmlDraftRef.current)return;const d=current.current!;setPending(anchor);changed(xml,{...d.review,comments,operations:[...d.review.operations.filter(o=>o.id!=='current-edit'),{id:'current-edit',type:'document.edit',author:'我',at:new Date().toISOString(),summary:'在浏览器编辑正文；与 baselineXML 比较可查看完整改动'}]});}}/>

    </section><section hidden={!documentActive||mode!=='source'}><SourceEditor key={draft.handle.id} value={xmlDraft?.value??draft.xml} error={xmlDraft?.error} readOnly={mode!=='source'||workspaceLocked||opening} onChange={editSource}/></section>{!documentActive&&<ResourcePreview key={draft.handle.id+':'+selectedFile.path} file={selectedFile} handle={draft.handle} review={draft.review} xml={draft.xml} initialScroll={positions.current.get(draft.handle.id+':'+selectedFile.path)?.preview} onScrollChange={preview=>{const key=draft.handle.id+':'+selectedFile.path;positions.current.set(key,{page:positions.current.get(key)?.page||0,preview});}}/>}</div>
    <aside id="review-panel" ref={sidebar} tabIndex={-1} onBlur={event=>{if(narrow&&event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))setReviewOpen(false);}} onKeyDown={event=>{if(event.key==='Escape'&&narrow){event.stopPropagation();closeReview();}}} aria-label="评论与内容编辑" className={"review-sidebar "+(reviewOpen?"review-open":"")}><div className="sidebar-heading"><h2>评论</h2><button ref={reviewCloseButton} className="close-review" aria-label="关闭评论面板" onClick={closeReview}><X size={17}/></button></div>{!documentActive&&<p className="sidebar-intro">{`以下评论仍属于正文 ${draft.handle.name}。点击 XML 可返回编辑。`}</p>}
      {cloud&&<CloudSync syncing={syncing} disabled={saving||opening||conflict} pending={draft.review.cloudSync?.pending} report={syncReport} error={syncError} onSync={()=>void syncComments()}/>}
      <div hidden={!documentActive||mode==='source'||componentSelected}><FormulaEditor key={"formula:"+draft.handle.id} editor={editor} readOnly={mode!=='edit'||!!xmlDraft||workspaceLocked} onDraftChange={formulaDraftChanged} persistence={{initial:sourceSnapshots.current.formula,onChange:value=>sourceSnapshotChanged('formula',value)}}/>
      <WhiteboardEditor key={"whiteboard:"+draft.handle.id} editor={editor} readOnly={mode!=='edit'||!!xmlDraft||workspaceLocked} onDraftChange={whiteboardDraftChanged} persistence={{initial:sourceSnapshots.current.whiteboard,onChange:value=>sourceSnapshotChanged('whiteboard',value)}}/></div>
      {pending&&<form className="comment-composer" onSubmit={e=>{e.preventDefault();addComment();}}><div className="composer-heading"><strong>留下你的想法</strong><button type="button" aria-label="取消评论" onClick={()=>{setPending(null);setBody('');}}><X size={16}/></button></div><blockquote>{pending.quote}</blockquote>{pending.state==='deleted'&&<small>引用内容已删除，仍可保留这条意见。</small>}<textarea autoFocus placeholder="你希望这里怎么调整？" aria-label="评论内容" value={body} onChange={e=>setBody(e.target.value)}/><button className="primary" disabled={!body.trim()}>添加评论<ArrowUp size={15}/></button></form>}
      {documentActive&&comments.length===0&&!pending&&<p className="comments-empty-hint">{mode==='source'?'切换到编辑或只读模式，可选中正文或图中组件评论。':'选中正文或图中组件，留下修改意见。'}</p>}
      <div className="comments">{comments.map(c=><CommentCard key={c.id} comment={c} reply={replyDrafts[c.id]||''} setReply={value=>setReplies({...replyDraftsRef.current,[c.id]:value})} onLocate={()=>navigate(draft.handle.name,c.anchor)} onResolve={()=>updateComment(c.id,v=>({...v,status:v.status==='open'?'resolved':'open'}),'更新评论状态')} onReply={body=>updateComment(c.id,v=>({...v,replies:[...v.replies,{id:uid(),author:'我',body,createdAt:new Date().toISOString()}]}),'回复评论')}/>)}</div>
      {draft.review.comments.some(c=>c.status==='resolved')&&<button className="resolved-toggle" onClick={()=>setShowResolved(!showResolved)}>{showResolved?'隐藏已解决评论':'查看已解决评论'}</button>}
      {draft.review.result&&<div className="ai-receipt"><strong>{draft.review.result.author} 的处理记录</strong><p>{draft.review.result.summary}</p></div>}
    </aside></main>
    {pathDialog&&<OpenDocumentDialog path={path} error={pathError} busy={opening||workspaceLocked} onPathChange={value=>{setPath(value);setPathError('');}} onOpen={()=>void openDocument(false)} onClose={()=>setPathDialog(false)}/>}
    </fieldset>
  </div>;
}
