import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { createLocalServer } from '../src/server/server';
import { createReview, type DocumentHandle, type Session, type Snapshot } from '../src/core/types';
import type { CloudSnapshot, CloudSyncReport, CloudTransport } from '../src/core/cloud-types';

const xml = '<title id="docA">测试</title><p id="p1">原文</p>';
const timestamp = '2026-09-12T00:00:00Z';
const opened: Server[] = [], folders: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const server of opened.splice(0)) if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture(bound = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lark-review-sync-http-'))); folders.push(root);
  const site = join(root, 'site'); await mkdir(site);
  await writeFile(join(site, 'index.html'), '<main>本地同步测试</main>');
  const file = join(root, 'article.xml'), sidecar = join(root, 'article.review.json');
  const other = join(root, 'other.xml'), otherSidecar = join(root, 'other.review.json');
  await writeFile(file, xml); await writeFile(other, '<title>另一稿件</title><p>不能串稿</p>');
  const review = createReview('article.xml', xml);
  review.comments.push({ id: 'local-one', body: '补充实现依据', author: '我', createdAt: timestamp, status: 'open', replies: [],
    anchor: { from: 5, to: 7, quote: '原文', state: 'attached' } });
  await writeFile(sidecar, JSON.stringify(review));
  const remote: CloudSnapshot = { documentId: 'docA', xml, comments: [] };
  const calls: string[] = [];
  const transport: CloudTransport = {
    async read() { calls.push('read'); return structuredClone(remote); },
    async create(blockId, body) {
      calls.push('create');
      const id = 'comment-' + remote.comments.length;
      remote.comments.push({ id, blockId, body, author: '我', createdAt: timestamp, status: 'open', quote: '原文', replies: [] });
      return { id };
    },
    async reply() { throw new Error('unexpected reply'); },
    async resolve() { throw new Error('unexpected resolve'); },
  };
  const connection = { localPath: file, documentId: 'docA', url: 'https://example.feishu.cn/docx/docA', transport };
  const server = await createLocalServer(site, file, bound ? { cloud: connection } : {}); opened.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = await (await fetch(url + '/api/session')).json() as Session;
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf };
  const get = async (id = session.document.id) => await (await fetch(url + '/api/document?id=' + id)).json() as Snapshot;
  const post = (value: unknown, id = session.document.id, override = headers) => fetch(url + '/api/cloud-sync?id=' + id,
    { method: 'POST', headers: override, body: JSON.stringify(value) });
  const put = (snapshot: Snapshot, id = session.document.id, text = snapshot.xml) => fetch(url + '/api/document?id=' + id,
    { method: 'PUT', headers, body: JSON.stringify({ revision: snapshot.revision, xml: text,
      review: { ...(snapshot.review || createReview('other.xml', text)), document: { ...(snapshot.review || createReview('other.xml', text)).document, xml: text } } }) });
  return { server, url, file, sidecar, other, otherSidecar, session, headers, get, post, put, calls, remote, transport, connection };
}

describe('cloud comment sync over the real local HTTP service', () => {
  it('keeps an unconfigured session local and rejects sync without changing its files', async () => {
    const f = await fixture(false), before = await f.get(), savedReview = await readFile(f.sidecar, 'utf8');
    expect(f.session.cloud).toBeUndefined();
    const denied = await f.post({ revision: before.revision });
    expect(denied.status).toBe(403); expect((await denied.json()).code).toBe('CLOUD_BINDING');
    expect(f.calls).toEqual([]); expect(await readFile(f.file, 'utf8')).toBe(xml);
    expect(await readFile(f.sidecar, 'utf8')).toBe(savedReview);
  });

  it('binds only the configured file even after opening another document, and returns a durable local receipt', async () => {
    const f = await fixture(), before = await f.get();
    expect(f.session.cloud).toEqual({ url: f.connection.url, documentId: 'docA', localPath: f.file });
    expect(f.calls).toEqual([]);
    const otherText = await readFile(f.other, 'utf8');
    const opened = await fetch(f.url + '/api/open', { method: 'POST', headers: f.headers, body: JSON.stringify({ path: f.other }) });
    const handle = await opened.json() as DocumentHandle;
    const denied = await f.post({ revision: (await f.get(handle.id)).revision }, handle.id);
    expect(denied.status).toBe(403); expect((await denied.json()).code).toBe('CLOUD_BINDING');
    expect((await f.post({ revision: before.revision }, 'not-open')).status).toBe(404);
    expect(f.calls).toEqual([]);
    const synced = await f.post({ revision: before.revision });
    expect(synced.status).toBe(200);
    const result = await synced.json() as { snapshot: Snapshot; report: CloudSyncReport };
    expect(result.report.created).toBe(1); expect(result.report.issues).toEqual([]);
    expect(result.snapshot).toEqual(await f.get());
    expect(JSON.parse(await readFile(f.sidecar, 'utf8'))).toEqual(result.snapshot.review);
    expect(result.snapshot.review!.cloudSync!.links[0]).toMatchObject({ localId: 'local-one', cloudId: 'comment-0' });
    expect(f.remote.comments[0]).toMatchObject({ blockId: 'p1', body: '补充实现依据' });
    expect(await readFile(f.file, 'utf8')).toBe(xml); expect(await readFile(f.other, 'utf8')).toBe(otherText);
    await expect(readFile(f.otherSidecar)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts only revision in the POST body and never accepts a browser-supplied target or command', async () => {
    const f = await fixture(), before = await f.get(), reviewBytes = await readFile(f.sidecar);
    for (const extra of [{ url: 'https://elsewhere.invalid/doc' }, { documentId: 'other' }, { localPath: f.other },
      { command: '/bin/sh' }, { args: ['-c', 'anything'] }, { transport: {} }]) {
      const denied = await f.post({ revision: before.revision, ...extra });
      expect(denied.status).toBe(400); expect((await denied.json()).code).toBe('INVALID_REQUEST');
    }
    for (const value of [{}, { revision: 1 }, [], null]) expect((await f.post(value)).status).toBe(400);
    expect(f.calls).toEqual([]); expect(await readFile(f.sidecar)).toEqual(reviewBytes);
    expect(await readFile(f.file, 'utf8')).toBe(xml);
  });

  it('enforces the same-origin, content-type and CSRF boundary before contacting the transport', async () => {
    const f = await fixture(), before = await f.get();
    const route = f.url + '/api/cloud-sync?id=' + f.session.document.id;
    for (const headers of [{ 'Content-Type': 'application/json' }, { ...f.headers, 'X-CSRF-Token': 'wrong' },
      { ...f.headers, 'Content-Type': 'text/plain' }, { ...f.headers, Origin: 'https://elsewhere.invalid' },
      { ...f.headers, 'Sec-Fetch-Site': 'cross-site' }]) {
      const denied = await fetch(route, { method: 'POST', headers, body: JSON.stringify({ revision: before.revision }) });
      expect(denied.status).toBe(403);
    }
    const wrongHost = await new Promise<number>((done, fail) => {
      const request = httpRequest(route, { method: 'POST', headers: { ...f.headers, Host: 'elsewhere.invalid' } }, result => {
        result.resume(); done(result.statusCode!);
      });
      request.on('error', fail); request.end(JSON.stringify({ revision: before.revision }));
    });
    expect(wrongHost).toBe(403); expect((await fetch(route)).status).toBe(404); expect(f.calls).toEqual([]);
    const allowed = await fetch(route, { method: 'POST', headers: { ...f.headers, Origin: f.url }, body: JSON.stringify({ revision: before.revision }) });
    expect(allowed.status).toBe(200); expect(f.calls).toEqual(['read', 'create']);
  });

  it('rejects a stale local revision before reading the cloud and releases its sync lock', async () => {
    const f = await fixture(), before = await f.get(), bytes = await readFile(f.sidecar);
    const stale = await f.post({ revision: 'stale' });
    expect(stale.status).toBe(409); expect((await stale.json()).code).toBe('CONFLICT');
    expect(f.calls).toEqual([]); expect(await readFile(f.sidecar)).toEqual(bytes);
    expect((await f.post({ revision: before.revision })).status).toBe(200);
    expect(f.calls).toEqual(['read', 'create']);
  });

  it('rejects saving and duplicate sync during the cloud request while unrelated documents remain writable', async () => {
    const f = await fixture(), before = await f.get();
    const second = await (await fetch(f.url + '/api/open', { method: 'POST', headers: f.headers, body: JSON.stringify({ path: f.other }) })).json() as DocumentHandle;
    const otherBefore = await f.get(second.id);
    const entered = deferred<void>(), release = deferred<void>(), read = f.transport.read;
    f.transport.read = async () => { entered.resolve(); await release.promise; return read(); };
    const first = f.post({ revision: before.revision }); await entered.promise;
    try {
      const write = await f.put(before), duplicate = await f.post({ revision: before.revision });
      expect(write.status).toBe(409); expect((await write.json()).code).toBe('CLOUD_BUSY');
      expect(duplicate.status).toBe(409); expect((await duplicate.json()).code).toBe('CLOUD_BUSY');
      expect((await f.put(otherBefore, second.id, '<p>另一文件可独立编辑</p>')).status).toBe(200);
      expect(await readFile(f.file, 'utf8')).toBe(xml); expect(f.calls).toEqual([]);
    } finally { release.resolve(); await first; }
    expect(f.calls).toEqual(['read', 'create']);
    expect((await f.put(await f.get())).status).toBe(200);
  });

  it('rechecks a streamed PUT after its body arrives if synchronization started while the body was pending', async () => {
    const f = await fixture(), before = await f.get();
    const bodyStarted = deferred<void>(), entered = deferred<void>(), release = deferred<void>(), read = f.transport.read;
    f.transport.read = async () => { entered.resolve(); await release.promise; return read(); };
    // The server request listener runs after createLocalServer has reached its
    // await body(request), so this ordering does not depend on a timing sleep.
    f.server.once('request', request => { if (request.method === 'PUT') bodyStarted.resolve(); });
    const lateResponse = deferred<{ status: number; json: { code?: string } }>();
    const late = httpRequest(f.url + '/api/document?id=' + f.session.document.id, { method: 'PUT', headers: f.headers }, result => {
      let text = ''; result.setEncoding('utf8'); result.on('data', chunk => { text += chunk; });
      result.on('end', () => lateResponse.resolve({ status: result.statusCode!, json: JSON.parse(text) }));
    });
    late.on('error', () => lateResponse.resolve({ status: 0, json: {} }));
    const edited = '<title id="docA">测试</title><p id="p1">正在上传的改稿</p>';
    const payload = JSON.stringify({ revision: before.revision, xml: edited,
      review: { ...before.review!, document: { ...before.review!.document, xml: edited } } });
    late.write(payload.slice(0, 1)); await bodyStarted.promise;
    const syncing = f.post({ revision: before.revision }); await entered.promise;
    try {
      late.end(payload.slice(1));
      const result = await lateResponse.promise;
      expect(result.status).toBe(409); expect(result.json.code).toBe('CLOUD_BUSY');
      expect(await readFile(f.file, 'utf8')).toBe(xml);
    } finally { release.resolve(); await syncing; late.destroy(); }
  });

  it('releases busy state after a failed cloud read while preserving local bytes', async () => {
    const f = await fixture(), before = await f.get(), bytes = await readFile(f.sidecar), read = f.transport.read;
    f.transport.read = async () => { throw new Error('fake remote unavailable'); };
    const failed = await f.post({ revision: before.revision });
    expect(failed.status).toBe(502); expect((await failed.json()).code).toBe('CLOUD_READ');
    expect(await readFile(f.sidecar)).toEqual(bytes); expect(await readFile(f.file, 'utf8')).toBe(xml);
    expect(f.calls).toEqual([]);
    f.transport.read = read;
    expect((await f.post({ revision: before.revision })).status).toBe(200);
    expect(f.calls).toEqual(['read', 'create']);
  });
});
