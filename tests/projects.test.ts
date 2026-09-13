import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, rename, symlink, link, stat, access, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { openProjectStore } from '../src/server/projects';
import { createReview } from '../src/core/types';
import { openLocalFile } from '../src/server/files';

const folders: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const folder of folders.splice(0)) await rm(folder, {recursive: true, force: true});
});
const xml = '<title id="docA">测试</title><p>不进入项目索引的正文 secret-body-marker</p>';
async function setup() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'review-projects-'))); folders.push(folder);
  const source = join(folder, 'article.xml'), index = join(folder, 'projects.json');
  await writeFile(source, xml);
  return {folder, source, index, store: await openProjectStore(index)};
}
const registration = (localPath: string, documentId?: string) => ({name: '项目一', localPath, defaultDirection: 'pull' as const,
  ...(documentId ? {cloud: {documentId, url: `https://example.feishu.cn/docx/${documentId}`}} : {})});

describe('project index persistence and validation', () => {
  it('creates the index lazily, persists metadata only and survives reopening', async () => {
    const t = await setup();
    expect(await t.store.list()).toEqual([]); await expect(access(t.index)).rejects.toMatchObject({code: 'ENOENT'});
    const project = await t.store.register(registration(t.source, 'docA'));
    expect(project).toMatchObject({name: '项目一', localPath: t.source, defaultDirection: 'pull'});
    expect(Number.isFinite(Date.parse(project.createdAt))).toBe(true);
    const serialized = await readFile(t.index, 'utf8');
    expect(serialized).not.toContain('secret-body-marker'); expect(serialized).not.toContain('cli');
    expect((await stat(t.index)).mode & 0o777).toBe(0o600);
    const reopened = await openProjectStore(t.index);
    expect(await reopened.get(project.id)).toEqual(project); expect(await reopened.get('missing')).toBeUndefined();
    project.name = '调用者修改返回值';
    expect((await reopened.list())[0].name).toBe('项目一');
    expect(await readFile(t.source, 'utf8')).toBe(xml);
    await expect(access(t.source.replace('.xml', '.review.json'))).rejects.toMatchObject({code: 'ENOENT'});
    expect((await readdir(t.folder)).sort()).toEqual(['article.xml', 'projects.json']);
  });

  it('updates only allowed project metadata and rejects duplicate local/cloud bindings', async () => {
    const t = await setup(), second = join(t.folder, 'second.xml'); await writeFile(second, xml);
    const first = await t.store.register(registration(t.source, 'docA'));
    const alias = join(t.folder, 'alias.xml'); await symlink(t.source, alias);
    await expect(t.store.register(registration(alias))).rejects.toMatchObject({code: 'PROJECT_DUPLICATE'});
    await expect(t.store.register(registration(second, 'docA'))).rejects.toMatchObject({code: 'PROJECT_DUPLICATE'});
    const other = await t.store.register(registration(second, 'docB'));
    await expect(t.store.update(other.id, {cloud: {documentId: 'docA', url: 'https://example.feishu.cn/docx/docA'}})).rejects.toMatchObject({code: 'PROJECT_DUPLICATE'});
    const updated = await t.store.update(first.id, {name: '已改名', defaultDirection: 'push', cloud: {documentId: 'docC', url: 'https://example.feishu.cn/wiki/wikiC'}});
    expect(updated).toMatchObject({id: first.id, name: '已改名', defaultDirection: 'push', createdAt: first.createdAt, cloud: {documentId: 'docC'}});
    await expect(t.store.update('missing', {name: '无目标'})).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(t.store.update(first.id, {localPath: second} as never)).rejects.toMatchObject({code: 'PROJECT_FORMAT'});
  });

  it.each([
    'https://example.feishu.cn/docx/other', 'https://example.feishu.cn/docx/docA?from=secret',
    'https://example.feishu.cn/docx/docA#block', 'https://example.feishu.cn:443/docx/docA',
    'https://example.feishu.cn@evil.test/docx/docA', 'https://example.feishu.cn.evil.test/docx/docA',
    'http://example.feishu.cn/docx/docA', 'https://example.feishu.cn/other/../docx/docA',
    'https://example.feishu.cn/docx/docA%2Fchild', 'https://example.feishu.cn/sheets/docA',
  ])('rejects a nonexact or mismatched cloud URL: %s', async url => {
    const t = await setup();
    await expect(t.store.register({...registration(t.source), cloud: {documentId: 'docA', url}})).rejects.toMatchObject({code: 'PROJECT_FORMAT'});
    expect(await t.store.list()).toEqual([]); await expect(access(t.index)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects extra payloads, relative/missing/non-XML files, hard links and invalid XML without changing data', async () => {
    const t = await setup();
    await expect(t.store.register({...registration(t.source), cli: {token: 'do-not-store'}} as never)).rejects.toMatchObject({code: 'PROJECT_FORMAT'});
    for (const source of ['article.xml', '../escape.xml', join(t.folder, 'missing.xml'), join(t.folder, 'text.txt')])
      await expect(t.store.register(registration(source))).rejects.toBeDefined();
    const invalid = join(t.folder, 'invalid.xml'); await writeFile(invalid, '<p>broken');
    await expect(t.store.register(registration(invalid))).rejects.toMatchObject({code: 'INVALID_XML'});
    const hard = join(t.folder, 'hard.xml'); await link(t.source, hard);
    await expect(t.store.register(registration(hard))).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    expect(await readFile(t.source, 'utf8')).toBe(xml); await expect(access(t.index)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not occupy an article sidecar path or recover pending document writes during registration', async () => {
    const t = await setup(), sidecar = t.source.replace('.xml', '.review.json');
    const collision = await openProjectStore(sidecar);
    await expect(collision.register(registration(t.source))).rejects.toMatchObject({code: 'INVALID_PATH'});
    await expect(access(sidecar)).rejects.toMatchObject({code: 'ENOENT'});
    const afterXML = '<title id="docA">尚未提交的新正文</title>', review = createReview(basename(t.source), xml);
    review.document.xml = afterXML;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const raw = JSON.stringify({...review, pendingWrite: {id: 'pending', beforeXML: xml, beforeHash: hash(xml), afterHash: hash(afterXML), startedAt: new Date().toISOString()}});
    await writeFile(sidecar, raw);
    await expect(t.store.register(registration(t.source))).rejects.toMatchObject({code: 'RECOVERY_REQUIRED'});
    expect(await readFile(t.source, 'utf8')).toBe(xml); expect(await readFile(sidecar, 'utf8')).toBe(raw);
    await expect(access(t.index)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects FIFO source, sidecar and index paths without blocking', async () => {
    const t = await setup(), fifo = join(t.folder, 'pipe.xml'), sidecar = t.source.replace('.xml', '.review.json');
    execFileSync('mkfifo', [fifo]);
    await expect(t.store.register(registration(fifo))).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    await expect(openLocalFile(fifo, {readOnly: true})).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    execFileSync('mkfifo', [sidecar]);
    await expect(t.store.register(registration(t.source))).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    execFileSync('mkfifo', [t.index]);
    await expect(openProjectStore(t.index)).rejects.toMatchObject({code: 'UNSAFE_FILE'});
  });
});

describe('project index concurrency and external modification', () => {
  it('serializes same-store registration and rejects duplicates across independently opened stores', async () => {
    const t = await setup(), second = join(t.folder, 'second.xml'); await writeFile(second, xml);
    await Promise.all([t.store.register(registration(t.source)), t.store.register(registration(second))]);
    expect(await t.store.list()).toHaveLength(2);
    const a = await openProjectStore(t.index), b = await openProjectStore(t.index);
    const aid = (await a.list())[0].id, bid = (await b.list())[1].id;
    const attempts = await Promise.allSettled([a.update(aid, {name: '来自A'}), b.update(bid, {name: '来自B'})]);
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(await (await openProjectStore(t.index)).list()).toHaveLength(2);
    expect((await readdir(t.folder)).some(name => name.includes('.tmp-') || name.endsWith('.lock'))).toBe(false);
  });

  it('honors a lock held by a different process and never steals it', async () => {
    const t = await setup(), lock = t.index + '.lock';
    const script = `import {open,unlink} from 'node:fs/promises'; const p=process.argv[1]; const f=await open(p,'wx',0o600); process.stdout.write('locked'); for await (const x of process.stdin) break; await f.close(); await unlink(p);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], {stdio: ['pipe', 'pipe', 'pipe']}); children.push(child);
    await once(child.stdout!, 'data');
    await expect(t.store.register(registration(t.source))).rejects.toMatchObject({code: 'PROJECT_BUSY'});
    await access(lock); child.stdin!.end('release'); await once(child, 'exit');
    expect((await t.store.register(registration(t.source))).localPath).toBe(t.source);
  });

  it('preserves a valid external edit until it is explicitly re-read, and never overwrites a malformed index', async () => {
    const t = await setup(), project = await t.store.register(registration(t.source));
    const external = JSON.parse(await readFile(t.index, 'utf8')); external.projects[0].name = '外部编辑';
    const raw = JSON.stringify(external); await writeFile(t.index, raw);
    await expect(t.store.update(project.id, {defaultDirection: 'push'})).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect(await readFile(t.index, 'utf8')).toBe(raw);
    expect((await t.store.list())[0].name).toBe('外部编辑');
    expect((await t.store.update(project.id, {defaultDirection: 'push'})).name).toBe('外部编辑');
    await writeFile(t.index, '{broken');
    await expect(t.store.list()).rejects.toMatchObject({code: 'PROJECT_FORMAT'});
    await expect(t.store.update(project.id, {name: '不应写入'})).rejects.toBeDefined();
    await expect(openProjectStore(t.index)).rejects.toMatchObject({code: 'PROJECT_FORMAT'});
    expect(await readFile(t.index, 'utf8')).toBe('{broken');
  });

  it('rejects deletion of the opened index and replacement of its parent directory', async () => {
    const t = await setup(), project = await t.store.register(registration(t.source));
    await rm(t.index);
    await expect(t.store.update(project.id, {name: '不应重建'})).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    await expect(access(t.index)).rejects.toMatchObject({code: 'ENOENT'});
    const catalogDir = join(t.folder, 'catalog'); await mkdir(catalogDir);
    const catalogPath = join(catalogDir, 'index.json'), store = await openProjectStore(catalogPath);
    await rename(catalogDir, catalogDir + '-old'); await mkdir(catalogDir);
    const replacement = '{"owner":"external"}'; await writeFile(catalogPath, replacement);
    await expect(store.list()).rejects.toMatchObject({code: 'PATH_CHANGED'});
    await expect(store.register(registration(t.source))).rejects.toMatchObject({code: 'PATH_CHANGED'});
    expect(await readFile(catalogPath, 'utf8')).toBe(replacement);
  });

  it('does not rebind a registered source through a later symlink replacement', async () => {
    const t = await setup(), project = await t.store.register(registration(t.source));
    const replacement = join(t.folder, 'replacement.xml'); await writeFile(replacement, xml);
    await rm(t.source); await symlink(replacement, t.source);
    const before = await readFile(t.index, 'utf8');
    await expect(t.store.register(registration(replacement))).rejects.toMatchObject({code: 'PROJECT_DUPLICATE'});
    await expect(t.store.update(project.id, {name: '不应换绑'})).rejects.toMatchObject({code: 'PATH_CHANGED'});
    expect(await readFile(t.index, 'utf8')).toBe(before);
  });

  it('rejects symlink/hardlink indexes and a missing index parent without creating directories', async () => {
    const t = await setup(); await t.store.register(registration(t.source));
    const alias = join(t.folder, 'alias.json'); await symlink(t.index, alias);
    await expect(openProjectStore(alias)).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    const hard = join(t.folder, 'hard.json'); await link(t.index, hard);
    await expect(openProjectStore(hard)).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    await expect(openProjectStore(join(t.folder, 'missing', 'index.json'))).rejects.toMatchObject({code: 'NOT_FOUND'});
    await expect(access(join(t.folder, 'missing'))).rejects.toMatchObject({code: 'ENOENT'});
  });
});
