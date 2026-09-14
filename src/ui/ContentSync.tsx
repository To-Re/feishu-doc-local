import { ArrowDownToLine, ArrowUpFromLine, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ContentPreview, ReviewProject, SyncDirection } from '../core/projects';
import { containDialogFocus } from './Projects';
import { XMLDiff } from './XMLDiff';
import { SegmentedControl, syncDirectionOptions } from './SegmentedControl';
import { contentSyncPresentation } from './content-sync-presentation';

interface Props {
  project: ReviewProject;
  direction: SyncDirection;
  busy: boolean;
  disabled: boolean;
  preview: ContentPreview | null;
  stale: boolean;
  error: string;
  message: string;
  onDirection(direction: SyncDirection): void;
  onPreview(): void;
  onExecute(): void;
  onClose(): void;
}
export function ContentSyncControls({ busy, disabled, onPreview, onSync }: Pick<Props,'busy'|'disabled'|'onPreview'> & {onSync(direction:SyncDirection):void}) {
  return <div className="content-sync-control" aria-label="正文同步">
    <button className="content-sync-secondary" disabled={busy || disabled} title="将飞书正文拉取到本地，旧稿自动存档" onClick={()=>onSync('pull')}><ArrowDownToLine size={15}/>拉取</button>
    <button className="content-sync-main" disabled={busy || disabled} title="推送本地正文到飞书，完成后更新本地并存档旧稿" onClick={()=>onSync('push')}><ArrowUpFromLine size={15}/>推送</button>
    <button className="content-sync-preview" disabled={busy || disabled} onClick={onPreview}>预览差异</button>
    {busy&&<span role="status">正在同步…</span>}
  </div>;
}
export function ContentSync({ project, direction, busy, disabled, preview, stale, error, message, onDirection, onPreview, onExecute, onClose }: Props) {
  const dialog=useRef<HTMLElement>(null);
  const presentation=preview?contentSyncPresentation(preview):null;
  useEffect(()=>{
    if(!preview)return;
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.focus({preventScroll:true});
    return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[preview?.id]);
  return <>
    {!preview && error && <p className="content-sync-status project-error" role="alert">{error}</p>}
    {!preview && message && <p className="content-sync-status" role="status">{message}</p>}
    {preview && presentation && <div className="modal-overlay content-sync-modal" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
      <section ref={dialog} tabIndex={-1} className="content-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="content-sync-title" onKeyDown={containDialogFocus}>
        <div className="project-dialog-heading"><h2 id="content-sync-title">正文同步预览</h2><button aria-label="关闭正文同步预览" disabled={busy} onClick={onClose}><X size={18}/></button></div>
        <div className="content-sync-decision">
          <SegmentedControl label="预览方向" value={preview.direction} disabled={busy || disabled} options={syncDirectionOptions} onChange={onDirection}/>
          <div className="project-dialog-actions"><button disabled={busy} onClick={onClose}>关闭</button>
            {stale ? <button className="primary" disabled={busy || disabled} onClick={onPreview}>重新预览</button> : preview.status !== 'equal' &&
              <button className="primary" disabled={busy || disabled} onClick={onExecute}>{busy ? '正在同步…' : presentation.confirm}</button>}
          </div>
        </div>
        <div className="content-sync-body">
        <h3>{presentation.operation}</h3>
        <p>{preview.summary}</p>
        <p className="content-sync-destination">项目：{project.name}</p>
        <dl className="content-sync-targets"><div><dt>本地正文</dt><dd><code aria-label="正文同步本地路径">{project.localPath}</code></dd></div>
          <div><dt>飞书文档</dt><dd><a aria-label="正文同步飞书链接" href={project.cloud?.url} target="_blank" rel="noopener noreferrer">{project.cloud?.url}</a></dd></div></dl>
        {preview.status!=='equal'&&<p className="project-help">{presentation.description}评论单独同步。</p>}
        {(preview.status === 'conflict' || preview.warnings.length > 0) && <div className="content-sync-warnings" role="status">
          {preview.status === 'conflict' && <strong>两端都有变化，请核对将被覆盖的一端。</strong>}
          {preview.warnings.length > 0 && <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        </div>}
        <XMLDiff key={preview.id}
          before={presentation.updatesLocal?preview.localXML:preview.cloudXML}
          after={presentation.updatesLocal?preview.cloudXML:preview.localXML}
          beforeLabel={presentation.beforeLabel}
          afterLabel={presentation.afterLabel}/>
        <details className="content-raw"><summary>查看完整原文</summary><div className="content-compare"><details open><summary>本地正文</summary><pre aria-label="本地正文源码">{preview.localXML}</pre></details>
          <details open><summary>飞书正文</summary><pre aria-label="飞书正文源码">{preview.cloudXML}</pre></details></div></details>
        {stale && <p role="alert" className="project-error">当前文档已改变或预览已过期，请重新预览后再同步。</p>}
        {error && <p role="alert" className="project-error">{error}</p>}
        </div>

      </section>
    </div>}
  </>;
}
