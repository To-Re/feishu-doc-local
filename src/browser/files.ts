import type { DocumentHandle, Review, Snapshot } from '../core/types';
import { createReview, uid } from '../core/types';
import { parseDocxXML } from '../core/docxml';
import { isProjectImage, localResourcePath, projectFiles } from '../core/project-files';
import { sha256, validateBrowserReview, type StoredBrowserReview } from './review';

export class BrowserFileError extends Error {
  constructor(message: string, readonly code = 'CONFLICT', readonly status = 409) { super(message); this.name = 'BrowserFileError'; }
}
export interface BrowserDocument {
  handle: DocumentHandle;
  /** Stable after read/save; changes only when a referenced visual resource changes. */
  readonly resourceRevision: string;
  read(): Promise<Snapshot>;
  save(xml: string, review: Review, revision: string): Promise<Snapshot>;
  assetURL(path: string): string;
  readResource(path: string, signal?: AbortSignal): Promise<{ path: string; text: string }>;
  requestPermission(): Promise<void>;
  dispose(): void;
}
export interface BrowserDocumentStore {
  directoryName: string;
  listDocuments(): Promise<string[]>;
  open(name: string): Promise<BrowserDocument>;
  create(name: string, title?: string): Promise<BrowserDocument>;
  dispose(): void;
}
export interface BrowserDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}
const XML_LIMIT = 5_000_000, REVIEW_LIMIT = 25_000_000, RESOURCE_LIMIT = 2_000_000, IMAGE_LIMIT = 20_000_000;
const totalImageLimit = 80_000_000;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const reviewName = (name: string) => name.replace(/\.xml$/i, '.review.json');
const rasterTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const resourceTypes = /\.(?:txt|md|markdown|csv|tsv|json|xml|svg|mmd|mermaid|puml|plantuml|dot|log|yaml|yml|go|js|ts|css|html)$/i;
function validName(name: string) {
  if (!name || name.trim() !== name || !/\.xml$/i.test(name) || name.length > 240 || /[\\/:\0-\x1f\x7f]/.test(name) || name.startsWith('.') || name === '.xml') {
    throw new BrowserFileError('请输入当前授权目录内的 XML 文件名，例如 article.xml；不接受完整路径或子目录。', 'INVALID_NAME', 400);
  }
}
function validateXML(xml: string) {
  if (typeof xml !== 'string' || bytes(xml) > XML_LIMIT) throw new BrowserFileError('XML 文件需小于 5 MB。', 'TOO_LARGE', 413);
  try { parseDocxXML(xml); } catch (error) { throw new BrowserFileError(`XML 格式不正确：${error instanceof Error ? error.message : String(error)}`, 'INVALID_XML', 400); }
}
function normalizeError(error: unknown): Error {
  if (error instanceof BrowserFileError) return error;
  const name = error instanceof Error ? error.name : '';
  if (['NotAllowedError', 'SecurityError'].includes(name)) return new BrowserFileError('目录读写权限已失效或被拒绝；未保存输入仍保留，请点击“重新授权并重试”。', 'PERMISSION', 403);
  if (name === 'NotFoundError') return new BrowserFileError('文件或目录已被移动或删除，请重新选择目录。', 'NOT_FOUND', 404);
  if (name === 'NoModificationAllowedError') return new BrowserFileError('文件正被另一个页面写入；输入仍保留，请稍后重试。', 'CONFLICT');
  if (name === 'QuotaExceededError') return new BrowserFileError('磁盘空间或浏览器写入额度不足；输入和恢复记录已保留。', 'WRITE_FAILED', 507);
  return error instanceof Error ? error : new Error(String(error));
}
async function checkPermission(directory: BrowserDirectoryHandle, mode: 'read' | 'readwrite') {
  if (directory.queryPermission && await directory.queryPermission({ mode }) !== 'granted') {
    throw new BrowserFileError('需要重新授权此目录。请点击“重新授权并重试”；后台保存不会弹出授权窗口。', 'PERMISSION', 403);
  }
}
async function textOf(file: File, limit: number): Promise<string> {
  if (file.size > limit) throw new BrowserFileError('文件过大，未读取或覆盖。', 'TOO_LARGE', 413);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch (error) {
    if (error instanceof TypeError) throw new BrowserFileError('文件必须使用 UTF-8 编码。', 'INVALID_ENCODING', 400);
    throw error;
  }
}
function rasterMatches(data: Uint8Array, extension: string) {
  const ascii = (start: number, length: number) => String.fromCharCode(...data.slice(start, start + length));
  if (extension === 'png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => data[i] === value);
  if (extension === 'jpg' || extension === 'jpeg') return data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (extension === 'webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (extension === 'avif') return ascii(4, 4) === 'ftyp' && /avif|avis/.test(ascii(8, Math.min(data.length - 8, 64)));
  return false;
}

/** Call directly from a click handler. No network, storage, automatic prompts,
 * credentials, absolute paths or browser-private document copies are used. */
export async function chooseBrowserDirectory(): Promise<BrowserDocumentStore | null> {
  const picker = (globalThis as typeof globalThis & { showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<BrowserDirectoryHandle> }).showDirectoryPicker;
  if (!picker || !globalThis.isSecureContext) throw new BrowserFileError('请使用支持目录读写的桌面 Chrome，并通过 HTTPS 或 localhost 打开页面。', 'UNSUPPORTED_BROWSER', 400);
  try { return await openBrowserDirectory(await picker.call(globalThis, { mode: 'readwrite' })); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') return null; throw normalizeError(error); }
}

export async function openBrowserDirectory(directory: BrowserDirectoryHandle): Promise<BrowserDocumentStore> {
  await checkPermission(directory, 'readwrite');
  const opened = new Map<string, BrowserDocument>();
  let disposed = false;
  function active() { if (disposed) throw new BrowserFileError('此目录会话已关闭，请重新打开目录。', 'CLOSED', 410); }
  async function readText(name: string): Promise<string | null> {
    active(); await checkPermission(directory, 'read');
    try { return await textOf(await (await directory.getFileHandle(name)).getFile(), name.toLowerCase().endsWith('.xml') ? XML_LIMIT : REVIEW_LIMIT); }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundError') return null; throw normalizeError(error); }
  }
  async function replace(name: string, value: string, expected: string | null) {
    active(); await checkPermission(directory, 'readwrite');
    if (await readText(name) !== expected) throw new BrowserFileError('文件已在另一处修改，未覆盖；当前输入仍保留。');
    const created = expected === null;
    let writer: FileSystemWritableFileStream | undefined;
    let didClose = false;
    try {
      const file = await directory.getFileHandle(name, { create: created });
      if (created && (await file.getFile()).size !== 0) throw new BrowserFileError('同名文件刚刚被其他程序创建，未覆盖。', 'EXISTS');
      writer = await file.createWritable({ keepExistingData: false, mode: 'exclusive' } as FileSystemCreateWritableOptions);
      const before = created ? '' : expected;
      if (await readText(name) !== before) throw new BrowserFileError('文件在准备保存时已改变，未覆盖。');
      await writer.write(value);
      if (await readText(name) !== before) throw new BrowserFileError('文件在写入期间已改变，未覆盖。');
      await writer.close(); didClose = true;
      if (await readText(name) !== value) throw new BrowserFileError('文件保存后又发生变化，请保留输入并重新核对。');
    } catch (error) {
      if (writer && !didClose) try { await writer.abort(); } catch { /* The original error determines the save outcome. */ }
      // Only remove an empty entry that this operation just created. Never roll
      // back a completed close or delete any nonempty/existing file on failure.
      if (created && !didClose) {
        try { if (await readText(name) === '') await directory.removeEntry(name); } catch { /* Keep the original failure and any recovery journal. */ }
      }
      throw normalizeError(error);
    }
  }
  async function parseReview(raw: string | null, name: string) {
    if (raw === null) return null;
    try { return await validateBrowserReview(JSON.parse(raw), name); }
    catch (error) { throw new BrowserFileError(error instanceof SyntaxError ? '评论文件不是合法 JSON，原文件未被覆盖。' : error instanceof Error ? error.message : String(error), 'REVIEW_FORMAT'); }
  }
  const locks = new Map<string, Promise<unknown>>();
  function run<T>(name: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(name) || Promise.resolve();
    const next = previous.then(async () => {
      active();
      try {
        const lockManager = globalThis.navigator?.locks;
        return lockManager ? await lockManager.request(`feishu-doc-local:${directory.name}/${name}`, action) : await action();
      } catch (error) { throw normalizeError(error); }
    });
    locks.set(name, next.catch(() => undefined));
    return next;
  }
  function makeDocument(name: string): BrowserDocument {
    const handle: DocumentHandle = { id: uid(), name, path: `${directory.name}/${name}`, reviewPath: `${directory.name}/${reviewName(name)}` };
    const urls = new Map<string, { signature: string; url: string }>();
    let latest: Snapshot | undefined, closed = false, resourceRevision = '[]';
    const ready = () => { active(); if (closed) throw new BrowserFileError('此文档已关闭。', 'CLOSED', 410); };
    async function pair() {
      ready();
      for (let attempt = 0; attempt < 3; attempt++) {
        const xml = await readText(name), raw = await readText(reviewName(name));
        if (xml === await readText(name) && raw === await readText(reviewName(name))) return { xml, raw };
      }
      throw new BrowserFileError('正文或评论正在被另一处修改，请稍后重试。');
    }
    async function snapshot(xml: string, raw: string | null, review: Review | null, recovery = false): Promise<Snapshot> {
      return { xml, review, revision: await sha256(JSON.stringify([xml, raw])), ...(recovery ? { recovery: true } : {}) };
    }
    async function resourceFile(path: string, signal?: AbortSignal) {
      ready(); signal?.throwIfAborted();
      const normalized = localResourcePath(path);
      if (!normalized) throw new BrowserFileError('资源路径必须位于当前文章目录内。', 'UNSAFE_RESOURCE', 403);
      if (!latest || !projectFiles(handle, latest.xml, latest.review).some(file => file.kind === 'resource' && file.path === normalized)) {
        throw new BrowserFileError('当前文章没有引用此资源，未读取。', 'UNLISTED_RESOURCE', 403);
      }
      await checkPermission(directory, 'read');
      let parent: FileSystemDirectoryHandle = directory;
      const parts = normalized.split('/');
      for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
      const file = await (await parent.getFileHandle(parts.at(-1)!)).getFile();
      signal?.throwIfAborted(); return file;
    }
    async function prepareResources() {
      const paths = new Set(projectFiles(handle, latest!.xml, latest!.review).filter(file => file.kind === 'resource' &&
        (isProjectImage(file.path) || /\.svg$/i.test(file.path))).map(file => file.path).sort());
      const signatures: string[][] = [];
      let total = 0;
      for (const [path, cached] of urls) if (!paths.has(path)) { URL.revokeObjectURL(cached.url); urls.delete(path); }
      for (const path of paths) {
        const record = [path, 'unavailable', '']; signatures.push(record);
        try {
          const file = await resourceFile(path);
          const signature = `${file.size}:${file.lastModified}`;
          record[1] = signature;
          // SVG stays inert text and is sanitized by Reader. Stat its referenced
          // file here so polling can refresh it without rebuilding every board.
          if (/\.svg$/i.test(path)) continue;
          total += file.size;
          if (file.size > IMAGE_LIMIT || total > totalImageLimit) throw new BrowserFileError('图片缓存超过大小限制。', 'TOO_LARGE', 413);
          const cached = urls.get(path);
          if (cached?.signature === signature) { record[2] = cached.url; continue; }
          const content = await file.arrayBuffer(), extension = path.split('.').at(-1)!.toLowerCase();
          ready();
          if (!rasterMatches(new Uint8Array(content), extension)) throw new BrowserFileError('资源不是受支持的栅格图片。', 'UNSAFE_RESOURCE', 403);
          const url = URL.createObjectURL(new Blob([content], { type: rasterTypes[extension] }));
          const previous = urls.get(path); if (previous) URL.revokeObjectURL(previous.url);
          urls.set(path, { signature, url });
          record[2] = url;
        } catch {
          // A missing/invalid picture must not block opening or saving XML. The
          // renderer shows its unavailable-resource placeholder; no URL is fetched.
          const previous = urls.get(path); if (previous) URL.revokeObjectURL(previous.url);
          urls.delete(path);
        }
      }
      ready(); resourceRevision = JSON.stringify(signatures);
    }
    async function finish(review: StoredBrowserReview, prepared: string): Promise<Snapshot> {
      const pending = review.pendingWrite!;
      const disk = await pair();
      if (disk.raw !== prepared) throw new BrowserFileError('评论文件已改变，未继续未完成的保存。');
      validateXML(review.document.xml);
      if (disk.xml === pending.beforeXML || (disk.xml === null && pending.createdDocument === true && pending.beforeXML === '')) {
        await replace(name, review.document.xml, disk.xml);
      } else if (disk.xml !== review.document.xml) throw new BrowserFileError('正文与恢复记录的前后版本均不一致，未覆盖；请保留两份文件。', 'RECOVERY_CONFLICT');
      if (await readText(name) !== review.document.xml) throw new BrowserFileError('正文在保存中被修改，未提交反馈。');
      const { pendingWrite: _pending, ...committed } = review;
      const raw = JSON.stringify(committed, null, 2) + '\n';
      await replace(reviewName(name), raw, prepared);
      const verified = await pair();
      if (verified.xml !== review.document.xml || verified.raw !== raw) throw new BrowserFileError('保存后文件再次改变，请重新核对。');
      return snapshot(verified.xml, verified.raw, committed);
    }
    async function readCurrent(): Promise<Snapshot> {
      const disk = await pair(), review = await parseReview(disk.raw, name);
      if (review?.pendingWrite) return { ...await finish(review, disk.raw!), recovery: true };
      if (disk.xml === null) throw new BrowserFileError('XML 文件不存在或已删除。', 'NOT_FOUND', 404);
      validateXML(disk.xml);
      return snapshot(disk.xml, disk.raw, review);
    }
    const document: BrowserDocument = {
      handle,
      get resourceRevision() { return resourceRevision; },
      read: () => run(name, async () => { latest = await readCurrent(); await prepareResources(); return latest; }),
      save: (xml, review, revision) => run(name, async () => {
        ready(); await checkPermission(directory, 'readwrite'); validateXML(xml);
        const supplied = await validateBrowserReview(review, name);
        if (supplied.pendingWrite || supplied.document.xml !== xml || typeof revision !== 'string') throw new BrowserFileError('正文和评论快照不一致或包含恢复标记，未保存。', 'INVALID_REQUEST', 400);
        if (bytes(JSON.stringify(supplied)) > REVIEW_LIMIT - XML_LIMIT) throw new BrowserFileError('评论记录过大。', 'TOO_LARGE', 413);
        const disk = await pair();
        if (disk.xml === null) throw new BrowserFileError('XML 文件已删除，未重新创建。', 'NOT_FOUND', 404);
        if (await sha256(JSON.stringify([disk.xml, disk.raw])) !== revision) throw new BrowserFileError('正文或评论已在另一处修改，当前输入仍保留。');
        const before = await parseReview(disk.raw, name);
        if (before?.pendingWrite) throw new BrowserFileError('存在未完成保存，请先读取并恢复。', 'RECOVERY_REQUIRED');
        if (xml === disk.xml) {
          const raw = JSON.stringify(supplied, null, 2) + '\n';
          if (bytes(raw) > REVIEW_LIMIT) throw new BrowserFileError('格式化后的评论记录过大，未保存。', 'TOO_LARGE', 413);
          await replace(reviewName(name), raw, disk.raw);
          const verified = await pair();
          if (verified.xml !== xml || verified.raw !== raw) throw new BrowserFileError('评论保存后文件又发生变化，请重新读取。');
          latest = await snapshot(xml, raw, supplied);
        } else {
          const prepared: StoredBrowserReview = { ...supplied, pendingWrite: { id: uid(), beforeXML: disk.xml,
            beforeHash: await sha256(disk.xml), afterHash: await sha256(xml), startedAt: new Date().toISOString() } };
          const raw = JSON.stringify(prepared, null, 2) + '\n';
          if (bytes(raw) > REVIEW_LIMIT) throw new BrowserFileError('恢复记录过大，未保存。', 'TOO_LARGE', 413);
          await replace(reviewName(name), raw, disk.raw);
          latest = await finish(prepared, raw);
        }
        await prepareResources(); return latest;
      }),
      assetURL: path => urls.get(localResourcePath(path) || '')?.url || 'data:,',
      readResource: async (path, signal) => {
        try {
          const normalized = localResourcePath(path);
          if (!normalized) throw new BrowserFileError('资源路径必须位于当前文章目录内。', 'UNSAFE_RESOURCE', 403);
          if (!resourceTypes.test(normalized)) throw new BrowserFileError('此资源不支持文本预览。', 'UNSUPPORTED_RESOURCE', 415);
          const text = await textOf(await resourceFile(normalized, signal), RESOURCE_LIMIT);
          ready(); signal?.throwIfAborted();
          if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new BrowserFileError('此资源包含二进制内容，未预览。', 'UNSUPPORTED_RESOURCE', 415);
          return { path: normalized, text };
        } catch (error) { throw normalizeError(error); }
      },
      requestPermission: async () => {
        ready();
        if (!directory.requestPermission) throw new BrowserFileError('此浏览器不能恢复目录授权，请保留草稿并使用支持目录读写的桌面 Chrome。', 'UNSUPPORTED_BROWSER', 400);
        try {
          // Invoke before the first await: the UI calls this from the user's
          // permission button, and the original directory identity is retained.
          const requested = directory.requestPermission({ mode: 'readwrite' });
          if (await requested !== 'granted') throw new BrowserFileError('目录授权未获允许，草稿仍保留且未保存。', 'PERMISSION', 403);
        } catch (error) { throw normalizeError(error); }
      },
      dispose: () => { closed = true; for (const item of urls.values()) URL.revokeObjectURL(item.url); urls.clear(); opened.delete(name); },
    };
    return document;
  }
  return {
    directoryName: directory.name,
    listDocuments: async () => {
      active(); await checkPermission(directory, 'read');
      const names = new Set<string>(), recovery: string[] = [];
      try {
        for await (const entry of directory.values()) {
          if (entry.kind !== 'file') continue;
          if (/\.xml$/i.test(entry.name)) { try { validName(entry.name); names.add(entry.name); } catch { /* Not a selectable XML name. */ } }
          else if (/\.review\.json$/i.test(entry.name)) recovery.push(entry.name);
        }
        // Interrupted creation can leave a valid journal before XML exists.
        const existingSidecars = new Set([...names].map(reviewName));
        for (const sidecar of recovery) {
          if (existingSidecars.has(sidecar)) continue;
          try {
            const raw = await readText(sidecar), value = raw === null ? null : JSON.parse(raw);
            const name: unknown = value?.document?.name;
            if (typeof name !== 'string') continue;
            validName(name);
            if (names.has(name) || reviewName(name) !== sidecar) continue;
            const review = await validateBrowserReview(value, name);
            if (review.pendingWrite?.createdDocument) names.add(name);
          } catch { /* Unrelated or invalid JSON is never changed. */ }
        }
        return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      } catch (error) { throw normalizeError(error); }
    },
    open: name => run(name, async () => {
      validName(name);
      if (!opened.has(name)) opened.set(name, makeDocument(name));
      const document = opened.get(name)!;
      // Do not recursively acquire the same per-file lock; the caller reads the
      // returned document, which performs recovery and prepares resource URLs.
      if (await readText(name) === null) {
        const review = await parseReview(await readText(reviewName(name)), name);
        if (!review?.pendingWrite?.createdDocument) throw new BrowserFileError('XML 文件不存在。', 'NOT_FOUND', 404);
      }
      return document;
    }),
    create: async (name, title) => {
      const document = await run(name, async () => {
      validName(name); await checkPermission(directory, 'readwrite');
      if (await readText(name) !== null || await readText(reviewName(name)) !== null) throw new BrowserFileError('同名正文或评论文件已存在，未覆盖；请使用其他文件名。', 'EXISTS');
      const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const xml = `<title>${escape(title?.trim() || name.replace(/\.xml$/i, ''))}</title>\n<p></p>\n`;
      validateXML(xml);
      const review: StoredBrowserReview = { ...createReview(name, xml), pendingWrite: { id: uid(), beforeXML: '', beforeHash: await sha256(''), afterHash: await sha256(xml), startedAt: new Date().toISOString(), createdDocument: true } };
      // Journal first. Any later interruption leaves a recoverable, listed draft.
      await replace(reviewName(name), JSON.stringify(review, null, 2) + '\n', null);
      const document = makeDocument(name); opened.set(name, document);
      // Finalize after releasing this lock; read() acquires the per-file lock.
      return document;
      });
      await document.read();
      return document;
    },
    dispose: () => { disposed = true; for (const document of [...opened.values()]) document.dispose(); opened.clear(); },
  };
}
