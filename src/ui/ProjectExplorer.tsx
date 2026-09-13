import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FileJson, File, Folder, FolderOpen, Image, RefreshCw } from 'lucide-react';
import type { DocumentHandle, Review } from '../core/types';
import { isProjectImage, projectFiles, type ProjectFile } from '../core/project-files';

type Branch = { name: string; path: string; children: Map<string, Branch>; file?: ProjectFile };
export function ProjectExplorer({handle,xml,review,selected,onSelect,dirty,open=true}:{handle:DocumentHandle;xml:string;review:Review;selected:string;onSelect:(file:ProjectFile)=>void;dirty:boolean;open?:boolean}) {
  const [closed,setClosed] = useState<Set<string>>(new Set());
  const panel=useRef<HTMLElement>(null);
  const scroll=useRef({top:0,left:0});
  const wasOpen=useRef(open);
  useLayoutEffect(()=>{
    if(open&&!wasOpen.current&&panel.current){
      panel.current.scrollTop=scroll.current.top;panel.current.scrollLeft=scroll.current.left;
    }
    wasOpen.current=open;
  },[open]);
  const folder = handle.path.slice(0,-handle.name.length).replace(/\/$/,'');
  const tree = useMemo(()=>{
    const root:Branch={name:folder.split('/').at(-1)||'/',path:'',children:new Map()};
    for (const file of projectFiles(handle,xml,review)) {
      let branch=root;
      for (const name of file.path.split('/')) {
        const path=branch.path?`${branch.path}/${name}`:name;
        if(!branch.children.has(name))branch.children.set(name,{name,path,children:new Map()});
        branch=branch.children.get(name)!;
      }
      branch.file=file;
    }
    return root;
  },[handle,xml,review.resources,folder]);
  function row(branch:Branch,depth:number):ReactNode {
    const file=branch.file, expanded=!closed.has(branch.path);
    const Icon=file ? file.kind==='document'?FileCode2:file.kind==='review'?FileJson:isProjectImage(file.path)?Image:File : expanded?FolderOpen:Folder;
    return <li key={branch.path}><button className={'project-entry '+(selected===branch.path?'active':'')} style={{paddingLeft:12+depth*14}} title={`${folder}/${branch.path}`} aria-current={selected===branch.path?'page':undefined} aria-expanded={!file?expanded:undefined} onClick={()=>file?onSelect(file):setClosed(previous=>{const next=new Set(previous);if(next.has(branch.path))next.delete(branch.path);else next.add(branch.path);return next;})}>
      {!file?(expanded?<ChevronDown size={12}/>:<ChevronRight size={12}/>):<span className="tree-spacer"/>}<Icon size={15}/><span>{branch.name}</span>{file?.kind==='review'&&<small>评论</small>}{dirty&&file&&file.kind!=='resource'&&<i title="未保存"/>}
    </button>{!file&&expanded&&<ul>{[...branch.children.values()].map(child=>row(child,depth+1))}</ul>}</li>;
  }
  return <aside ref={panel} id="project-files" hidden={!open} onScroll={event=>{if(open)scroll.current={top:event.currentTarget.scrollTop,left:event.currentTarget.scrollLeft};}} className="project-sidebar" aria-label="项目资源"><div className="project-heading"><strong>文件</strong></div><div className="project-root" title={folder}><FolderOpen size={16}/><strong>{tree.name}</strong></div><ul className="project-tree">{[...tree.children.values()].map(branch=>row(branch,0))}</ul></aside>;
}

export type ResourceScrollPosition = {top:number;left:number};
export interface ResourcePreviewAccess {
  assetURL(path:string):string;
  readResource(path:string,signal?:AbortSignal):Promise<{text:string}>;
  refresh?():Promise<void>;
}
export function ResourcePreview({file,handle,review,xml,initialScroll,onScrollChange,access}:{file:ProjectFile;handle:DocumentHandle;review:Review;xml:string;initialScroll?:ResourceScrollPosition;onScrollChange?:(position:ResourceScrollPosition)=>void;access?:ResourcePreviewAccess}) {
  const fileKey=handle.id+':'+file.path;
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<{key?:string;text?:string;error?:string;loading?:boolean}>({});
  const [imageError,setImageError]=useState(false);
  const [imageLoading,setImageLoading]=useState(false);
  const pre=useRef<HTMLPreElement>(null);
  const restored=useRef<string|null>(null);
  const scroll=useRef<ResourceScrollPosition>(initialScroll||{top:0,left:0});
  const currentFile=useRef(fileKey);
  const accessRef=useRef(access);accessRef.current=access;
  useEffect(()=>{
    setImageError(false);
    if(file.kind!=='resource')return;
    if(isProjectImage(file.path)){setImageLoading(true);return;}
    setState(previous=>({key:fileKey,text:previous.key===fileKey?previous.text:undefined,loading:true}));
    const controller=new AbortController();
    const reading=accessRef.current?accessRef.current.readResource(file.path,controller.signal):fetch(`/api/resource?id=${encodeURIComponent(handle.id)}&path=${encodeURIComponent(file.path)}`,{signal:controller.signal,cache:'no-store'}).then(async response=>{
      const body=await response.json();if(!response.ok)throw new Error(typeof body.error==='string'?body.error:'资源暂不可读取');
      if(typeof body.text!=='string')throw new Error('资源响应格式不正确');return body;
    });
    reading.then(body=>{if(!controller.signal.aborted)setState({key:fileKey,text:body.text,loading:false});},error=>{if(!controller.signal.aborted)setState(previous=>({key:fileKey,text:previous.key===fileKey?previous.text:undefined,error:error instanceof Error?error.message:String(error),loading:false}));});
    return()=>controller.abort();
  },[fileKey,file.path,file.kind,handle.id,refresh]);
  const text=file.kind==='review'?JSON.stringify(review,null,2):file.kind==='document'?xml:state.key===fileKey?state.text:undefined;
  const error=state.key===fileKey?state.error:undefined;
  const loading=isProjectImage(file.path)?imageLoading:state.key===fileKey&&state.loading;
  useLayoutEffect(()=>{
    if(currentFile.current!==fileKey){currentFile.current=fileKey;restored.current=null;scroll.current=initialScroll||{top:0,left:0};}
    if(pre.current&&restored.current!==fileKey){pre.current.scrollTop=scroll.current.top;pre.current.scrollLeft=scroll.current.left;restored.current=fileKey;}
  },[fileKey,text,initialScroll]);
  const refreshResource=async()=>{
    if(pre.current)scroll.current={top:pre.current.scrollTop,left:pre.current.scrollLeft};
    const selected=fileKey;
    try{if(accessRef.current?.refresh)await accessRef.current.refresh();if(currentFile.current===selected)setRefresh(value=>value+1);}
    catch(error){if(currentFile.current===selected)setState(previous=>({...previous,key:selected,error:error instanceof Error?error.message:String(error),loading:false}));}
  };
  const imageURL=!isProjectImage(file.path)?undefined:access?access.assetURL(file.path):`/api/asset?id=${encodeURIComponent(handle.id)}&path=${encodeURIComponent(file.path)}${refresh?`&refresh=${refresh}`:''}`;
  return <section className="resource-preview" aria-label="资源预览" aria-busy={loading||undefined}><header><strong>{file.name}</strong>{file.kind==='review'&&<span>评论与处理记录，随正文编辑自动保存</span>}{file.kind==='resource'&&<button type="button" onClick={refreshResource} aria-label="刷新资源" title="重新读取本地资源" style={{alignSelf:'flex-start'}}><RefreshCw size={13}/>{loading?'正在刷新…':'刷新资源'}</button>}</header>{isProjectImage(file.path)&&error&&<p role="status">{error}</p>}{isProjectImage(file.path)?imageError?<p role="status">图片不可读取，原文件引用已保留。</p>:<img alt={file.name} onLoad={()=>setImageLoading(false)} onError={()=>{setImageLoading(false);setImageError(true);}} key={refresh} src={imageURL}/>:<>{error&&<p role="status">{error}{text!==undefined&&' 当前显示为上次读取的内容。'}</p>}{text!==undefined?<pre ref={pre} onScroll={event=>{scroll.current={top:event.currentTarget.scrollTop,left:event.currentTarget.scrollLeft};onScrollChange?.(scroll.current);}}>{text}</pre>:!error&&<p>正在读取…</p>}</>}</section>;
}
