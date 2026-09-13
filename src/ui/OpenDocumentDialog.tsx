import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { containDialogFocus } from './Projects';

interface Props {
  path: string;
  busy: boolean;
  error: string;
  onPathChange(path: string): void;
  onOpen(): void;
  onClose(): void;
}

export function OpenDocumentDialog({ path, busy, error, onPathChange, onOpen, onClose }: Props) {
  const id=useId(),dialog=useRef<HTMLFormElement>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    input.current?.focus();
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    if(busy)dialog.current?.focus({preventScroll:true});
    else if(document.activeElement===dialog.current)input.current?.focus({preventScroll:true});
  },[busy]);
  function keyDown(event:KeyboardEvent<HTMLFormElement>) {
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();
      if(!busy)onClose();
    }else if(event.key==='Tab'&&busy){event.preventDefault();dialog.current?.focus({preventScroll:true});}
    else containDialogFocus(event);
  }
  return createPortal(<div className="modal-overlay project-modal">
    <form ref={dialog} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby={id+'-title'}
      aria-describedby={id+'-help'} aria-busy={busy} tabIndex={-1} onKeyDown={keyDown}
      onSubmit={event=>{event.preventDefault();if(!busy&&path.trim())onOpen();}}>
      <fieldset className="sync-protected-controls" disabled={busy}>
        <div className="project-dialog-heading"><h2 id={id+'-title'}>切换本地文档</h2>
          <button type="button" aria-label="关闭切换本地文档" disabled={busy} onClick={onClose}><X size={18}/></button></div>
        <p id={id+'-help'} className="project-help">输入另一份 XML 的完整路径。切换后继续编辑，已有项目会恢复关联。</p>
        <label>本地 XML 路径<input ref={input} aria-label="文档路径" aria-describedby={error?id+'-error':undefined}
          placeholder="/path/to/article.xml" value={path} onChange={event=>onPathChange(event.target.value)} required/></label>
        {error&&<p id={id+'-error'} role="alert" className="project-error">{error}</p>}
        <div className="project-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!path.trim()||busy}>{busy?'正在切换…':'切换'}</button></div>
      </fieldset>
    </form>
  </div>,document.body);
}
