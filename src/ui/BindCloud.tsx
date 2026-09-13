import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { BindProjectInput, ReviewProject, SyncDirection } from '../core/projects';
import { containDialogFocus } from './Projects';
import { SegmentedControl, syncDirectionOptions } from './SegmentedControl';
import './bind-cloud.css';

interface Props {
  project: ReviewProject;
  cloudAvailable: boolean;
  busy: boolean;
  error: string;
  onClose(): void;
  onBind(input: Omit<BindProjectInput, 'revision'>): Promise<boolean>;
}

function validDocumentURL(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname) &&
      /^\/(docx|wiki)\/[A-Za-z0-9_-]{1,512}\/?$/.test(url.pathname);
  } catch { return false; }
}

export function BindCloud({ project, cloudAvailable, busy, error, onClose, onBind }: Props) {
  const id = useId();
  const [kind, setKind] = useState<'existing' | 'new'>('existing');
  const [url, setURL] = useState('');
  const [title, setTitle] = useState(project.name);
  const [parentToken, setParentToken] = useState('');
  const [direction, setDirection] = useState<SyncDirection>('push');
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const dialog = useRef<HTMLFormElement>(null);
  const locked = busy || submitting;
  const address = url.trim(), name = title.trim(), folder = parentToken.trim();
  const validation = kind === 'existing'
    ? !address ? '粘贴要关联的飞书 Docx 或 Wiki 文档链接。'
      : !validDocumentURL(address) ? '请输入 https:// 开头的飞书或 Lark Docx / Wiki 文档链接。' : ''
    : !name ? '请输入飞书文档标题。'
      : name.length > 200 || /[\u0000-\u001f\u007f]/.test(title) ? '标题需在 200 个字符以内，且不能包含控制字符。'
        : folder && !/^[-\w]{1,512}$/.test(folder) ? '文件夹 Token 只能包含字母、数字、下划线和短横线，最多 512 个字符。' : '';
  const valid = cloudAvailable && !validation;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input[aria-label="飞书文档链接"]')?.focus();
    return () => {
      mounted.current = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    // Disabled controls can drop native focus outside the dialog. Keep the
    // pending form as the keyboard target until the request is settled.
    if (locked) dialog.current?.focus({ preventScroll: true });
  }, [locked]);

  function keyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      if (!locked) onClose();
    } else if (event.key === 'Tab' && locked) {
      event.preventDefault();
      dialog.current?.focus({ preventScroll: true });
    } else containDialogFocus(event);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || locked || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setRequestError('');
    try {
      const succeeded = await onBind({
        cloud: kind === 'existing' ? { kind, url: address } : { kind, title: name, ...(folder ? { parentToken: folder } : {}) },
        defaultDirection: direction,
      });
      if (succeeded && mounted.current) onClose();
    } catch {
      if (mounted.current) setRequestError('关联未完成，请核对错误信息后再操作。');
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return createPortal(<div className="modal-overlay project-modal bind-cloud-modal">
    <form ref={dialog} className="project-dialog bind-cloud-dialog" role="dialog" aria-modal="true" aria-labelledby={id + '-title'}
      aria-busy={locked} tabIndex={-1} onKeyDown={keyDown} onSubmit={submit}>
      <fieldset className="sync-protected-controls" disabled={locked}>
        <div className="project-dialog-heading"><h2 id={id + '-title'}>关联飞书</h2>
          <button type="button" aria-label="关闭关联飞书" disabled={locked} onClick={onClose}><X size={18}/></button></div>
        <div className="bind-cloud-context"><span>当前项目</span><strong>{project.name}</strong>
          <label>本地文章<input aria-label="关联项目本地文件" readOnly value={project.localPath} onFocus={event => event.currentTarget.select()}/></label></div>
        <div className="project-choice-field"><span>飞书文档</span><SegmentedControl label="飞书关联方式" value={kind} disabled={locked}
          onChange={value=>{setKind(value);setRequestError('');}} options={[{value:'existing',label:'关联已有飞书文档'},{value:'new',label:'新建飞书文档'}]}/></div>
        {kind === 'existing' ? <label>飞书链接<input type="url" aria-label="飞书文档链接" aria-describedby={id + '-validation'}
          aria-invalid={!!address && !!validation} value={url} onChange={event => setURL(event.target.value)} placeholder="https://…/docx/…" required/></label>
          : <><label>飞书文档标题<input aria-label="飞书文档标题" aria-describedby={id + '-validation'} value={title} onChange={event => setTitle(event.target.value)} required/></label>
            <details><summary tabIndex={locked ? -1 : 0} aria-disabled={locked} onClick={event => { if (locked) event.preventDefault(); }}>指定飞书文件夹（可选）</summary>
              <label>文件夹 Token<input aria-label="飞书文件夹 Token" value={parentToken} onChange={event => setParentToken(event.target.value)} aria-describedby={id + '-validation'}/></label></details></>}
        <p className="project-help">{kind === 'existing'
          ? '只建立关联，不改动两端正文。后续同步前先预览差异。'
          : '将当前本地文章发布为一篇新的飞书文档，并与此项目关联。'}</p>
        <div className="project-choice-field"><span>默认同步方向</span><SegmentedControl label="默认同步方向" value={direction} disabled={locked} options={syncDirectionOptions} onChange={setDirection}/></div>
        {!cloudAvailable && <p className="project-help" role="status">当前服务未配置飞书连接。请先在本机启动配置中指定飞书 CLI。</p>}
        <p id={id + '-validation'} className="project-help bind-cloud-validation" aria-live="polite">{validation}</p>
        {(error || requestError) && <p role="alert" className="project-error">{error || requestError}</p>}
        <div className="project-dialog-actions"><button type="button" disabled={locked} onClick={onClose}>取消</button>
          <button type="submit" className="primary" disabled={!valid || locked}>{locked ? '正在处理…' : kind === 'existing' ? '关联文档' : '新建并发布当前文章'}</button></div>
      </fieldset>
    </form>
  </div>, document.body);
}
