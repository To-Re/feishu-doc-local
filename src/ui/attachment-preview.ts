import { isSafeResourcePath, type ResourceResolver } from '../core/resources';

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

/** Schema-owned text and local raster images only: attachment contents never become HTML. */
export function renderAttachment(dom: HTMLElement, attachment: NonNullable<ReturnType<typeof attachmentView>>,
  inline: boolean, assetURL?: (path: string) => string, resolveResource?: ResourceResolver) {
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
  if (!preview) return;
  const message = document.createElement('span'); message.className = 'lr-attachment-status';
  dom.append(message);
  const local = attrs.path?.startsWith('@') ? attrs.path.slice(1) : undefined;
  const resource = resolveResource?.('source', attrs);
  const path = isSafeResourcePath(local) ? local : resource?.representation === 'original' ? resource.path : undefined;
  const raster = !attrs.mime || /^image\/(?:png|jpeg|jpg|gif|webp|avif)$/i.test(attrs.mime);
  if (!raster || !assetURL || !isSafeResourcePath(path)) {
    message.textContent = raster ? '预览尚未缓存在本地' : '此附件暂不支持本地预览';
    return;
  }
  const image = document.createElement('img');
  image.className = 'lr-attachment-preview'; image.alt = `附件预览：${name}`; image.loading = 'lazy';
  message.textContent = '本地附件预览';
  image.addEventListener('error', () => { image.remove(); message.textContent = '附件预览缓存不可用，原始引用已保留。'; });
  image.src = assetURL(path); dom.insertBefore(image, message);
}
