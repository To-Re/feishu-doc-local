import { constants } from 'node:fs';
import { open, realpath, rename, unlink, link, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import type { Review, Snapshot } from '../core/types';
import { parseDocxXML } from '../core/docxml';
import { isResourceMapping } from '../core/resources';
import { localResourcePath, projectFiles } from '../core/project-files';
import { isAnchorTarget } from '../core/anchors';
import { isCloudSyncState } from '../core/cloud-state';
import { isContentSyncState } from '../core/content-state';

export class FileError extends Error {
  constructor(message: string, readonly code = 'CONFLICT', readonly status = 409) { super(message); }
}
const XML_LIMIT = 5_000_000;
const REVIEW_LIMIT = 25_000_000;
const raster = /\.(png|jpe?g|gif|webp|avif)$/i;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const revisionOf = (xml: string, raw: string | null) => digest(JSON.stringify([xml, raw]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const date = (value: unknown) => string(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

interface PendingWrite { id: string; beforeXML: string; beforeHash: string; afterHash: string; startedAt: string; }
type StoredReview = Review & { pendingWrite?: PendingWrite };
export interface FileHooks { afterPrepare?(): Promise<void>; afterSource?(): Promise<void>; readOnly?: boolean; }

export function validateReview(value: unknown, name: string): StoredReview {
  if (!object(value) || value.format !== 'lark-review' || value.version !== 1)
    throw new FileError('评论文件不是受支持的 Lark Review 格式，原文件未被覆盖。', 'REVIEW_FORMAT');
  const d = value.document;
  if (!object(d) || d.name !== name || !string(d.baselineXML) || !string(d.xml) || !date(d.updatedAt))
    throw new FileError('评论文件的文档信息不正确，原文件未被覆盖。', 'REVIEW_FORMAT');
  if (!Array.isArray(value.comments) || !Array.isArray(value.operations))
    throw new FileError('评论或操作记录的格式不正确。', 'REVIEW_FORMAT');
  const ids = new Set<string>();
  for (const c of value.comments) {
    if (!object(c) || !string(c.id) || !c.id || ids.has(c.id) || !string(c.author) || !string(c.body) || !date(c.createdAt) || (c.status !== 'open' && c.status !== 'resolved') || !object(c.anchor) || !Array.isArray(c.replies))
      throw new FileError('评论格式不正确，原文件未被覆盖。', 'REVIEW_FORMAT');
    ids.add(c.id);
    const a = c.anchor;
    if (!integer(a.from) || !integer(a.to) || a.to < a.from || !string(a.quote) || (a.state !== 'attached' && a.state !== 'deleted' && a.state !== 'unverified'))
      throw new FileError('评论位置格式不正确。', 'REVIEW_FORMAT');
    if (a.target !== undefined && (!isAnchorTarget(a.target) || (a.state === 'attached' && a.to !== a.from + 1)))
      throw new FileError('白板节点评论的位置或身份格式不正确。', 'REVIEW_FORMAT');
    const replies = new Set<string>();
    for (const r of c.replies) {
      if (!object(r) || !string(r.id) || !r.id || replies.has(r.id) || !string(r.author) || !string(r.body) || !date(r.createdAt))
        throw new FileError('回复格式不正确。', 'REVIEW_FORMAT');
      replies.add(r.id);
    }
  }
  for (const op of value.operations) {
    if (!object(op) || !string(op.id) || !string(op.type) || !string(op.author) || !date(op.at) || !string(op.summary))
      throw new FileError('操作记录格式不正确。', 'REVIEW_FORMAT');
  }
  if (value.result !== undefined && (!object(value.result) || !string(value.result.author) || !string(value.result.summary) || !date(value.result.appliedAt)))
    throw new FileError('AI 回执格式不正确。', 'REVIEW_FORMAT');
  if (value.cloudSync !== undefined && !isCloudSyncState(value.cloudSync))
    throw new FileError('飞书评论同步记录格式不正确，原文件未被覆盖。','REVIEW_FORMAT');
  if(value.contentSync!==undefined&&!isContentSyncState(value.contentSync))
    throw new FileError('正文同步记录格式不正确，原文件未被覆盖。','REVIEW_FORMAT');
  if (value.resources !== undefined) {
    const resources = value.resources;
    if (!object(resources) || resources.version !== 1 || !Array.isArray(resources.items) || resources.items.length > 10000)
      throw new FileError('本地资源映射格式不正确。', 'REVIEW_FORMAT');
    const keys = new Set<string>();
    for (const item of resources.items) {
      if (!isResourceMapping(item))
        throw new FileError('本地资源必须精确对应原稿，并使用文章目录内的安全相对路径。', 'REVIEW_FORMAT');
      const key = JSON.stringify([item.tag, item.attribute, item.value]);
      if (keys.has(key)) throw new FileError('同一资源不能对应多个本地文件。', 'REVIEW_FORMAT');
      keys.add(key);
    }
  }
  const p = value.pendingWrite;
  if (p !== undefined && (!object(p) || !string(p.id) || !p.id || !string(p.beforeXML) || !date(p.startedAt) || p.beforeHash !== digest(p.beforeXML) || p.afterHash !== digest(d.xml)))
    throw new FileError('未完成保存的校验信息不正确，请保留两份文件。', 'RECOVERY_INVALID');
  return value as unknown as StoredReview;
}
function parseReview(raw: string, name: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new FileError('评论文件不是合法 JSON，原文件未被覆盖。', 'REVIEW_FORMAT'); }
  return validateReview(value, name);
}
function validateXML(xml: string) {
  if (Buffer.byteLength(xml) > XML_LIMIT) throw new FileError('XML 文件需小于 5 MB。', 'TOO_LARGE', 413);
  try { parseDocxXML(xml); } catch (error) { throw new FileError(`XML 格式不正确：${(error as Error).message}`, 'INVALID_XML', 400); }
}

export async function openLocalFile(input: string, hooks: FileHooks = {}) {
  if (!isAbsolute(input) || !/\.xml$/i.test(input)) throw new FileError('请选择 XML 文件，或填写它的完整路径。', 'INVALID_PATH', 400);
  let path: string;
  try { path = await realpath(input); } catch { throw new FileError('XML 文件不存在或不可读取。', 'NOT_FOUND', 404); }
  if (!/\.xml$/i.test(path)) throw new FileError('XML 文件的真实路径类型不正确。', 'INVALID_PATH', 400);
  const folder = dirname(path);
  const name = basename(path);
  const reviewPath = path.replace(/\.xml$/i, '') + '.review.json';
  const allowed = new Set([path, reviewPath]);
  async function readText(target: string): Promise<string | null> {
    if (!allowed.has(target)) throw new FileError('文件未授权。', 'FORBIDDEN', 403);
    if (await realpath(folder) !== folder) throw new FileError('文章目录已变化，请重新打开。', 'PATH_CHANGED');
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (hooks.readOnly ? constants.O_NONBLOCK : 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new FileError('正文及评论必须为普通文件，不支持链接。', 'UNSAFE_FILE');
      if (info.size > (target === path ? XML_LIMIT : REVIEW_LIMIT)) throw new FileError('文件过大。', 'TOO_LARGE', 413);
      const bytes = await handle.readFile();
      try { return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
      catch { throw new FileError('文件必须使用 UTF-8 编码。', 'INVALID_ENCODING', 400); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new FileError('正文及评论不能是软链接。', 'UNSAFE_FILE');
      throw error;
    } finally { await handle?.close(); }
  }
  async function pair() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const xml = await readText(path);
      const raw = await readText(reviewPath);
      if (xml === null) throw new FileError('XML 文件已被移动或删除。', 'NOT_FOUND', 404);
      if (xml === await readText(path) && raw === await readText(reviewPath)) return {xml, raw};
    }
    throw new FileError('文件正在被另一处修改，请稍后重试。', 'CONFLICT');
  }
  async function replace(target: string, text: string, expected: string | null) {
    if (await readText(target) !== expected) throw new FileError('文件已在另一处修改，未覆盖。', 'CONFLICT');
    const mode = expected === null ? 0o600 : (await lstat(target)).mode & 0o777;
    const temporary = target + '.tmp-' + randomUUID();
    try {
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (await readText(target) !== expected) throw new FileError('文件已在另一处修改，未覆盖。', 'CONFLICT');
      if (expected === null) await link(temporary, target);
      else await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    const directory = await open(folder, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  function snapshot(xml: string, raw: string | null, review: Review | null, recovery = false): Snapshot {
    return {xml, review, revision:revisionOf(xml, raw), ...(recovery ? {recovery:true} : {})};
  }
  async function finish(review: StoredReview, prepared: string): Promise<Snapshot> {
    const pending = review.pendingWrite!;
    const disk = await pair();
    if (disk.raw !== prepared) throw new FileError('评论文件已变化，未继续未完成的保存。', 'CONFLICT');
    validateXML(review.document.xml);
    if (disk.xml === pending.beforeXML) await replace(path, review.document.xml, pending.beforeXML);
    else if (disk.xml !== review.document.xml) throw new FileError('正文与未完成保存的前后版本均不一致，请保留双方内容。', 'RECOVERY_CONFLICT');
    await hooks.afterSource?.();
    if (await readText(path) !== review.document.xml) throw new FileError('正文在保存中被修改，未提交反馈。', 'CONFLICT');
    const {pendingWrite:_pending, ...committed} = review;
    const raw = JSON.stringify(committed, null, 2) + '\n';
    await replace(reviewPath, raw, prepared);
    const verified = await pair();
    if (verified.xml !== review.document.xml || verified.raw !== raw) throw new FileError('文件在保存后又发生变化，请重新读取。', 'CONFLICT');
    return snapshot(verified.xml, raw, committed);
  }
  async function read(): Promise<Snapshot> {
    const disk = await pair();
    validateXML(disk.xml);
    const review = disk.raw === null ? null : parseReview(disk.raw, name);
    if (review?.pendingWrite) {
      if (hooks.readOnly) throw new FileError('存在未完成保存，请先在文章中恢复后再注册项目。', 'RECOVERY_REQUIRED');
      return {...await finish(review, disk.raw!), recovery:true};
    }
    return snapshot(disk.xml, disk.raw, review);
  }
  async function save(xml: string, supplied: Review, revision: string): Promise<Snapshot> {
    if (!string(xml) || !string(revision)) throw new FileError('保存参数不正确。', 'INVALID_REQUEST', 400);
    validateXML(xml);
    const review = validateReview(supplied, name);
    if (review.pendingWrite !== undefined) throw new FileError('客户端不能提交未完成保存标记。', 'INVALID_REQUEST', 400);
    if (review.document.xml !== xml) throw new FileError('正文与评论中的 XML 快照不一致。', 'INVALID_REQUEST', 400);
    if (Buffer.byteLength(JSON.stringify(review)) > REVIEW_LIMIT - XML_LIMIT) throw new FileError('评论记录过大。', 'TOO_LARGE', 413);
    const disk = await pair();
    if (revisionOf(disk.xml, disk.raw) !== revision) throw new FileError('正文或评论已在另一处修改，当前输入仍保留。', 'CONFLICT');
    const previous = disk.raw === null ? null : parseReview(disk.raw, name);
    if (previous?.pendingWrite) throw new FileError('存在未完成保存，请先重新读取并恢复。', 'RECOVERY_REQUIRED');
    if (xml === disk.xml) {
      const raw = JSON.stringify(review, null, 2) + '\n';
      await replace(reviewPath, raw, disk.raw);
      const verified = await pair();
      if (verified.xml !== xml || verified.raw !== raw) throw new FileError('文件在保存后又发生变化，请重新读取。', 'CONFLICT');
      return snapshot(xml, raw, review);
    }
    const preparedReview: StoredReview = {...review, pendingWrite:{id:randomUUID(),beforeXML:disk.xml,beforeHash:digest(disk.xml),afterHash:digest(xml),startedAt:new Date().toISOString()}};
    const prepared = JSON.stringify(preparedReview, null, 2) + '\n';
    if (Buffer.byteLength(prepared) > REVIEW_LIMIT) throw new FileError('包含恢复快照的评论文件过大。', 'TOO_LARGE', 413);
    await replace(reviewPath, prepared, disk.raw);
    await hooks.afterPrepare?.();
    return finish(preparedReview, prepared);
  }
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => { const next = queue.then(action, action); queue = next.catch(() => undefined); return next; };
  async function asset(relative: string) {
    if (!relative || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(relative) || relative.includes('\\') || relative.split('/').includes('..') || !raster.test(relative))
      throw new FileError('只支持文章目录中的本地图片。', 'UNSAFE_ASSET', 403);
    let target: string;
    try { target = await realpath(resolve(folder, relative)); } catch { throw new FileError('图片不存在。', 'NOT_FOUND', 404); }
    if (!target.startsWith(folder + sep) || !raster.test(target)) throw new FileError('图片真实路径必须在文章目录内，且为受支持的图片格式。', 'UNSAFE_ASSET', 403);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 20_000_000) throw new FileError('图片类型或大小不支持。', 'UNSAFE_ASSET', 403);
      return {data:await handle.readFile(), extension:extname(target).toLowerCase()};
    } finally { await handle.close(); }
  }
  async function resource(relative: string) {
    const normalized = localResourcePath(relative);
    if (!normalized) throw new FileError('资源路径必须位于文章目录内。', 'UNSAFE_RESOURCE', 403);
    const snapshot = await read();
    const listed = projectFiles({name,path,reviewPath}, snapshot.xml, snapshot.review);
    if (!listed.some(file => file.kind === 'resource' && file.path === normalized))
      throw new FileError('此文件未被当前文章或资源记录引用。', 'UNLISTED_RESOURCE', 403);
    if (!/\.(?:txt|md|markdown|csv|tsv|json|xml|svg|mmd|mermaid|puml|plantuml|dot|log|yaml|yml|go|js|ts|css|html)$/i.test(normalized))
      throw new FileError('此资源暂不支持文本预览。', 'UNSUPPORTED_RESOURCE', 415);
    if (await realpath(folder) !== folder) throw new FileError('文章目录已变化，请重新打开。', 'PATH_CHANGED');
    const target = resolve(folder, normalized);
    if (!target.startsWith(folder + sep)) throw new FileError('资源路径越界。', 'UNSAFE_RESOURCE', 403);
    let handle;
    try {
      // Check every component and open nonblocking: a substituted FIFO must never
      // block the server, and a symlink to another in-directory file is still a link.
      let component = folder;
      for (const part of normalized.split('/')) {
        component = resolve(component, part);
        const info = await lstat(component);
        if (info.isSymbolicLink() || (component !== target && !info.isDirectory()))
          throw new FileError('资源不支持链接或特殊目录。', 'UNSAFE_RESOURCE', 403);
      }
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) throw new FileError('资源必须为独立的普通文件。', 'UNSAFE_RESOURCE', 403);
      if (before.size > 2_000_000) throw new FileError('文本资源需小于 2 MB。', 'TOO_LARGE', 413);
      if (await realpath(target) !== target) throw new FileError('资源路径已经变化。', 'UNSAFE_RESOURCE', 403);
      const buffer = Buffer.alloc(2_000_001);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      const after = await handle.stat();
      const entry = await lstat(target);
      if (bytesRead > 2_000_000 || after.size > 2_000_000) throw new FileError('文本资源需小于 2 MB。', 'TOO_LARGE', 413);
      if (before.dev !== entry.dev || before.ino !== entry.ino || entry.isSymbolicLink() || after.nlink !== 1 || entry.nlink !== 1 ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || await realpath(target) !== target)
        throw new FileError('资源读取期间发生变化，请重新选择。', 'CONFLICT');
      let text: string;
      try { text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(buffer.subarray(0, bytesRead)); }
      catch { throw new FileError('此资源不是 UTF-8 文本。', 'INVALID_ENCODING', 415); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
        throw new FileError('此资源包含二进制内容，暂不预览。', 'UNSUPPORTED_RESOURCE', 415);
      return {path:normalized,text};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileError('引用的资源文件不存在。', 'NOT_FOUND', 404);
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new FileError('资源不支持链接。', 'UNSAFE_RESOURCE', 403);
      throw error;
    } finally { await handle?.close(); }
  }
  // Validate before a file is made available in the HTTP session registry.
  await run(read);
  return {path, name, reviewPath, read:() => run(read), save:(xml:string, review:Review, revision:string) => run(() => save(xml,review,revision)), asset, resource:(relative:string) => run(() => resource(relative))};
}
