import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FolderPlus, FolderOpen, Settings2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { CreateProjectInput, ProjectList, ReviewProject, SyncDirection } from '../core/projects';
import { ProjectPicker } from './ProjectPicker';
import { SegmentedControl, syncDirectionOptions } from './SegmentedControl';
import { projectDestination } from './project-path';
import './project-actions.css';

export interface ProjectSettings { shared:boolean; path:string; sharedPath?:string; hasSharedPath?:boolean; defaultSharedPath?:string; }
type Preference='directory'|'last-project';
export function readProjectPreference(key:Preference):string {try{return localStorage.getItem('lark-review.'+key)||'';}catch{return '';}}
export function writeProjectPreference(key:Preference,value:string) {try{localStorage.setItem('lark-review.'+key,value);}catch{/* Project metadata remains durable on the server when browser storage is unavailable. */}}
const directoryOf=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/';
function configurationDirectory(value:string,homeDirectory?:string) {
  const input=value.trim();
  const expanded=input==='~'||input.startsWith('~/')?homeDirectory?homeDirectory+input.slice(1):'':input;
  if(!expanded.startsWith('/')||/[\u0000-\u001f\u007f]/.test(expanded))return {path:'',error:'请输入完整目录路径，或使用 ~/ 开头的路径。'};
  const path=expanded.replace(/\/+$/,'')||'/';
  if(path.endsWith('/projects.json'))return {path,error:'请输入目录，不需要填写 projects.json 文件名。'};
  return {path,error:''};
}
interface Props {
  active?: ReviewProject;
  list: ProjectList;
  busy: boolean;
  error: string;
  nativePicker: boolean;
  homeDirectory?:string;
  requiresProjectSelection: boolean;
  settings: ProjectSettings | null;
  onSharedChange(shared:boolean,path?:string): Promise<boolean>;
  onBegin(): boolean;
  onSwitch(id: string): void;
  onCreate(input: CreateProjectInput): Promise<boolean>;
  onPick(): Promise<string | null>;
  onOpen(): void;
  onRestore(): void;
  onCreatingChange(creating:boolean): void;
}
export function ProjectActionButton({ kind, busy, onClick }: { kind:'create'|'open'; busy:boolean; onClick():void }) {
  const id=useId(),button=useRef<HTMLButtonElement>(null);
  const [hovered,setHovered]=useState(false),[focused,setFocused]=useState(false),[dismissed,setDismissed]=useState(false);
  const [position,setPosition]=useState<{left:number;top:number;width:number}|null>(null);
  const visible=!busy&&!dismissed&&(hovered||focused);
  const description=kind==='create'
    ? '新建 XML，或选择已有 XML 建立项目。每个项目对应一篇正文，需要时再关联飞书。'
    : '选择另一份本地文档继续编辑；已有项目会恢复关联。不会向当前项目添加文件。';
  useLayoutEffect(()=>{
    if(!visible||!button.current)return;
    const measure=()=>{
      const rect=button.current!.getBoundingClientRect(),width=Math.min(290,window.innerWidth-24);
      setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:rect.bottom+8,width});
    };
    measure();window.addEventListener('resize',measure);document.addEventListener('scroll',measure,true);
    return()=>{window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);};
  },[visible]);
  return <>
    <button ref={button} type="button" className={'project-action-button project-action-'+kind} disabled={busy}
      aria-describedby={visible?id:undefined} onPointerEnter={()=>{setHovered(true);setDismissed(false);}} onPointerLeave={()=>setHovered(false)}
      onFocus={()=>{setFocused(true);setDismissed(false);}} onBlur={()=>setFocused(false)}
      onKeyDown={event=>{if(event.key==='Escape'&&visible){setDismissed(true);event.stopPropagation();}}}
      onClick={()=>{setDismissed(true);onClick();}}>
      {kind==='create'?<FolderPlus size={15} aria-hidden="true"/>:<FolderOpen size={15} aria-hidden="true"/>}{kind==='create'?'新建项目':'切换文档'}
    </button>
    {visible&&position&&createPortal(<div id={id} role="tooltip" className="project-action-tooltip" style={position}>{description}</div>,document.body)}
  </>;
}
function ProjectManagement({ busy, children }: { busy:boolean; children:ReactNode }) {
  const menu=useRef<HTMLDetailsElement>(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState<{left:number;top:number;width:number;maxHeight:number}|null>(null);
  function close(restoreFocus=false) {if(menu.current){menu.current.open=false;setOpen(false);if(restoreFocus)menu.current.querySelector('summary')?.focus();}}
  useLayoutEffect(()=>{
    if(!open||!menu.current)return;
    const measure=()=>{
      const rect=menu.current!.querySelector('summary')!.getBoundingClientRect(),width=Math.min(360,window.innerWidth-24);
      setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:rect.bottom+6,width,maxHeight:Math.max(0,window.innerHeight-rect.bottom-18)});
    };
    measure();window.addEventListener('resize',measure);document.addEventListener('scroll',measure,true);
    return()=>{window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);};
  },[open]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(!busy&&menu.current?.open&&!menu.current.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[busy]);
  return <details ref={menu} className="project-operations project-management" onToggle={event=>setOpen(event.currentTarget.open)}
    onBlur={event=>{if(!busy&&event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))close();}} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();close(true);}}}>
    <summary tabIndex={busy?-1:0} aria-disabled={busy} onClick={event=>{if(busy)event.preventDefault();}}><Settings2 size={15} aria-hidden="true"/>项目管理</summary>
    <div className="project-operations-panel" role="group" aria-label="项目管理设置" style={position||undefined}>{children}</div>
  </details>;
}
export function containDialogFocus(event:KeyboardEvent<HTMLElement>) {
  if(event.key!=='Tab')return;
  const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]')).filter(element=>{
    if(element.matches(':disabled')||element.tabIndex<0||element.closest('[hidden],[inert]'))return false;
    // Only a closed details element's own first summary remains visible. A
    // nested summary is still hidden by its closed outer disclosure.
    for(let parent=element.parentElement;parent&&parent!==event.currentTarget;parent=parent.parentElement){
      if(parent.matches('details:not([open])')&&!Array.from(parent.children).find(child=>child.tagName==='SUMMARY')?.contains(element))return false;
    }
    return true;
  });
  const first=controls[0],last=controls.at(-1);if(!first)return;
  const current=document.activeElement;
  if(event.shiftKey&&(current===first||!event.currentTarget.contains(current)||current===event.currentTarget)){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(current===last||!event.currentTarget.contains(current)||current===event.currentTarget)){event.preventDefault();first.focus();}
}
export function Projects({ active, list, busy, error, nativePicker, homeDirectory, requiresProjectSelection, settings, onSharedChange, onBegin, onSwitch, onCreate, onPick, onOpen, onRestore, onCreatingChange }: Props) {
  const [creating, setCreating] = useState(false);
  useEffect(()=>onCreatingChange(creating),[creating,onCreatingChange]);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [localKind, setLocalKind] = useState<'existing' | 'new'>('existing');
  const [cloudKind, setCloudKind] = useState<'none' | 'existing' | 'new'>('none');
  const [url, setURL] = useState('');
  const [title, setTitle] = useState('');
  const [parentToken, setParentToken] = useState('');
  const [direction, setDirection] = useState<SyncDirection>('pull');
  const [editingDirectory,setEditingDirectory]=useState(false),[configurationPath,setConfigurationPath]=useState('');
  const [savingDirectory,setSavingDirectory]=useState(false),[configurationError,setConfigurationError]=useState('');
  const directoryInput=useRef<HTMLInputElement>(null),modifyDirectory=useRef<HTMLButtonElement>(null),directoryInFlight=useRef(false);
  const activeDirectory=settings?directoryOf(settings.path):'';
  useEffect(()=>{
    if(!editingDirectory)setConfigurationPath(activeDirectory);
  },[activeDirectory,editingDirectory]);
  useEffect(()=>{if(editingDirectory){directoryInput.current?.focus();directoryInput.current?.select();}},[editingDirectory]);
  const chosenDirectory=configurationDirectory(configurationPath,homeDirectory);
  const directoryLocked=busy||savingDirectory;
  function cancelDirectory() {
    setEditingDirectory(false);setConfigurationPath(activeDirectory);setConfigurationError('');
    requestAnimationFrame(()=>modifyDirectory.current?.focus());
  }
  async function saveDirectory() {
    if(directoryLocked||directoryInFlight.current||chosenDirectory.error||!settings)return;
    if(chosenDirectory.path===activeDirectory){cancelDirectory();return;}
    directoryInFlight.current=true;setSavingDirectory(true);setConfigurationError('');
    try {
      if(await onSharedChange(true,chosenDirectory.path.replace(/\/+$/,'')+'/projects.json')) {
        setEditingDirectory(false);requestAnimationFrame(()=>modifyDirectory.current?.focus());
      }
    } catch(failure) {setConfigurationError(failure instanceof Error?failure.message:'配置路径保存失败，请重试。');}
    finally {directoryInFlight.current=false;setSavingDirectory(false);}
  }
  const dialog=useRef<HTMLFormElement>(null);
  useEffect(()=>{
    if(!creating)return;
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')?.focus();
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[creating]);
  function begin() { if (onBegin()) setCreating(true); }
  const defaultDirectory=active?directoryOf(active.localPath):homeDirectory;
  const destination=projectDestination({path,name,kind:localKind,homeDirectory,defaultDirectory});
  const valid = !requiresProjectSelection && name.trim() && !destination.error &&
    (cloudKind === 'none' || (list.cloudAvailable && (cloudKind === 'existing' ? /^https:\/\//.test(url.trim()) : title.trim())));
  return <>
    <div className="projects-control" aria-label="项目切换">
      <ProjectPicker projects={list.projects} active={active} disabled={busy} onSwitch={onSwitch}/>
      <ProjectActionButton kind="create" busy={busy} onClick={begin}/>
      <ProjectActionButton kind="open" busy={busy} onClick={onOpen}/>
      <ProjectManagement busy={directoryLocked}><form className="project-settings configuration-settings" onSubmit={event=>{event.preventDefault();void saveDirectory();}}
        onKeyDown={event=>{if(event.key==='Escape'&&editingDirectory&&!directoryLocked){event.stopPropagation();event.preventDefault();cancelDirectory();}}}>
        <label>项目配置路径<input ref={directoryInput} aria-label="项目配置路径" aria-describedby="configuration-path-help" readOnly={!editingDirectory} disabled={directoryLocked||!settings}
          value={settings?configurationPath:'正在读取…'} onChange={event=>setConfigurationPath(event.target.value)} onFocus={event=>{if(!editingDirectory)event.currentTarget.select();}} placeholder="~/.lark-review/"/></label>
        <p id="configuration-path-help">{editingDirectory?<>当前使用：<code>{activeDirectory}</code>。保存后保留现有项目，并合并目标目录中的项目。</>:'默认 ~/.lark-review/，正文和评论仍在文章旁边。'}</p>
        {editingDirectory&&chosenDirectory.error&&<p className="project-error" role="status">{chosenDirectory.error}</p>}
        {editingDirectory&&(configurationError||error)&&<p className="project-error" role="alert">{configurationError||error}</p>}
        <div className="configuration-path-actions">{editingDirectory?<><button type="button" disabled={directoryLocked} onClick={cancelDirectory}>取消</button>
          <button type="submit" className="primary" disabled={directoryLocked||!settings||!!chosenDirectory.error}>{savingDirectory?'正在保存…':'保存'}</button></>
          :<button ref={modifyDirectory} type="button" disabled={busy||!settings} onClick={()=>{setConfigurationPath(activeDirectory);setConfigurationError('');setEditingDirectory(true);}}>修改</button>}</div>
      </form>{active&&<div className="project-history-actions"><span>当前文档</span><button type="button" disabled={busy||editingDirectory||requiresProjectSelection} onClick={event=>{
        const management=event.currentTarget.closest('details');if(management){management.open=false;management.querySelector('summary')?.focus();}
        onRestore();
      }}>恢复上一快照</button></div>}</ProjectManagement>
    </div>
    {creating && createPortal(<div className="modal-overlay project-modal" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); setCreating(false); } }}>
      <form ref={dialog} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onKeyDown={containDialogFocus} onSubmit={async event => {
        event.preventDefault(); if (!valid || busy) return;
        const input: CreateProjectInput = { name: name.trim(), local: { kind: localKind, path: destination.path }, defaultDirection: direction,
          cloud: cloudKind === 'none' ? { kind: 'none' } : cloudKind === 'existing' ? { kind: 'existing', url: url.trim() } :
            { kind: 'new', title: title.trim(), ...(parentToken.trim() ? { parentToken: parentToken.trim() } : {}) } };
        if (await onCreate(input)) { setCreating(false); setName(''); setPath(''); setURL(''); setTitle(''); setParentToken(''); }
      }}>
        <fieldset className="sync-protected-controls" disabled={busy}>
        <div className="project-dialog-heading"><h2 id="new-project-title">新建项目</h2><button type="button" aria-label="关闭新建项目" disabled={busy} onClick={() => setCreating(false)}><X size={18}/></button></div>
        <label>项目名称<input aria-label="项目名称" value={name} onChange={event => setName(event.target.value)} required/></label>
        <div className="project-choice-field"><span>本地文档</span><SegmentedControl label="本地文档方式" value={localKind} disabled={busy} onChange={setLocalKind}
          options={[{value:'existing',label:'选择已有 XML'},{value:'new',label:'创建新的 XML'}]}/></div>
        <div className="project-path-input"><label>{localKind==='new'?'保存位置（目录或 XML 文件）':'文件完整路径'}<input aria-label="项目文件路径" aria-describedby="project-path-help" aria-invalid={!!path&&!!destination.error} value={path} onChange={event => setPath(event.target.value)} placeholder={localKind==='new'?defaultDirectory||'~/':'/Users/you/articles/article.xml'} required={localKind==='existing'}/></label>
          {nativePicker && localKind === 'existing' && <button type="button" disabled={busy} onClick={async () => { const selected = await onPick(); if (selected) setPath(selected); }}><FolderOpen size={15}/>浏览</button>}</div>
        <p id="project-path-help" className="project-help" aria-live="polite">{destination.error||<>{localKind==='new'?'保存到：':'打开：'}<code>{destination.path}</code></>}</p>
        <div className="project-choice-field"><span>飞书文档</span><SegmentedControl label="飞书关联方式" value={cloudKind} disabled={busy} onChange={setCloudKind}
          options={[{value:'none',label:'仅保存在本地'},{value:'existing',label:'关联已有文档',disabled:!list.cloudAvailable},{value:'new',label:'新建飞书文档',disabled:!list.cloudAvailable}]}/></div>
        {!list.cloudAvailable && <p className="project-help">当前服务未配置飞书连接，可以先创建本地项目。</p>}
        {cloudKind === 'existing' && <label>飞书链接<input type="url" aria-label="飞书文档链接" value={url} onChange={event => setURL(event.target.value)} placeholder="https://…/docx/…" required/></label>}
        {cloudKind === 'new' && <><label>飞书文档标题<input aria-label="飞书文档标题" value={title} onChange={event => setTitle(event.target.value)} required/></label>
          <details><summary tabIndex={0}>指定飞书文件夹（可选）</summary><label>文件夹 Token<input aria-label="飞书文件夹 Token" value={parentToken} onChange={event => setParentToken(event.target.value)}/></label></details></>}
        {cloudKind !== 'none' && <div className="project-choice-field"><span>默认同步方向</span><SegmentedControl label="默认同步方向" value={direction} disabled={busy} options={syncDirectionOptions} onChange={setDirection}/></div>}
        <p className="project-help">{cloudKind==='none'?'正文和评论保存在本地，需要时可再关联飞书。':cloudKind==='new'?'将本地文章发布为一篇新的飞书文档，并建立项目关联。':localKind === 'new' ? '首次会把飞书正文保存到这个新文件；已有文件不会被覆盖。' : '已有文件只建立项目关联。后续同步正文前，先查看两端差异。'}</p>
        {error && <p role="alert" className="project-error">{error}</p>}
        <div className="project-dialog-actions"><button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={!valid || busy}>
          {busy ? '正在处理…' : cloudKind === 'new' ? '创建项目并发布到飞书' : '创建项目'}</button></div>
        </fieldset>
      </form>
    </div>,document.body)}
  </>;
}
