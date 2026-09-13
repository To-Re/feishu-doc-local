// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFile, TFolder, Vault } from 'obsidian';
import { createReview, type Review } from '../../src/core/types';
import { openObsidianDirectory } from '../src/store';

const encoder = new TextEncoder(), decoder = new TextDecoder();
type Entry = { path: string; name: string; stat: { size: number; mtime: number }; children?: Entry[] };
class TestVault {
  configDir = '.obsidian';
  entries = new Map<string, Entry>([['', { path: '', name: 'Vault', stat: { size: 0, mtime: 0 }, children: [] }]]);
  data = new Map<string, Uint8Array>();
  writes: string[] = [];
  readPaths: string[] = [];
  sequence = 0;
  processHook?: (path: string) => void;
  createHook?: (path: string) => void;
  delete = vi.fn(() => { throw new Error('No physical deletion allowed'); });
  modify = vi.fn(() => { throw new Error('Writes must use process'); });
  getName() { return 'Vault'; }
  getRoot() { return this.entries.get('') as unknown as TFolder; }
  getAbstractFileByPath(path: string) { return this.entries.get(path) || null; }
  getFileByPath(path: string) { const entry = this.entries.get(path); return entry && !entry.children ? entry as unknown as TFile : null; }
  getFolderByPath(path: string) { const entry = this.entries.get(path); return entry?.children ? entry as unknown as TFolder : null; }
  folder(path: string) {
    if (this.entries.has(path)) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    this.folder(parent);
    const entry = { path, name: path.split('/').at(-1)!, stat: { size: 0, mtime: 0 }, children: [] };
    this.entries.set(path, entry); this.entries.get(parent)!.children!.push(entry);
  }
  put(path: string, value: string | Uint8Array) {
    const content = typeof value === 'string' ? encoder.encode(value) : value;
    let entry = this.entries.get(path);
    if (!entry) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      this.folder(parent);
      entry = { path, name: path.split('/').at(-1)!, stat: { size: content.length, mtime: ++this.sequence } };
      this.entries.set(path, entry); this.entries.get(parent)!.children!.push(entry);
    } else entry.stat = { size: content.length, mtime: ++this.sequence };
    this.data.set(path, content);
  }
  remove(path: string) {
    const entry = this.entries.get(path); this.entries.delete(path); this.data.delete(path);
    for (const parent of this.entries.values()) if (parent.children) parent.children = parent.children.filter(child => child !== entry);
  }
  text(path: string) { return this.data.has(path) ? decoder.decode(this.data.get(path)) : null; }
  async read(file: TFile) {
    if (this.getFileByPath(file.path) !== file) throw new Error('Missing file');
    this.readPaths.push(file.path); return this.text(file.path)!;
  }
  async readBinary(file: TFile) {
    if (this.getFileByPath(file.path) !== file) throw new Error('Missing file');
    this.readPaths.push(file.path); return this.data.get(file.path)!.slice().buffer as ArrayBuffer;
  }
  async create(path: string, text: string) {
    this.createHook?.(path);
    if (this.entries.has(path)) throw new Error('File already exists');
    this.put(path, text); this.writes.push(path); return this.getFileByPath(path)!;
  }
  async process(file: TFile, transform: (text: string) => string) {
    this.processHook?.(file.path);
    if (this.getFileByPath(file.path) !== file) throw new Error('Missing file');
    const text = transform(this.text(file.path)!);
    this.put(file.path, text); this.writes.push(file.path); return text;
  }
  api() { return this as unknown as Vault; }
}
const stores: Awaited<ReturnType<typeof openObsidianDirectory>>[] = [];
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open(vault: TestVault, path = 'articles') { const store = await openObsidianDirectory(vault.api(), path); stores.push(store); return store; }
async function fixture(xml = '<p>原稿</p>', withReview = true) {
  const vault = new TestVault(); vault.put('articles/draft.xml', xml);
  const review = createReview('draft.xml', xml);
  if (withReview) vault.put('articles/draft.review.json', JSON.stringify(review, null, 2) + '\n');
  const store = await open(vault), document = await store.open('draft.xml'), snapshot = await document.read();
  return { vault, store, document, snapshot, review };
}
function changed(review: Review, xml = '<p>修订稿</p>'): Review { return { ...review, document: { ...review.document, xml } }; }

describe('Obsidian vault document store', () => {
  it('lists only direct XMLs and exposes vault-relative paths', async () => {
    const { vault, store, document } = await fixture();
    vault.put('articles/第二篇.XML', '<p/>'); vault.put('articles/nested/inside.xml', '<p/>'); vault.put('articles/readme.md', '说明');
    vault.readPaths = [];
    expect(await store.listDocuments()).toEqual(['第二篇.XML', 'draft.xml']); expect(vault.readPaths).toEqual([]);
    expect(document.handle.path).toBe('articles/draft.xml'); expect(document.handle.reviewPath).toBe('articles/draft.review.json');
    const root = await open(vault, ''); const rootDoc = await root.create('root.xml');
    expect(rootDoc.handle.path).toBe('root.xml'); expect(root.directoryName).toBe('Vault');
    expect(vault.text('root.review.json')).not.toBeNull();
  });

  it('creates XML and sidecar through Vault.create and never deletes physical files', async () => {
    const vault = new TestVault(); vault.folder('articles'); const store = await open(vault);
    const document = await store.create('新文稿.xml', '文章 & 标题'), snapshot = await document.read();
    expect(snapshot.xml).toBe('<title>文章 &amp; 标题</title>\n<p></p>\n');
    expect(JSON.parse(vault.text('articles/新文稿.review.json')!)).toEqual(snapshot.review);
    expect(snapshot.review?.document.baselineXML).toBe(snapshot.xml);
    expect(vault.writes).toEqual(['articles/新文稿.review.json', 'articles/新文稿.xml', 'articles/新文稿.review.json']);
    expect(vault.delete).not.toHaveBeenCalled(); expect(vault.modify).not.toHaveBeenCalled();
  });

  it('saves source and comment operations while preserving unknown sidecar fields', async () => {
    const { vault, document, snapshot, review } = await fixture();
    const next = { ...changed(review), futureField: { keep: 'yes' } };
    next.comments.push({ id: 'comment-id', author: '作者', body: '补充论据', status: 'open', createdAt: new Date().toISOString(), anchor: { from: 1, to: 2, quote: '修', state: 'attached' }, replies: [] });
    const saved = await document.save(next.document.xml, next, snapshot.revision);
    expect(vault.text('articles/draft.xml')).toBe(next.document.xml);
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).toEqual(next);
    expect(saved.review).toEqual(next); expect(saved.revision).not.toBe(snapshot.revision);
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it('creates a missing sidecar on comment-only save without touching XML bytes', async () => {
    const { vault, document, snapshot, review } = await fixture('\ufeff<p>原稿</p>\r\n', false);
    await document.save(snapshot.xml, review, snapshot.revision);
    expect(vault.writes).toEqual(['articles/draft.review.json']);
    expect(vault.data.get('articles/draft.xml')).toEqual(encoder.encode('\ufeff<p>原稿</p>\r\n'));
  });

  it.each(['draft.xml', 'draft.review.json'])('rejects stale snapshots after external %s changes', async name => {
    const { vault, document, snapshot, review } = await fixture();
    vault.put(`articles/${name}`, vault.text(`articles/${name}`)! + '\n');
    const external = vault.text(`articles/${name}`);
    await expect(document.save('<p>修订稿</p>', changed(review), snapshot.revision)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(vault.text(`articles/${name}`)).toBe(external); expect(vault.writes).toEqual([]);
  });

  it('compares inside Vault.process so a last-moment edit is not overwritten', async () => {
    const { vault, document, snapshot, review } = await fixture();
    vault.processHook = path => { if (path.endsWith('.xml')) vault.put(path, '<p>外部修改</p>'); };
    await expect(document.save('<p>修订稿</p>', changed(review), snapshot.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(vault.text('articles/draft.xml')).toBe('<p>外部修改</p>');
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).toHaveProperty('pendingWrite');
    vault.processHook = undefined;
    await expect(document.read()).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
  });

  it('recovers journaled changes after an interrupted Vault.process write', async () => {
    const { vault, document, snapshot, review } = await fixture();
    vault.processHook = path => { if (path.endsWith('.xml')) throw new Error('Disk unavailable'); };
    await expect(document.save('<p>修订稿</p>', changed(review), snapshot.revision)).rejects.toThrow('Disk unavailable');
    expect(vault.text('articles/draft.xml')).toBe(snapshot.xml);
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).toHaveProperty('pendingWrite');
    vault.processHook = undefined;
    const restored = await document.read(); expect(restored.recovery).toBe(true); expect(restored.xml).toBe('<p>修订稿</p>');
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).not.toHaveProperty('pendingWrite');
  });

  it('recovers after XML commits but the final sidecar commit fails', async () => {
    const { vault, document, snapshot, review } = await fixture(); let reviewWrites = 0;
    vault.processHook = path => { if (path.endsWith('.review.json') && ++reviewWrites === 2) throw new Error('Disk unavailable'); };
    await expect(document.save('<p>修订稿</p>', changed(review), snapshot.revision)).rejects.toThrow('Disk unavailable');
    expect(vault.text('articles/draft.xml')).toBe('<p>修订稿</p>');
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).toHaveProperty('pendingWrite');
    vault.processHook = undefined; const recovered = await document.read();
    expect(recovered.recovery).toBe(true); expect(vault.writes.filter(path => path.endsWith('.xml'))).toHaveLength(1);
    expect(JSON.parse(vault.text('articles/draft.review.json')!)).not.toHaveProperty('pendingWrite');
  });

  it('does not overwrite a concurrent save from a second view of the same vault', async () => {
    const { vault, document, snapshot, review } = await fixture();
    const otherStore = await open(vault), otherDocument = await otherStore.open('draft.xml');
    const otherSnapshot = await otherDocument.read();
    const results = await Promise.allSettled([
      document.save('<p>视图一</p>', changed(review, '<p>视图一</p>'), snapshot.revision),
      otherDocument.save('<p>视图二</p>', changed(review, '<p>视图二</p>'), otherSnapshot.revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const final = await document.read();
    expect(['<p>视图一</p>', '<p>视图二</p>']).toContain(final.xml);
    expect(final.review?.document.xml).toBe(final.xml); expect(vault.modify).not.toHaveBeenCalled();
  });

  it('lists and recovers an interrupted creation without leaving a physical empty XML', async () => {
    const vault = new TestVault(); vault.folder('articles'); const store = await open(vault);
    vault.createHook = path => { if (path.endsWith('.XML')) throw new Error('Disk unavailable'); };
    await expect(store.create('new.XML')).rejects.toThrow('Disk unavailable');
    expect(vault.text('articles/new.XML')).toBeNull(); expect(await store.listDocuments()).toEqual(['new.XML']);
    vault.createHook = undefined; const restored = await (await store.open('new.XML')).read();
    expect(restored.recovery).toBe(true); expect(restored.xml).toContain('<title>new</title>');
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it('does not replace or delete a competing writer\'s empty file on create', async () => {
    const vault = new TestVault(); vault.folder('articles'); const store = await open(vault);
    vault.createHook = path => { if (path === 'articles/new.xml') vault.put(path, ''); };
    await expect(store.create('new.xml')).rejects.toMatchObject({ code: 'EXISTS' });
    expect(vault.text('articles/new.xml')).toBe(''); expect(vault.delete).not.toHaveBeenCalled();
    expect(JSON.parse(vault.text('articles/new.review.json')!)).toHaveProperty('pendingWrite');
  });

  it('keeps existing files and sidecars and rejects deleted or malformed source', async () => {
    const { vault, store, document, snapshot, review } = await fixture();
    await expect(store.create('draft.xml')).rejects.toMatchObject({ code: 'EXISTS' });
    vault.put('articles/orphan.review.json', '{"keep":true}');
    await expect(store.create('orphan.xml')).rejects.toMatchObject({ code: 'EXISTS' });
    await expect(document.save('<p>', changed(review, '<p>'), snapshot.revision)).rejects.toMatchObject({ code: 'INVALID_XML' });
    vault.remove('articles/draft.xml'); await expect(document.read()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(document.save('<p>修订稿</p>', changed(review), snapshot.revision)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(vault.writes).toEqual([]);
  });

  it('rejects invalid directories, unsafe names and Obsidian configuration access', async () => {
    const { vault, store } = await fixture(); vault.folder('.obsidian');
    for (const path of ['../articles', '/articles', 'articles/..', 'articles//other', 'articles\\other', 'https://example.com']) {
      await expect(openObsidianDirectory(vault.api(), path)).rejects.toMatchObject({ code: 'INVALID_DIRECTORY' });
    }
    await expect(openObsidianDirectory(vault.api(), '.obsidian')).rejects.toMatchObject({ code: 'UNSAFE_RESOURCE' });
    for (const name of ['../escape.xml', '/absolute.xml', 'nested/inside.xml']) await expect(store.open(name)).rejects.toMatchObject({ code: 'INVALID_NAME' });
    store.dispose(); await expect(store.listDocuments()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('reads only referenced safe resources and releases raster object URLs', async () => {
    const { vault, document } = await fixture('<img path="@assets/image.png"/><whiteboard type="svg" path="@assets/board.svg"/><source path="@assets/note.txt"/>');
    const fetch = vi.spyOn(globalThis, 'fetch'); const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vault.put('articles/assets/image.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    vault.put('articles/assets/board.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>本地</text></svg>');
    vault.put('articles/assets/note.txt', '附件'); vault.put('articles/secret.txt', '不可读取');
    await document.read(); const revision = document.resourceRevision, image = document.assetURL('assets/image.png');
    expect(image).toMatch(/^blob:/); expect((await document.readResource('assets/board.svg')).text).toContain('<svg');
    expect((await document.readResource('./assets/note.txt')).text).toBe('附件');
    for (const path of ['secret.txt', '../secret.txt', '/secret.txt', 'assets/../secret.txt', 'https://example.com/x.svg']) await expect(document.readResource(path)).rejects.toMatchObject({ status: 403 });
    await document.read(); expect(document.resourceRevision).toBe(revision);
    vault.put('articles/assets/board.svg', '<svg/>'); await document.read(); expect(document.resourceRevision).not.toBe(revision);
    document.dispose(); expect(revoke).toHaveBeenCalledWith(image); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not read oversized binary data and rejects invalid UTF-8 without saving', async () => {
    const { vault, document } = await fixture();
    const file = vault.getFileByPath('articles/draft.xml')!;
    file.stat.size = 25_000_001; vault.readPaths = [];
    await expect(document.read()).rejects.toMatchObject({ code: 'TOO_LARGE' }); expect(vault.readPaths).toEqual([]);
    vault.put('articles/draft.xml', new Uint8Array([255, 254]));
    await expect(document.read()).rejects.toMatchObject({ code: 'INVALID_ENCODING' }); expect(vault.writes).toEqual([]);
  });
});
