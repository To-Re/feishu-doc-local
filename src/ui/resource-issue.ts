import type { ResourceFailureResolver } from '../core/resources';

export function resourceLabel(kind: string, attrs: Record<string, unknown>): string {
  const name = typeof attrs.name === 'string' && attrs.name !== attrs.token && attrs.name !== attrs.src
    ? attrs.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : '';
  return name ? `${kind}：${name}` : kind;
}

export function missingResourceReason(reason: ReturnType<ResourceFailureResolver>): string {
  if (reason === 'http-403') return '未下载；已有下载记录返回 403，下载被拒绝，具体权限条件未确认。';
  if (reason === 'not-downloaded') return '未下载到本地，原始引用已保留。';
  return '无可用本地映射，无法确认是否已下载。原始引用已保留。';
}

/** Render state only: never serializes into source XML or exposes request errors. */
export function markResourceIssue(dom: HTMLElement, label: string, reason: string): void {
  dom.dataset.resourceIssue = `${label} · ${reason}`;
  dom.classList.add('lr-resource-unavailable');
}

export function clearResourceIssue(dom: HTMLElement): void {
  delete dom.dataset.resourceIssue;
  dom.classList.remove('lr-resource-unavailable');
}
