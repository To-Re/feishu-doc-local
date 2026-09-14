import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ContentRestorePreview, ReviewProject } from '../core/projects';
import { containDialogFocus } from './Projects';
import { XMLDiff } from './XMLDiff';

interface Props {
  project: ReviewProject;
  open: boolean;
  busy: boolean;
  disabled: boolean;
  preview: ContentRestorePreview | null;
  stale: boolean;
  error: string;
  onPreview(): void;
  onExecute(): void;
  onClose(): void;
}

export function HistoryRestore({project,open,busy,disabled,preview,stale,error,onPreview,onExecute,onClose}:Props) {
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.focus({preventScroll:true});
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[open]);
  if(!open)return null;
  return <div className="modal-overlay content-sync-modal" onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}}}>
    <section ref={dialog} tabIndex={-1} className="content-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="history-restore-title" onKeyDown={containDialogFocus}>
      <div className="project-dialog-heading"><h2 id="history-restore-title">恢复上一快照</h2><button aria-label="关闭恢复上一快照" disabled={busy} onClick={onClose}><X size={18}/></button></div>
      <div className="content-sync-decision">
        <span>仅恢复本地文档，不修改飞书。</span>
        <div className="project-dialog-actions">{!preview||stale
          ?<button className="primary" disabled={busy||disabled} onClick={onPreview}>{busy?'正在读取快照…':'重新预览'}</button>
          :<button className="primary" disabled={busy||disabled} onClick={onExecute}>{busy?'正在恢复…':'确认恢复'}</button>}</div>
      </div>
      <div className="content-sync-body">
        {error&&<p role="alert" className="project-error">{error}</p>}
        {stale&&<p role="alert" className="project-error">当前文档已改变或恢复预览已过期，请重新预览。</p>}
        {!preview&&busy&&<p role="status">正在读取上一份快照，尚未修改文档。</p>}
        <p>恢复前会先存档当前正文和评论。随后恢复快照内容，引用的资源需仍在本地且未改变；之后新增的评论保留在恢复前存档中。</p>
        <dl className="content-sync-targets"><div><dt>本地文档</dt><dd><code>{project.localPath}</code></dd></div>
          {preview&&<><div><dt>快照时间</dt><dd>{new Date(preview.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>快照位置</dt><dd><code>{preview.snapshotPath}</code></dd></div></>}
        </dl>
        {preview&&<>
          {preview.warnings.length>0&&<div className="content-sync-warnings" role="status"><ul>{preview.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
          <XMLDiff key={preview.id} before={preview.localXML} after={preview.snapshotXML} beforeLabel="恢复前 · 当前本地正文" afterLabel="恢复后 · 上一快照正文"/>
        </>}
      </div>
    </section>
  </div>;
}
