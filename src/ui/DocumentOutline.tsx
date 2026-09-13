import { useEffect, useId, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import './document-outline.css';

interface OutlineHeading { position:number; level:number; text:string; }
interface Props { editor:Editor|null; collapsed:boolean; onToggle:()=>void; revision?:string; showToggle?:boolean; onNavigate?:(position:number)=>boolean|void; }

export function documentHeadings(editor:Editor|null):OutlineHeading[] {
  if(!editor||editor.isDestroyed)return [];
  const headings:OutlineHeading[]=[];
  editor.state.doc.descendants((node,position)=>{
    if(node.type.name!=='heading')return;
    const level=Number(node.attrs.level);
    if(!Number.isInteger(level)||level<1||level>9)return;
    headings.push({position,level,text:node.textContent.trim()||'未命名标题'});
  });
  return headings;
}

export function scrollToHeading(editor:Editor|null,position:number):boolean {
  if(!editor||editor.isDestroyed||editor.state.doc.nodeAt(position)?.type.name!=='heading')return false;
  const dom=editor.view.nodeDOM(position);
  // nodeType is safe when the editor belongs to an Obsidian pop-out window.
  if(dom?.nodeType!==1)return false;
  const element=dom as HTMLElement;
  if(typeof element.scrollIntoView!=='function')return false;
  const reducedMotion=element.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({behavior:reducedMotion?'auto':'smooth',block:'center',inline:'nearest'});
  return true;
}

/** Navigation reads editor positions but never changes its selection or document. */
export function DocumentOutline({editor,collapsed,onToggle,revision,showToggle=true,onNavigate}:Props) {
  const [headings,setHeadings]=useState(()=>documentHeadings(editor));
  const [active,setActive]=useState<number|null>(null);
  const listId=useId();
  useEffect(()=>{
    let live=true;
    const update=()=>{if(live){setHeadings(documentHeadings(editor));setActive(null);}};
    const clear=()=>{setHeadings([]);setActive(null);};
    update();
    // Reader may replace EditorState in a later sibling effect after an external
    // file read. Read again after this commit without rebuilding editor history.
    queueMicrotask(update);
    if(!editor||editor.isDestroyed)return()=>{live=false;};
    editor.on('update',update);editor.on('destroy',clear);
    return()=>{live=false;editor.off('update',update);editor.off('destroy',clear);};
  },[editor,revision]);
  function navigate(heading:OutlineHeading) {
    const navigated=onNavigate?onNavigate(heading.position):scrollToHeading(editor,heading.position);
    if(navigated!==false)setActive(heading.position);
  }
  return <nav className={'document-outline'+(collapsed?' is-collapsed':'')} aria-label="文档目录">
    <div className="document-outline-heading">
      {showToggle&&<button type="button" className="document-outline-toggle" aria-label={collapsed?'展开文档目录':'收起文档目录'}
        title={collapsed?'展开文档目录':'收起文档目录'} aria-expanded={!collapsed} aria-controls={listId}
        onMouseDown={event=>event.preventDefault()} onClick={onToggle}>
        {collapsed?<PanelLeftOpen size={18} aria-hidden="true"/>:<PanelLeftClose size={18} aria-hidden="true"/>}
      </button>}
      {!collapsed&&<strong>文档目录</strong>}
    </div>
    <div id={listId} hidden={collapsed} className="document-outline-body">
      {headings.length?<ol>{headings.map(heading=><li key={heading.position} data-level={heading.level}>
        <button type="button" className={'document-outline-entry'+(active===heading.position?' is-active':'')}
          title={heading.text} aria-current={active===heading.position?'location':undefined}
          aria-label={`${heading.level} 级标题：${heading.text}`} data-heading-level={heading.level}
          onMouseDown={event=>event.preventDefault()} onClick={()=>navigate(heading)}>
          <span>{heading.text}</span>
        </button>
      </li>)}</ol>:<p className="document-outline-empty">{editor?'添加标题后，目录会显示在这里。':'打开正文后显示目录。'}</p>}
    </div>
  </nav>;
}
