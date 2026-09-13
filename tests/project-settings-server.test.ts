import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createLocalServer } from '../src/server/server';
import { openProjectSettings } from '../src/server/project-settings';
import type { ContentDocument, ContentTransport } from '../src/server/content-cli';

const folders: string[] = [], servers: Server[] = [];
async function close(server: Server) {
  const index = servers.indexOf(server); if (index >= 0) servers.splice(index, 1);
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
afterEach(async () => {
  for (const server of [...servers]) await close(server);
  for (const folder of folders.splice(0)) await rm(folder, {recursive: true, force: true});
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
async function fixture(preferLocal=true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-settings-http-'))); folders.push(root);
  const paths = {localPath: join(root, 'instance', 'projects.json'), settingsPath: join(root, 'instance', 'project-settings.json'), sharedPath: join(root, 'fake-home', '.lark-review', 'projects.json'),preferLocal};
  await mkdir(dirname(paths.localPath), {recursive: true});
  const site = join(root, 'site'); await mkdir(site); await writeFile(join(site, 'index.html'), '<main>Test</main>');
  const initialPath = join(root, 'initial.xml'); await writeFile(initialPath, '<title>初始本地稿</title><p id="p1">正文</p>');
  const custom = join(root, 'user-directory', 'projects.json');
  let remote: ContentDocument = {documentId: 'DocA', url: 'https://www.feishu.cn/docx/DocA', revision: 1, xml: '<title id="DocA">云端测试</title><p id="p1">云端正文</p>'};
  let gate: {entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>} | undefined;
  let commentGate: typeof gate;
  const transport: ContentTransport = {
    async fetch() { const wait = gate; if (wait) { wait.entered.resolve(); await wait.release.promise; } return structuredClone(remote); },
    async create() { throw new Error('unexpected cloud create'); },
    async update() { throw new Error('unexpected cloud write'); },
    async download() { throw new Error('unexpected resource'); },
  };
  async function boot() {
    const settings = await openProjectSettings(paths);
    const server = await createLocalServer(site, initialPath, {
      projectSettings: {...settings, defaultSharedPath: paths.sharedPath},
      projects: {store: settings.store, transport, historyRoot: join(root, 'history'), comments: project => project.cloud ? {
        ...project.cloud, localPath: project.localPath,
        transport: {
          async read() { const wait = commentGate; if (wait) { wait.entered.resolve(); await wait.release.promise; } return {documentId: remote.documentId, xml: remote.xml, comments: []}; },
          async create() { throw new Error('unexpected comment'); }, async reply() { throw new Error('unexpected reply'); }, async resolve() { throw new Error('unexpected resolution'); },
        },
      } : undefined},
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
    const request = async (path: string, init?: RequestInit) => { const response = await fetch(origin + path, init); return {status: response.status, data: await response.json()}; };
    const session = (await request('/api/session')).data;
    const post = (path: string, body: unknown) => request(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf}, body: JSON.stringify(body)});
    return {server, settings, origin, request, post, session};
  }
  return {root, paths, custom, initialPath, boot, setRemote(value: ContentDocument) { remote = value; }, remote: () => structuredClone(remote),
    pauseFetch() { gate = {entered: deferred(), release: deferred()}; return gate; }, unpauseFetch() { gate = undefined; },
    pauseComments() { commentGate = {entered: deferred(), release: deferred()}; return commentGate; }, unpauseComments() { commentGate = undefined; }};
}

describe('shared project registry over actual HTTP', () => {
  it('starts new installations in the user catalog and saves a new location without moving article files', async () => {
    const f=await fixture(false),client=await f.boot(),before=await readFile(f.initialPath,'utf8');
    const initial=(await client.request('/api/project-settings')).data;
    expect(initial).toMatchObject({shared:true,path:f.paths.sharedPath});
    expect(JSON.parse(await readFile(f.paths.sharedPath,'utf8')).projects[0].id).toBe(client.session.project.id);
    await expect(access(f.paths.localPath)).rejects.toMatchObject({code:'ENOENT'});
    const changed=await client.post('/api/project-settings',{shared:true,path:f.custom});
    expect(changed.status).toBe(200);expect(changed.data.settings.path).toBe(f.custom);
    expect(changed.data.session.project.id).toBe(client.session.project.id);expect(changed.data.session.document.path).toBe(f.initialPath);
    expect(await readFile(f.initialPath,'utf8')).toBe(before);
    await close(client.server);
    const restarted=await f.boot();expect((await restarted.request('/api/project-settings')).data.path).toBe(f.custom);
    expect((await restarted.request('/api/projects')).data.projects[0].id).toBe(client.session.project.id);
  });
  it('starts off, enables a custom registry, creates a project there, disables and reopens the same complete local catalog', async () => {
    const f = await fixture(), client = await f.boot();
    expect((await client.request('/api/project-settings')).data).toMatchObject({shared: false, path: f.paths.localPath, sharedPath: f.paths.sharedPath});
    await expect(access(dirname(f.paths.sharedPath))).rejects.toMatchObject({code: 'ENOENT'});
    const enabled = await client.post('/api/project-settings', {shared: true, path: f.custom});
    expect(enabled.status).toBe(200); expect(enabled.data.settings).toMatchObject({shared: true, path: f.custom, sharedPath: f.custom});
    expect(enabled.data.session.document.path).toBe(f.initialPath);
    const created = await client.post('/api/projects', {name: '共享新稿', local: {kind: 'new', path: join(f.root, 'new.xml')}, cloud: {kind: 'none'}, defaultDirection: 'pull'});
    expect(created.status).toBe(200); const createdId = created.data.session.project.id;
    expect(JSON.parse(await readFile(f.custom, 'utf8')).projects.some((project: {id: string}) => project.id === createdId)).toBe(true);
    const disabled = await client.post('/api/project-settings', {shared: false});
    expect(disabled.status).toBe(200); expect(disabled.data.settings).toMatchObject({shared: false, path: f.paths.localPath, sharedPath: f.custom});
    expect(disabled.data.session.project.id).toBe(createdId);
    expect(disabled.data.projects).toHaveLength(2);
    await close(client.server);
    const restarted = await f.boot(), listed = await restarted.request('/api/projects');
    expect(listed.data.projects.map((project: {id: string}) => project.id)).toContain(createdId);
    expect(listed.data.projects).toHaveLength(2);
    expect((await restarted.request('/api/project-settings')).data).toMatchObject({shared: false, sharedPath: f.custom});
    expect((await restarted.post('/api/projects/' + createdId + '/open', {})).data.snapshot.xml).toContain('共享新稿');
    await expect(access(dirname(f.paths.sharedPath))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('returns the destination project ID for an identical binding and updates the active session after switching', async () => {
    const f = await fixture(), client = await f.boot();
    const project = client.session.project, shared = {...project, id: 'plugin-project-id'};
    await mkdir(dirname(f.custom), {recursive: true}); await writeFile(f.custom, JSON.stringify({version: 1, projects: [shared]}));
    const enabled = await client.post('/api/project-settings', {shared: true, path: f.custom});
    expect(enabled.status).toBe(200); expect(enabled.data.session.project.id).toBe('plugin-project-id');
    expect(enabled.data.session.document.path).toBe(project.localPath);
    expect((await client.request('/api/session')).data.project.id).toBe('plugin-project-id');
    expect((await client.request('/api/projects')).data.projects).toHaveLength(1);
  });

  it('rejects cross-origin, missing CSRF and malformed settings input before changing catalogs', async () => {
    const f = await fixture(), client = await f.boot(), before = await readFile(f.paths.localPath, 'utf8');
    const input = JSON.stringify({shared: true, path: f.custom});
    const variants: Record<string, string>[] = [
      {'Content-Type': 'application/json'},
      {'Content-Type': 'application/json', 'X-CSRF-Token': client.session.csrf, Origin: 'https://evil.example'},
      {'Content-Type': 'text/plain', 'X-CSRF-Token': client.session.csrf},
    ];
    for (const headers of variants) expect((await client.request('/api/project-settings', {method: 'POST', headers, body: input})).status).toBe(403);
    for (const value of [{shared: 'true'}, {shared: true, path: 10}, {shared: true, extra: 'injected'}, [], null]) {
      expect((await client.post('/api/project-settings', value)).status).toBe(400);
    }
    for (const path of ['relative/projects.json', f.paths.localPath, f.paths.settingsPath]) expect((await client.post('/api/project-settings', {shared: true, path})).status).toBe(400);
    expect((await client.request('/api/project-settings')).data.shared).toBe(false);
    expect(await readFile(f.paths.localPath, 'utf8')).toBe(before);
    await expect(access(dirname(f.custom))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('leaves settings and both catalogs unchanged on a merge conflict', async () => {
    const f = await fixture(), client = await f.boot();
    await mkdir(dirname(f.custom), {recursive: true});
    const other = {...client.session.project, id: 'different', name: 'other client name'};
    await writeFile(f.custom, JSON.stringify({version: 1, projects: [other]}));
    const before = await Promise.all([readFile(f.custom, 'utf8'), readFile(f.paths.localPath, 'utf8')]);
    const result = await client.post('/api/project-settings', {shared: true, path: f.custom});
    expect(result.status).toBe(409); expect(result.data.code).toBe('PROJECT_CONFLICT');
    expect((await client.request('/api/project-settings')).data.shared).toBe(false);
    expect(await Promise.all([readFile(f.custom, 'utf8'), readFile(f.paths.localPath, 'utf8')])).toEqual(before);
  });

  it('does not commit a switch then report failure when the currently opened XML is outside the project registry', async () => {
    const f = await fixture(), client = await f.boot(), loose = join(f.root, 'unregistered.xml'); await writeFile(loose, '<title>独立稿件</title>');
    expect((await client.post('/api/open', {path: loose})).status).toBe(200);
    const result = await client.post('/api/project-settings', {shared: true, path: f.custom});
    expect(result.status).toBe(409);
    expect((await client.request('/api/project-settings')).data.shared).toBe(false);
    await expect(access(f.custom)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['content', 'comments'] as const)('refuses a management directory switch throughout active %s synchronization', async kind => {
    const f = await fixture(), client = await f.boot();
    const imported = await client.post('/api/projects', {name: '同步测试', local: {kind: 'new', path: join(f.root, 'cloud.xml')}, cloud: {kind: 'existing', url: 'https://www.feishu.cn/docx/DocA'}, defaultDirection: 'pull'});
    expect(imported.status).toBe(200);
    const session = imported.data.session, snapshot = imported.data.snapshot;
    let input: unknown, path: string;
    if (kind === 'content') {
      const remote = f.remote(); remote.xml += '<p id="added">云端新内容</p>'; remote.revision++; f.setRemote(remote);
      const preview = await client.post('/api/projects/' + session.project.id + '/preview', {revision: snapshot.revision, direction: 'pull'});
      expect(preview.status).toBe(200); expect(preview.data.status).toBe('ready');
      input = {previewId: preview.data.id}; path = '/api/projects/' + session.project.id + '/sync';
    } else { input = {revision: snapshot.revision}; path = '/api/cloud-sync?id=' + session.document.id; }
    const gate = kind === 'content' ? f.pauseFetch() : f.pauseComments();
    const syncing = client.post(path, input);
    try {
      await gate.entered.promise;
      const result = await client.post('/api/project-settings', {shared: true, path: f.custom});
      expect(result.status).toBe(409); expect(result.data.code).toBe('PROJECT_BUSY');
      expect((await client.request('/api/project-settings')).data.shared).toBe(false);
      await expect(access(f.custom)).rejects.toMatchObject({code: 'ENOENT'});
    } finally { gate.release.resolve(); if (kind === 'content') f.unpauseFetch(); else f.unpauseComments(); }
    expect((await syncing).status).toBe(200);
    expect((await client.post('/api/project-settings', {shared: true, path: f.custom})).status).toBe(200);
  });

  it('rechecks synchronization after its asynchronous current-project preflight', async () => {
    const f = await fixture(), client = await f.boot();
    const imported = await client.post('/api/projects', {name: '竞态测试', local: {kind: 'new', path: join(f.root, 'cloud.xml')}, cloud: {kind: 'existing', url: 'https://www.feishu.cn/docx/DocA'}, defaultDirection: 'pull'});
    const session = imported.data.session, snapshot = imported.data.snapshot;
    const remote = f.remote(); remote.xml += '<p id="new">新内容</p>'; remote.revision++; f.setRemote(remote);
    const preview = await client.post('/api/projects/' + session.project.id + '/preview', {revision: snapshot.revision, direction: 'pull'});
    const listEntered = deferred(), listRelease = deferred(), originalList = client.settings.store.list;
    let first = true;
    client.settings.store.list = async () => { if (first) { first = false; listEntered.resolve(); await listRelease.promise; } return originalList(); };
    const gate = f.pauseFetch();
    const switching = client.post('/api/project-settings', {shared: true, path: f.custom});
    let syncing: ReturnType<typeof client.post> | undefined;
    try {
      await listEntered.promise;
      syncing = client.post('/api/projects/' + session.project.id + '/sync', {previewId: preview.data.id});
      await gate.entered.promise;
      listRelease.resolve();
      const result = await switching;
      expect(result.status).toBe(409); expect(result.data.code).toBe('PROJECT_BUSY');
      expect((await client.request('/api/project-settings')).data.shared).toBe(false);
    } finally { client.settings.store.list = originalList; listRelease.resolve(); gate.release.resolve(); f.unpauseFetch(); await syncing; }
  });
});
