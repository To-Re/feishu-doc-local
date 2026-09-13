import { SaxesParser } from 'saxes';
import type { DocumentHandle, Review } from './types';

export interface ProjectFile { path: string; name: string; kind: 'document' | 'review' | 'resource'; }
export const isProjectImage = (path: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(path);
export function localResourcePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(value) || /[\\\0]/.test(value)) return;
  const parts = value.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) return;
  return parts.join('/');
}

/** Only the opened document, its feedback and explicitly referenced local files. */
export function projectFiles(handle: Pick<DocumentHandle, 'name' | 'path' | 'reviewPath'>, xml: string, review: Review | null): ProjectFile[] {
  const files = new Map<string, ProjectFile>();
  const add = (path: string, kind: ProjectFile['kind']) => { if (!files.has(path)) files.set(path, {path, name:path.split('/').at(-1)!, kind}); };
  add(handle.name, 'document'); add(handle.reviewPath.split('/').at(-1)!, 'review');
  for (const item of review?.resources?.items || []) {
    const path = localResourcePath(item.path); if (path) add(path, 'resource');
  }
  const parser = new SaxesParser({fragment:true});
  parser.on('doctype', () => { throw new Error('不允许 DOCTYPE'); });
  parser.on('opentag', tag => {
    if (!['img','source','whiteboard'].includes(tag.name)) return;
    const value = tag.attributes.path;
    if (typeof value !== 'string' || !value.startsWith('@')) return;
    const path = localResourcePath(value.slice(1)); if (path) add(path, 'resource');
  });
  parser.write(xml).close();
  return [...files.values()];
}
