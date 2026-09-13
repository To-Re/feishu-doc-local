import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowserDirectory, chooseBrowserDirectory, type BrowserDirectoryHandle } from '../src/browser/files';
import { createReview, type Review } from '../src/core/types';
import { validateReview } from '../src/server/files';

const encode = (text: string) => new TextEncoder().encode(text);
type Stage = 'read' | 'open' | 'write' | 'close' | 'afterClose';
class MemoryFS {
  data = new Map<string, Uint8Array>();
  times = new Map<string, number>();
  active = new Set<string>();
  permission: PermissionState = 'granted';
  permissionRequests = 0;
  hook?: (stage: Stage, path: string) => void | Promise<void>;
  writes: string[] = [];
  set(path: string, content: string | Uint8Array) { this.data.set(path, typeof content === 'string' ? encode(content) : content); this.times.set(path, (this.times.get(path) || 0) + 1); }
  text(path: string) { const value = this.data.get(path); return value ? new TextDecoder().decode(value) : null; }
  directory(prefix = '', name = 'Articles'): BrowserDirectoryHandle {
    const fs = this;
    return {
      kind: 'directory', name,
      queryPermission: async () => fs.permission,
      requestPermission: async () => { fs.permissionRequests++; fs.permission = 'granted'; return fs.permission; },
      async *values() {
        const found = new Set<string>();
        for (const path of fs.data.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length), filename = rest.split('/')[0];
          if (!found.has(filename)) { found.add(filename); yield { kind: rest.includes('/') ? 'directory' : 'file', name: filename } as FileSystemHandle; }
        }
      },
      async getDirectoryHandle(child: string) {
        if (!fs.data.has(prefix + child) && [...fs.data.keys()].some(path => path.startsWith(prefix + child + '/'))) return fs.directory(prefix + child + '/', child);
        throw new DOMException('Missing directory', 'NotFoundError');
      },
      async removeEntry(child: string) { fs.data.delete(prefix + child); },
      async getFileHandle(child: string, options?: FileSystemGetFileOptions) {
        const path = prefix + child;
        if (!fs.data.has(path)) {
          if (!options?.create) throw new DOMException('Missing file', 'NotFoundError');
          fs.set(path, '');
        }
        return {
          name: child, kind: 'file',
          async getFile() {
            await fs.hook?.('read', path);
            if (!fs.data.has(path)) throw new DOMException('Missing file', 'NotFoundError');
            return new File([fs.data.get(path)! as Uint8Array<ArrayBuffer>], child, { lastModified: fs.times.get(path) || 0 });
          },
          async createWritable() {
            await fs.hook?.('open', path);
            if (fs.active.has(path)) throw new DOMException('Busy', 'NoModificationAllowedError');
            fs.active.add(path);
            let value = '', closed = false;
            return {
              async write(text: string) { await fs.hook?.('write', path); value = text; },
              async close() {
                await fs.hook?.('close', path);
                fs.set(path, value); fs.writes.push(path); closed = true; fs.active.delete(path);
                await fs.hook?.('afterClose', path);
              },
              async abort() { if (!closed) fs.active.delete(path); },
            } as FileSystemWritableFileStream;
          },
        } as FileSystemFileHandle;
      },
    } as unknown as BrowserDirectoryHandle;
  }
}
afterEach(() => vi.unstubAllGlobals());
async function setup(xml = '<p>原文</p>', existingReview = true) {
  const fs = new MemoryFS(); fs.set('article.xml', xml);
  const review = createReview('article.xml', xml);
  if (existingReview) fs.set('article.review.json', JSON.stringify(review, null, 2) + '\n');
  const store = await openBrowserDirectory(fs.directory()), document = await store.open('article.xml');
  const snapshot = await document.read();
  return { fs, store, document, snapshot, review };
}
function edited(review: Review, xml = '<p>修改后</p>'): Review { return { ...review, document: { ...review.document, xml }, operations: [...review.operations, { id: 'op', type: 'document.edit', author: '我', at: new Date().toISOString(), summary: '修改正文' }] }; }

describe('browser directory capabilities', () => {
  it('lists only direct XML files and rejects absolute/traversal names', async () => {
    const { fs, store } = await setup(); fs.set('more.XML', '<p/>'); fs.set('nested/other.xml', '<p/>'); fs.set('notes.txt', 'not an article');
    fs.hook = (stage, path) => { if (stage === 'read') throw new Error(`Listing must not read existing document contents: ${path}`); };
    expect(await store.listDocuments()).toEqual(['article.xml', 'more.XML']);
    fs.hook = undefined;
    for (const name of ['/tmp/a.xml', '../a.xml', 'folder/a.xml', 'a\\b.xml', '.xml', ' a.xml', 'a.txt']) await expect(store.open(name)).rejects.toMatchObject({ code: 'INVALID_NAME' });
    store.dispose(); await expect(store.listDocuments()).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('creates both files in the selected directory and preserves the standard review format', async () => {
    const fs = new MemoryFS(), store = await openBrowserDirectory(fs.directory());
    const document = await store.create('新稿.xml', '<标签> & 标题'), snapshot = await document.read();
    expect(fs.text('新稿.xml')).toBe('<title>&lt;标签&gt; &amp; 标题</title>\n<p></p>\n');
    expect(snapshot.review?.document.baselineXML).toBe(snapshot.xml);
    expect(JSON.parse(fs.text('新稿.review.json')!)).not.toHaveProperty('pendingWrite');
    expect(validateReview(JSON.parse(fs.text('新稿.review.json')!), '新稿.xml')).toEqual(snapshot.review);
    expect(document.handle.path).toBe('Articles/新稿.xml');
  });
  it('never replaces existing source or an existing sidecar on create', async () => {
    const { fs, store } = await setup(); const before = [...fs.data].map(([key, value]) => [key, [...value]]);
    await expect(store.create('article.xml')).rejects.toMatchObject({ code: 'EXISTS' });
    expect([...fs.data].map(([key, value]) => [key, [...value]])).toEqual(before);
    fs.set('orphan.review.json', '{"keep":true}');
    await expect(store.create('orphan.xml')).rejects.toMatchObject({ code: 'EXISTS' });
    expect(fs.text('orphan.xml')).toBeNull();
  });
  it('handles cancellation without an error and never requests permission in background', async () => {
    vi.stubGlobal('isSecureContext', true);
    const picker = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    vi.stubGlobal('showDirectoryPicker', picker);
    expect(await chooseBrowserDirectory()).toBeNull(); expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    const { fs, document, snapshot, review } = await setup(); fs.permission = 'prompt';
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'PERMISSION', status: 403 });
    expect(fs.text('article.xml')).toBe('<p>原文</p>');
    expect(fs.permissionRequests).toBe(0);
  });
  it('reauthorizes the same directory explicitly without switching or losing the unsaved revision', async () => {
    const { fs, document, snapshot, review } = await setup(); const handle = document.handle;
    fs.permission = 'prompt';
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ status: 403 });
    await document.requestPermission(); expect(fs.permissionRequests).toBe(1); expect(document.handle).toBe(handle);
    expect(fs.writes).toEqual([]);
    await document.save('<p>修改后</p>', edited(review), snapshot.revision);
    expect(fs.text('article.xml')).toBe('<p>修改后</p>');
  });
  it('requires a supported secure browser', async () => {
    vi.stubGlobal('isSecureContext', false); vi.stubGlobal('showDirectoryPicker', vi.fn());
    await expect(chooseBrowserDirectory()).rejects.toMatchObject({ code: 'UNSUPPORTED_BROWSER' });
  });
});

describe('pair snapshots and recoverable browser writes', () => {
  it('saves XML and comments together while retaining IDs, original baseline, and extra fields', async () => {
    const { fs, document, snapshot, review } = await setup();
    const next = edited(review); next.comments.push({ id: 'comment-id', author: '我', body: '意见', createdAt: new Date().toISOString(), status: 'open', anchor: { from: 1, to: 2, quote: '修', state: 'attached' }, replies: [] });
    const sent = { ...next, customMetadata: { unchanged: true } };
    const saved = await document.save(next.document.xml, sent, snapshot.revision);
    expect(saved.revision).not.toBe(snapshot.revision); expect(fs.text('article.xml')).toBe(next.document.xml);
    expect(saved.review).toEqual(sent); expect(saved.review?.document.baselineXML).toBe(snapshot.xml);
    expect(validateReview(JSON.parse(fs.text('article.review.json')!), 'article.xml')).toEqual(sent);
    expect((await document.read()).revision).toBe(saved.revision);
  });
  it('creates a missing sidecar on comment-only save without rewriting source', async () => {
    const { fs, document, snapshot, review } = await setup('<p>原文</p>\r\n', false);
    const saved = await document.save(snapshot.xml, review, snapshot.revision);
    expect(fs.writes).toEqual(['article.review.json']); expect(saved.xml).toBe('<p>原文</p>\r\n');
  });
  it.each(['xml', 'review'])('rejects stale revision after external %s changes', async kind => {
    const { fs, document, snapshot, review } = await setup();
    const file = kind === 'xml' ? 'article.xml' : 'article.review.json';
    fs.set(file, fs.text(file)! + '\n'); const external = fs.text(file);
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(fs.text(file)).toBe(external); expect(fs.writes).toEqual([]);
  });
  it('serializes concurrent saves and rejects the stale second writer', async () => {
    const { document, snapshot, review } = await setup();
    const results = await Promise.allSettled([document.save('<p>一</p>', edited(review, '<p>一</p>'), snapshot.revision), document.save('<p>二</p>', edited(review, '<p>二</p>'), snapshot.revision)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect((await document.read()).xml).toBe('<p>一</p>');
  });
  it('recovers after the journal commits but source writing fails', async () => {
    const { fs, document, snapshot, review } = await setup();
    fs.hook = (stage, path) => { if (stage === 'open' && path === 'article.xml') throw new DOMException('quota', 'QuotaExceededError'); };
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(fs.text('article.xml')).toBe(snapshot.xml); expect(JSON.parse(fs.text('article.review.json')!)).toHaveProperty('pendingWrite');
    fs.hook = undefined; const recovered = await document.read();
    expect(recovered.recovery).toBe(true); expect(recovered.xml).toBe('<p>修改后</p>'); expect(JSON.parse(fs.text('article.review.json')!)).not.toHaveProperty('pendingWrite');
  });
  it('recovers after source commits without applying the source a second time', async () => {
    const { fs, document, snapshot, review } = await setup(); let closes = 0;
    fs.hook = (stage, path) => { if (stage === 'close' && path === 'article.review.json' && ++closes === 2) throw new DOMException('quota', 'QuotaExceededError'); };
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(fs.text('article.xml')).toBe('<p>修改后</p>'); expect(JSON.parse(fs.text('article.review.json')!)).toHaveProperty('pendingWrite');
    fs.hook = undefined; expect((await document.read()).recovery).toBe(true);
    expect(fs.writes.filter(path => path === 'article.xml')).toHaveLength(1);
  });
  it('keeps third-party source changes and the pending journal instead of recovering over them', async () => {
    const { fs, document, snapshot, review } = await setup();
    fs.hook = (stage, path) => { if (stage === 'afterClose' && path === 'article.review.json') fs.set('article.xml', '<p>外部 AI 修改</p>'); };
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
    fs.hook = undefined; await expect(document.read()).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
    expect(fs.text('article.xml')).toBe('<p>外部 AI 修改</p>'); expect(JSON.parse(fs.text('article.review.json')!)).toHaveProperty('pendingWrite');
  });
  it('aborts a staged write when the target changes before close', async () => {
    const { fs, document, snapshot, review } = await setup();
    fs.hook = (stage, path) => { if (stage === 'write' && path === 'article.xml') fs.set(path, '<p>另一处修改</p>'); };
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.text('article.xml')).toBe('<p>另一处修改</p>'); expect(fs.active.size).toBe(0);
  });
  it.each(['new.xml', 'new.XML'])('lists and recovers interrupted %s creation even before XML exists', async name => {
    const fs = new MemoryFS(), store = await openBrowserDirectory(fs.directory());
    fs.hook = (stage, path) => { if (stage === 'open' && path === name) throw new DOMException('quota', 'QuotaExceededError'); };
    await expect(store.create(name, '新建')).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(fs.text(name)).toBeNull(); expect(await store.listDocuments()).toEqual([name]);
    fs.hook = undefined; const recovered = await (await store.open(name)).read();
    expect(recovered.recovery).toBe(true); expect(recovered.xml).toContain('新建'); expect(JSON.parse(fs.text('new.review.json')!)).not.toHaveProperty('pendingWrite');
  });
  it('leaves originals untouched if journal preparation fails', async () => {
    const { fs, document, snapshot, review } = await setup(undefined, false);
    fs.hook = (stage, path) => { if (stage === 'write' && path === 'article.review.json') throw new DOMException('quota', 'QuotaExceededError'); };
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(fs.text('article.xml')).toBe(snapshot.xml); expect(fs.text('article.review.json')).toBeNull();
  });
  it('rejects corrupt sidecars and invalid pending hashes without writing', async () => {
    const { fs, document, review } = await setup();
    for (const raw of ['{broken', JSON.stringify({ ...review, document: { ...review.document, name: 'other.xml' } }), JSON.stringify({ ...review, pendingWrite: { id: 'bad', beforeXML: review.document.xml, beforeHash: 'bad', afterHash: 'bad', startedAt: new Date().toISOString() } })]) {
      fs.set('article.review.json', raw); await expect(document.read()).rejects.toMatchObject({ code: 'REVIEW_FORMAT' }); expect(fs.text('article.review.json')).toBe(raw);
    }
    expect(fs.writes).toEqual([]);
  });
  it('does not recreate an externally removed XML or write malformed source', async () => {
    const { fs, document, snapshot, review } = await setup();
    await expect(document.save('<p>', edited(review, '<p>'), snapshot.revision)).rejects.toMatchObject({ code: 'INVALID_XML' });
    fs.data.delete('article.xml'); await expect(document.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(document.save('<p>修改后</p>', edited(review), snapshot.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(fs.writes).toEqual([]);
  });
  it('rejects a compact review whose pretty-printed file exceeds the readable limit', async () => {
    const { fs, document, snapshot, review } = await setup();
    const next = { ...review, operations: Array.from({ length: 200000 }, () => ({ id: 'x', type: 'x', author: 'x', at: '2026-09-13T00:00:00.000Z', summary: 'x' })) };
    expect(encode(JSON.stringify(next)).byteLength).toBeLessThan(20_000_000);
    expect(encode(JSON.stringify(next, null, 2)).byteLength).toBeGreaterThan(25_000_000);
    const before = fs.text('article.review.json');
    await expect(document.save(snapshot.xml, next, snapshot.revision)).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    expect(fs.text('article.review.json')).toBe(before); expect(fs.text('article.xml')).toBe(snapshot.xml); expect(fs.writes).toEqual([]);
  });
});

describe('private directory resource access', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  it('reads only explicitly referenced relative resources without any network request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
    const { fs, document } = await setup('<img path="@resources/picture.png"/><whiteboard path="@resources/board.svg"/><source path="@resources/note.txt"/>');
    fs.set('resources/picture.png', png); fs.set('resources/board.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>本地</text></svg>'); fs.set('resources/note.txt', '本地附件'); fs.set('secret.txt', 'unlisted');
    await document.read(); expect(document.assetURL('resources/picture.png')).toMatch(/^blob:/);
    expect(await document.readResource('resources/board.svg')).toMatchObject({ text: expect.stringContaining('<svg') });
    expect(await document.readResource('./resources//board.svg')).toMatchObject({ path: 'resources/board.svg', text: expect.stringContaining('<svg') });
    for (const path of ['secret.txt', '../secret.txt', '/etc/passwd.txt', 'https://example.com/a.svg', 'resources/../secret.txt']) await expect(document.readResource(path)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled(); document.dispose();
  });
  it('rejects fake raster images and never loads XML URLs remotely', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { fs, document } = await setup('<img path="@picture.png"/><img src="https://example.com/private.png"/>');
    fs.set('picture.png', '<svg onload="alert(1)"></svg>'); await document.read();
    expect(document.assetURL('picture.png')).toBe('data:,'); expect(fetch).not.toHaveBeenCalled();
  });
  it('invalidates changed resource blobs and releases them on disposal', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { fs, document } = await setup('<img path="@picture.png"/>'); fs.set('picture.png', png); await document.read();
    const before = document.assetURL('picture.png'); fs.set('picture.png', new Uint8Array([...png, 1])); await document.read();
    expect(document.assetURL('picture.png')).not.toBe(before); expect(revoke).toHaveBeenCalledWith(before);
    const after = document.assetURL('picture.png'); document.dispose(); expect(revoke).toHaveBeenCalledWith(after); expect(document.assetURL('picture.png')).toBe('data:,'); revoke.mockRestore();
  });
  it('keeps visual resource revisions stable until a referenced raster or SVG changes', async () => {
    const { fs, document } = await setup('<img path="@picture.png"/><whiteboard path="@board.svg"/>');
    fs.set('picture.png', png); fs.set('board.svg', '<svg/>');
    const first = await document.read(), initial = document.resourceRevision, blob = document.assetURL('picture.png');
    await document.read(); expect(document.resourceRevision).toBe(initial); expect(document.assetURL('picture.png')).toBe(blob);
    fs.set('unrelated.svg', '<svg/>'); await document.read(); expect(document.resourceRevision).toBe(initial);
    fs.set('board.svg', '<svg viewBox="0 0 20 20"/>');
    expect((await document.read()).revision).toBe(first.revision); expect(document.resourceRevision).not.toBe(initial);
    const svgChanged = document.resourceRevision; await document.read(); expect(document.resourceRevision).toBe(svgChanged);
    fs.set('picture.png', new Uint8Array([...png, 1])); await document.read(); expect(document.resourceRevision).not.toBe(svgChanged);
    const imageChanged = document.resourceRevision; fs.data.delete('board.svg'); await document.read(); expect(document.resourceRevision).not.toBe(imageChanged);
    const missing = document.resourceRevision; await document.read(); expect(document.resourceRevision).toBe(missing);
    fs.set('board.svg', '<svg/>'); await document.read(); expect(document.resourceRevision).not.toBe(missing);
    document.dispose();
  });
  it('prepares visual resource revisions after a save adds or removes references', async () => {
    const { fs, document, snapshot, review } = await setup(); const original = document.resourceRevision;
    fs.set('picture.png', png);
    const xml = snapshot.xml + '<img path="@picture.png"/>';
    const added = await document.save(xml, edited(review, xml), snapshot.revision);
    expect(document.resourceRevision).not.toBe(original); expect(document.assetURL('picture.png')).toMatch(/^blob:/);
    const withImage = document.resourceRevision; await document.read(); expect(document.resourceRevision).toBe(withImage);
    await document.save(snapshot.xml, edited(added.review!, snapshot.xml), added.revision);
    expect(document.resourceRevision).toBe(original); expect(document.assetURL('picture.png')).toBe('data:,');
    document.dispose();
  });
  it('rejects binary text and honors cancellation', async () => {
    const { fs, document } = await setup('<source path="@binary.txt"/>'); fs.set('binary.txt', new Uint8Array([0, 1, 2])); await document.read();
    await expect(document.readResource('binary.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_RESOURCE' });
    const controller = new AbortController(); controller.abort(); await expect(document.readResource('binary.txt', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
