import { isSafeResourcePath, type ResourceResolver, type ResourceTextLoader, type ResourceFailureResolver } from '../core/resources';
import { localResourcePath } from '../core/project-files';
import { isTextAttachment, localMediaType } from '../core/local-media';
import { markResourceIssue, missingResourceReason, resourceLabel } from './resource-issue';

/** Inspect only the supported attachment shape; keep its protected editor atom intact. */
export function attachmentView(rawXML: unknown, tag: unknown, inline: boolean) {
  if ((tag !== 'source' && tag !== 'figure') || typeof rawXML !== 'string') return;
  const root = new DOMParser().parseFromString(rawXML, 'application/xml').documentElement;
  if (root.tagName !== tag) return;
  let source: Element = root;
  let preview = !inline;
  if (tag === 'figure') {
    if (root.children.length !== 1 || root.firstElementChild?.tagName !== 'source' ||
        [...root.childNodes].some(node => node.nodeType === 3 && !!node.textContent?.trim())) return;
    const mode = root.getAttribute('view-type');
    if (mode !== 'Card' && mode !== 'Preview') return;
    preview = mode === 'Preview' && !inline;
    source = root.firstElementChild;
  }
  if (source.childNodes.length) return;
  return { attrs: Object.fromEntries([...source.attributes].map(attr => [attr.name, attr.value])), preview };
}

function fileSize(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return '';
  const size = Number(value);
  if (!Number.isSafeInteger(size)) return '';
  if (size < 1024) return `${size} B`;
  for (const [unit, divisor] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]] as const) {
    if (size >= divisor) return `${Number((size / divisor).toFixed(1))} ${unit}`;
  }
  return '';
}

/** Local previews never execute attachment HTML, scripts or remote URLs. */
export function renderAttachment(dom: HTMLElement, attachment: NonNullable<ReturnType<typeof attachmentView>>,
  inline: boolean, assetURL?: (path: string) => string, resolveResource?: ResourceResolver, loadResource?: ResourceTextLoader, resolveFailure?: ResourceFailureResolver) {
  const { attrs, preview } = attachment;
  const name = attrs.name || '未命名附件';
  const extension = name.match(/\.([a-z\d]{1,8})$/i)?.[1]?.toUpperCase() || 'FILE';
  dom.classList.add('lr-attachment', inline ? 'lr-attachment-inline' : 'lr-attachment-block');
  dom.dataset.attachmentView = inline ? 'inline' : preview ? 'preview' : 'card';
  dom.setAttribute('aria-label', `附件：${name}`);
  const header = document.createElement('span'); header.className = 'lr-attachment-header';
  const icon = document.createElement('span'); icon.className = 'lr-attachment-icon'; icon.textContent = extension; icon.setAttribute('aria-hidden', 'true');
  const details = document.createElement('span'); details.className = 'lr-attachment-details';
  const title = document.createElement('span'); title.className = 'lr-attachment-name'; title.textContent = name;
  details.append(title);
  if (!inline) {
    const size = fileSize(attrs.size);
    const meta = document.createElement('span'); meta.className = 'lr-attachment-meta';
    meta.textContent = [extension === 'FILE' ? '附件' : `${extension} 文件`, size].filter(Boolean).join(' · ');
    details.append(meta);
  }
  header.append(icon, details); dom.replaceChildren(header);
  const controller=new AbortController();
  let media:HTMLMediaElement|undefined,downloadURL:string|undefined;
  const dispose=()=>{controller.abort();if(downloadURL)URL.revokeObjectURL(downloadURL);if(media){media.pause();media.removeAttribute('src');media.load();media.remove();}};
  const message = document.createElement('span'); message.className = 'lr-attachment-status';
  if (!inline) dom.append(message);
  const kind = attrs.mime?.startsWith('video/') || /\.(mp4|m4v|webm)$/i.test(name) ? '视频' : attrs.mime?.startsWith('audio/') ? '音频' : '附件';
  const unavailable = (reason: string) => {
    message.textContent = reason;
    if (inline) dom.append(message);
    markResourceIssue(dom, resourceLabel(kind, attrs), reason);
  };
  const local = attrs.path?.startsWith('@') ? attrs.path.slice(1) : undefined;
  const resource = resolveResource?.('source', attrs);
  const path = localResourcePath(local) ? local : resource?.representation === 'original' ? resource.path : undefined;
  if(!path){unavailable(`${kind}未下载到本地或未关联。${missingResourceReason(resolveFailure?.('source',attrs))}`);return dispose;}
  if (inline) return dispose;
  const raster = !attrs.mime || /^image\/(?:png|jpeg|jpg|gif|webp|avif)$/i.test(attrs.mime);
  const mediaType=localMediaType(path);
  const playable=mediaType&&(!attrs.mime||attrs.mime==='application/octet-stream'||attrs.mime===mediaType);
  const text=isTextAttachment(path);
  if(!text&&!playable&&!(raster&&isSafeResourcePath(path))){message.textContent='此附件暂不支持本地预览，原始文件引用已保留。';return dispose;}
  const content=document.createElement('div');content.className='lr-attachment-content';dom.insertBefore(content,message);
  let started=false;
  const show=()=>{
    if(started||controller.signal.aborted)return;started=true;
    if(text){
      if(!loadResource){message.textContent='当前阅读器尚未连接本地文本资源。';return;}
      message.textContent='正在读取本地附件…';
      void loadResource(path,controller.signal).then(value=>{
        if(controller.signal.aborted)return;
        const pre=document.createElement('pre');pre.className='lr-attachment-text';pre.textContent=value;pre.tabIndex=0;
        content.append(pre);message.textContent='本地文本预览';
        if(typeof URL.createObjectURL==='function') {
          downloadURL=URL.createObjectURL(new Blob([value],{type:'text/plain;charset=utf-8'}));
          const download=document.createElement('a');download.href=downloadURL;download.download=name;download.textContent='保存副本';download.className='lr-attachment-download';message.append(' · ',download);
        }
      },()=>{if(!controller.signal.aborted)unavailable('附件文件缺失或不可读取，原始引用已保留。');});
      return;
    }
    if(playable){
      if(!assetURL){message.textContent='当前阅读器尚未连接本地影音资源。';return;}
      const url=assetURL(path);
      if(!url||url==='data:,'){unavailable('影音文件缺失、超过 25 MB 或格式不受支持，请补齐本地素材。');return;}
      media=document.createElement(mediaType.startsWith('video/')?'video':'audio');
      media.className='lr-attachment-media';media.controls=true;media.preload='metadata';media.setAttribute('aria-label',name);
      if(media instanceof HTMLVideoElement)media.playsInline=true;
      media.addEventListener('error',()=>{if(!controller.signal.aborted)unavailable('影音文件不可读取或当前浏览器不支持其编码，原始引用已保留。');});
      media.src=url;content.append(media);message.textContent='本地影音预览，点击播放';return;
    }
    if(!assetURL){message.textContent='预览尚未缓存在本地';return;}
    const url=assetURL(path);
    if(!url||url==='data:,'){unavailable('附件预览缓存不可用，文件缺失、不可读取或格式不受支持，原始引用已保留。');return;}
    const image = document.createElement('img');
    image.className = 'lr-attachment-preview'; image.alt = `附件预览：${name}`; image.loading = 'lazy';
    message.textContent = '本地附件预览';
    image.addEventListener('error', () => { if (!controller.signal.aborted) { image.remove(); unavailable('附件预览缓存不可用，文件缺失、不可读取或已损坏，原始引用已保留。'); } });
    image.src = url; content.append(image);
  };
  if(preview)show();
  else {
    message.textContent='本地附件';
    const button=document.createElement('button');button.type='button';button.className='lr-attachment-open';button.textContent='展开预览';
    button.addEventListener('click',event=>{event.preventDefault();show();content.hidden=!content.hidden;button.textContent=content.hidden?'展开预览':'收起预览';});
    content.hidden=true;header.append(button);
  }
  return dispose;
}
