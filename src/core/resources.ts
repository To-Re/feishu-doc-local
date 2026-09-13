import type { ResourceMapping } from './types';
import { localResourcePath } from './project-files';

export const RESOURCE_REFRESH = 'larkResourceRefresh';
export type ResourceResolver = (tag: string, attrs: Record<string, unknown>) => ResourceMapping | undefined;
export type ResourceTextLoader = (path: string, signal: AbortSignal) => Promise<string>;

export function isWhiteboardSVGPath(value: unknown): value is string {
  return typeof value === 'string' && !!localResourcePath(value) && /\.svg$/i.test(value);
}

export function isSafeResourcePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(value) &&
    !/[\\\0]/.test(value) && !value.split('/').includes('..') && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(value);
}

export function isResourceMapping(value: unknown): value is ResourceMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.value !== 'string' || !entry.value || entry.value.length > 512) return false;
  if (entry.tag === 'source') return entry.attribute === 'token' && entry.representation === 'original' && !!localResourcePath(entry.path);
  if (entry.tag === 'whiteboard') return ['src','token','path'].includes(String(entry.attribute)) && entry.representation === 'preview' &&
    (isSafeResourcePath(entry.path) || isWhiteboardSVGPath(entry.path));
  if (!isSafeResourcePath(entry.path)) return false;
  return (entry.attribute === 'src' || entry.attribute === 'token') &&
    entry.tag === 'img' && entry.representation === 'original';
}

/** Display-only resolution. No positional, caption or token-alias guessing. */
export function resolveResource(manifest: unknown, tag: string, attrs: Record<string, unknown>): ResourceMapping | undefined {
  if (tag !== 'img' && tag !== 'whiteboard' && tag !== 'source') return;
  if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1 ||
    !('items' in manifest) || !Array.isArray(manifest.items)) return;
  const matches = manifest.items.filter(entry => entry && typeof entry === 'object' && entry.tag === tag &&
    (entry.attribute === 'src' || entry.attribute === 'token' || tag === 'whiteboard' && entry.attribute === 'path') && typeof entry.value === 'string' &&
    !!entry.value && attrs[entry.attribute] === entry.value);
  // Multiple matching selectors are ambiguous, even if their labels are identical.
  if (matches.length !== 1) return;
  const entry = matches[0];
  if (isResourceMapping(entry)) return entry;
}
