import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewProject } from '../src/core/projects';
import { openProjectSettings } from '../src/server/project-settings';
import { mergeProjectStores, openProjectStore } from '../src/server/projects';

const faults = vi.hoisted(() => ({failPath: '', afterPath: '', after: undefined as undefined | (() => Promise<void>)}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const move = (operation: typeof fs.rename) => async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (String(to) === faults.failPath) throw Object.assign(new Error('simulated settings write failure'), {code: 'ENOSPC'});
    await operation(from, to);
    if (String(to) === faults.afterPath && faults.after) { const action = faults.after; faults.after = undefined; await action(); }
  };
  return {...fs, rename: move(fs.rename), link: move(fs.link)};
});
const folders: string[] = [];
afterEach(async () => {
  faults.failPath = ''; faults.afterPath = ''; faults.after = undefined;
  for (const folder of folders.splice(0)) await rm(folder, {recursive: true, force: true});
});
async function fixture(preferLocal=true) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'project-settings-'))); folders.push(folder);
  const localFolder = join(folder, 'instance', '.local'); await mkdir(localFolder, {recursive: true});
  const paths = {localPath: join(localFolder, 'projects.json'), settingsPath: join(localFolder, 'project-settings.json'), sharedPath: join(folder, 'fake-home', '.lark-review', 'projects.json'),preferLocal};
  const project = (id: string, extra: Partial<ReviewProject> = {}): ReviewProject => ({id, name: id, localPath: join(folder, id + '.xml'), defaultDirection: 'pull', createdAt: '2026-09-12T00:00:00.000Z', ...extra});
  return {folder, paths, project};
}
async function catalog(path: string, projects: ReviewProject[]) { await mkdir(dirname(path), {recursive: true}); await writeFile(path, JSON.stringify({version: 1, projects}), {mode: 0o600}); }
async function registered(path: string): Promise<ReviewProject[]> { return JSON.parse(await readFile(path, 'utf8')).projects; }

describe('project catalog location settings', () => {
  it('honors an explicit instance-local startup path without inspecting the default user folder', async () => {
    const t = await fixture(), settings = await openProjectSettings(t.paths);
    expect(await settings.read()).toMatchObject({shared: false, path: t.paths.localPath});
    expect((await settings.read()).hasSharedPath).toBe(false);
    expect(await settings.store.list()).toEqual([]);
    expect(await settings.setShared(false)).toMatchObject({shared: false, path: t.paths.localPath});
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readdir(dirname(t.paths.localPath))).toEqual([]);
  });

  it('defaults a new installation to the user directory and durably remembers the effective location', async () => {
    const t=await fixture(false),settings=await openProjectSettings(t.paths);
    expect(await settings.read()).toMatchObject({shared:true,path:t.paths.sharedPath,sharedPath:t.paths.sharedPath,hasSharedPath:true});
    expect(await settings.store.list()).toEqual([]);
    expect(JSON.parse(await readFile(t.paths.settingsPath,'utf8'))).toMatchObject({version:1,shared:true,sharedPath:t.paths.sharedPath});
    expect((await stat(dirname(t.paths.sharedPath))).mode&0o777).toBe(0o700);
    await expect(access(t.paths.localPath)).rejects.toMatchObject({code:'ENOENT'});
    // The remembered user location wins over an unrelated old index appearing
    // later, rather than re-running first-install inference at every startup.
    await catalog(t.paths.localPath,[t.project('legacy-added-later')]);
    expect(await (await openProjectSettings(t.paths)).read()).toMatchObject({shared:true,path:t.paths.sharedPath});
    expect(await (await openProjectSettings(t.paths)).store.list()).toEqual([]);
  });

  it('uses an existing user catalog on a fresh installation without rewriting it or opening article files', async () => {
    const t=await fixture(false),project=t.project('from-other-client');await catalog(t.paths.sharedPath,[project]);
    const before=await readFile(t.paths.sharedPath,'utf8'),settings=await openProjectSettings(t.paths);
    expect(await settings.store.list()).toEqual([project]);expect((await settings.read()).path).toBe(t.paths.sharedPath);
    expect(await readFile(t.paths.sharedPath,'utf8')).toBe(before);await expect(access(project.localPath)).rejects.toMatchObject({code:'ENOENT'});
    await expect(access(t.paths.localPath)).rejects.toMatchObject({code:'ENOENT'});
  });

  it('retains an existing legacy instance catalog when there is no settings file', async () => {
    const t=await fixture(false),project=t.project('legacy');await catalog(t.paths.localPath,[project]);
    const before=await readFile(t.paths.localPath,'utf8'),settings=await openProjectSettings(t.paths);
    expect(await settings.read()).toMatchObject({shared:false,path:t.paths.localPath});expect(await settings.store.list()).toEqual([project]);
    expect(await readFile(t.paths.localPath,'utf8')).toBe(before);
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code:'ENOENT'});
    await expect(access(t.paths.settingsPath)).rejects.toMatchObject({code:'ENOENT'});
  });

  it('respects legacy disabled settings even when its local catalog has not been created yet', async () => {
    const t=await fixture(false),raw='{"version":1,"shared":false}';await writeFile(t.paths.settingsPath,raw);
    const settings=await openProjectSettings(t.paths);expect((await settings.read()).path).toBe(t.paths.localPath);
    expect(await settings.store.list()).toEqual([]);expect(await readFile(t.paths.settingsPath,'utf8')).toBe(raw);
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('validates a malformed legacy catalog in place instead of silently moving to an empty user catalog', async () => {
    const t=await fixture(false),raw='not a registry';await writeFile(t.paths.localPath,raw);
    await expect(openProjectSettings(t.paths)).rejects.toMatchObject({code:'PROJECT_FORMAT'});
    expect(await readFile(t.paths.localPath,'utf8')).toBe(raw);
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('merges only registrations, retains IDs, and carries external shared additions back when disabled', async () => {
    const t = await fixture(), local = t.project('local'), shared = t.project('shared'), external = t.project('external');
    await catalog(t.paths.localPath, [local]); await catalog(t.paths.sharedPath, [shared]);
    const settings = await openProjectSettings(t.paths);
    expect(await settings.setShared(true)).toMatchObject({shared: true, path: t.paths.sharedPath});
    expect((await settings.store.list()).map(p => p.id)).toEqual(['shared', 'local']);
    // None of these XML files exist: migrating the registry never opens bodies or creates sidecars.
    await catalog(t.paths.sharedPath, [shared, local, external]);
    expect((await settings.store.list()).map(p => p.id)).toEqual(['shared', 'local', 'external']);
    expect(await settings.setShared(false)).toMatchObject({shared: false, path: t.paths.localPath});
    expect((await settings.store.list()).map(p => p.id)).toEqual(['local', 'shared', 'external']);
    expect(await (await openProjectSettings(t.paths)).read()).toMatchObject({shared: false, path: t.paths.localPath});
    for (const project of [local, shared, external]) await expect(access(project.localPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect((await stat(t.paths.settingsPath)).mode & 0o777).toBe(0o600);
  });

  it('uses the destination existing ID for the same binding instead of recreating a project', async () => {
    const t = await fixture(), local = t.project('local'), shared = {...local, id: 'shared', createdAt: '2026-09-11T00:00:00.000Z'};
    await catalog(t.paths.localPath, [local]); await catalog(t.paths.sharedPath, [shared]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    expect(await settings.store.list()).toEqual([shared]); expect(await settings.store.get(local.id)).toBeUndefined();
    expect(await registered(t.paths.localPath)).toEqual([local]);
  });

  it.each(['id', 'cloud', 'binding', 'name'] as const)('refuses conflicting %s registrations and preserves both original catalogs', async kind => {
    const t = await fixture(), cloud = {documentId: 'doc1', url: 'https://example.feishu.cn/docx/doc1'};
    const local = t.project('local', {cloud});
    const shared = kind === 'id' ? {...local, localPath: t.project('other').localPath}
      : kind === 'cloud' ? t.project('other', {cloud})
      : kind === 'binding' ? {...local, id: 'other', cloud: {documentId: 'doc2', url: 'https://example.feishu.cn/docx/doc2'}}
      : {...local, id: 'other', name: 'shared rename'};
    await catalog(t.paths.localPath, [local]); await catalog(t.paths.sharedPath, [shared]);
    const before = await Promise.all([readFile(t.paths.localPath, 'utf8'), readFile(t.paths.sharedPath, 'utf8')]);
    const settings = await openProjectSettings(t.paths);
    await expect(settings.setShared(true)).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect(await settings.read()).toMatchObject({shared: false, path: t.paths.localPath});
    expect(await Promise.all([readFile(t.paths.localPath, 'utf8'), readFile(t.paths.sharedPath, 'utf8')])).toEqual(before);
    await expect(access(t.paths.settingsPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not duplicate or rewrite catalogs on repeated toggles to the current state', async () => {
    const t = await fixture(); await catalog(t.paths.localPath, [t.project('local')]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const before = await Promise.all([readFile(t.paths.settingsPath, 'utf8'), readFile(t.paths.sharedPath, 'utf8')]);
    await Promise.all([settings.setShared(true), settings.setShared(true)]);
    expect(await Promise.all([readFile(t.paths.settingsPath, 'utf8'), readFile(t.paths.sharedPath, 'utf8')])).toEqual(before);
    expect(await settings.store.list()).toHaveLength(1);
  });

  it('keeps the old effective store if committing the settings file fails after target merge', async () => {
    const t = await fixture(), local = t.project('local'), shared = t.project('shared');
    await catalog(t.paths.localPath, [local]); await catalog(t.paths.sharedPath, [shared]);
    await writeFile(t.paths.settingsPath, '{"version":1,"shared":false}');
    const settings = await openProjectSettings(t.paths);
    faults.failPath = t.paths.settingsPath;
    await expect(settings.setShared(true)).rejects.toMatchObject({code: 'ENOSPC'});
    expect(await settings.read()).toMatchObject({shared: false, path: t.paths.localPath});
    expect(await settings.store.list()).toEqual([local]);
    expect(await registered(t.paths.sharedPath)).toEqual([shared, local]);
    faults.failPath = ''; await settings.setShared(true);
    expect(await settings.store.list()).toEqual([shared, local]);
    expect((await readdir(dirname(t.paths.settingsPath))).some(name => name.endsWith('.lock') || name.includes('.tmp-'))).toBe(false);
  });

  it('detects an external settings CAS change and adopts it only on explicit read', async () => {
    const t = await fixture(); await catalog(t.paths.localPath, [t.project('local')]);
    const a = await openProjectSettings(t.paths), b = await openProjectSettings(t.paths);
    await a.setShared(true);
    await expect(b.setShared(false)).rejects.toMatchObject({code: 'PROJECT_SETTINGS_CONFLICT'});
    expect(await b.read()).toMatchObject({shared: true, path: t.paths.sharedPath});
    await b.setShared(false);
    expect(await a.read()).toMatchObject({shared: false, path: t.paths.localPath});
    expect(await a.store.list()).toHaveLength(1);
  });

  it('serializes same-instance changes and rejects a simultaneously locked settings writer', async () => {
    const t = await fixture(); await catalog(t.paths.localPath, [t.project('local')]);
    const settings = await openProjectSettings(t.paths);
    await Promise.all([settings.setShared(true), settings.setShared(false), settings.setShared(true)]);
    expect((await settings.read()).shared).toBe(true); expect(await settings.store.list()).toHaveLength(1);
    await writeFile(t.paths.settingsPath + '.lock', 'other process');
    await expect(settings.setShared(false)).rejects.toMatchObject({code: 'PROJECT_SETTINGS_BUSY'});
    expect(await readFile(t.paths.settingsPath + '.lock', 'utf8')).toBe('other process');
  });

  it('detects a source edit during target merge, preserves it, and safely merges it on the next attempt', async () => {
    const t = await fixture(), local = t.project('local'), external = t.project('external');
    await catalog(t.paths.localPath, [local]);
    const settings = await openProjectSettings(t.paths);
    faults.afterPath = t.paths.sharedPath;
    faults.after = () => catalog(t.paths.localPath, [local, external]);
    await expect(settings.setShared(true)).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect((await settings.read()).shared).toBe(false);
    expect(await registered(t.paths.localPath)).toEqual([local, external]);
    await expect(access(t.paths.settingsPath)).rejects.toMatchObject({code: 'ENOENT'});
    await settings.setShared(true); expect(await settings.store.list()).toEqual([local, external]);
  });

  it('does not overwrite an external target edit during atomic merge', async () => {
    const t = await fixture(), local = t.project('local'), external = t.project('external');
    await catalog(t.paths.localPath, [local]);
    const settings = await openProjectSettings(t.paths);
    faults.afterPath = t.paths.sharedPath;
    faults.after = () => catalog(t.paths.sharedPath, [local, external]);
    await expect(settings.setShared(true)).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect(await registered(t.paths.sharedPath)).toEqual([local, external]);
    expect((await settings.read()).shared).toBe(false);
  });

  it('follows a shared rename and direction change on disable when the local registration is still at its baseline', async () => {
    const t = await fixture(), local = t.project('local'); await catalog(t.paths.localPath, [local]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const edited = {...local, name: 'shared renamed', defaultDirection: 'push' as const};
    await catalog(t.paths.sharedPath, [edited]);
    await settings.setShared(false);
    expect(await settings.store.list()).toEqual([edited]);
    expect(JSON.parse(await readFile(t.paths.settingsPath, 'utf8'))).toMatchObject({version: 1, shared: false});
  });

  it('refuses disable when local and shared registrations diverged independently', async () => {
    const t = await fixture(), local = t.project('local'); await catalog(t.paths.localPath, [local]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const sharedEdit = {...local, name: 'shared edit'}, localEdit = {...local, name: 'local edit'};
    await catalog(t.paths.sharedPath, [sharedEdit]); await catalog(t.paths.localPath, [localEdit]);
    await expect(settings.setShared(false)).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect((await settings.read()).shared).toBe(true);
    expect(await registered(t.paths.localPath)).toEqual([localEdit]); expect(await settings.store.list()).toEqual([sharedEdit]);
  });

  it('keeps an independent local metadata edit when shared metadata is unchanged, but never auto-merges a binding change', async () => {
    const t = await fixture(), local = t.project('local'); await catalog(t.paths.localPath, [local]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const edited = {...local, name: 'local edit'}; await catalog(t.paths.localPath, [edited]);
    await settings.setShared(false); expect(await settings.store.list()).toEqual([edited]);
    // A fresh fixture is unnecessary: make both sides agree first, then change the cloud binding only while enabled.
    await catalog(t.paths.sharedPath, [edited]); await settings.setShared(true);
    const rebound = {...edited, cloud: {documentId: 'doc2', url: 'https://example.feishu.cn/docx/doc2'}};
    await catalog(t.paths.sharedPath, [rebound]);
    await expect(settings.setShared(false)).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
    expect(await registered(t.paths.localPath)).toEqual([edited]);
  });

  it('rejects unsafe or malformed settings without modifying the local project registry', async () => {
    const t = await fixture(), local = t.project('local'); await catalog(t.paths.localPath, [local]);
    for (const raw of ['{broken', '{"version":1,"shared":"yes"}', '{"version":1,"shared":true,"localBaseline":[{"token":"do-not-store"}]}']) {
      await writeFile(t.paths.settingsPath, raw);
      await expect(openProjectSettings(t.paths)).rejects.toBeDefined();
      expect(await readFile(t.paths.settingsPath, 'utf8')).toBe(raw);
    }
    await rm(t.paths.settingsPath); const real = join(t.folder, 'real.json'); await writeFile(real, '{"version":1,"shared":false}');
    await symlink(real, t.paths.settingsPath); await expect(openProjectSettings(t.paths)).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    await rm(t.paths.settingsPath); await link(real, t.paths.settingsPath); await expect(openProjectSettings(t.paths)).rejects.toMatchObject({code: 'UNSAFE_FILE'});
    expect(await registered(t.paths.localPath)).toEqual([local]);
  });

  it('holds both catalog locks through switch commit and never alters the source', async () => {
    const t = await fixture(), local = t.project('local'); await catalog(t.paths.localPath, [local]); await mkdir(dirname(t.paths.sharedPath), {recursive: true});
    const source = await openProjectStore(t.paths.localPath), target = await openProjectStore(t.paths.sharedPath);
    await mergeProjectStores(source, target, async () => {
      await access(t.paths.localPath + '.lock'); await access(t.paths.sharedPath + '.lock');
      expect(await registered(t.paths.localPath)).toEqual([local]); expect(await registered(t.paths.sharedPath)).toEqual([local]);
    });
    await expect(access(t.paths.localPath + '.lock')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(access(t.paths.sharedPath + '.lock')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('remembers a custom directory while off without creating it, and only creates that directory on enable', async () => {
    const t = await fixture(), custom = join(t.folder, 'user-selected', 'projects.json');
    const settings = await openProjectSettings(t.paths);
    expect(await settings.setShared(false, custom)).toEqual({shared: false, path: t.paths.localPath, sharedPath: custom, defaultSharedPath: t.paths.sharedPath, hasSharedPath: true});
    await expect(access(dirname(custom))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code: 'ENOENT'});
    const reopened = await openProjectSettings(t.paths);
    expect((await reopened.read()).sharedPath).toBe(custom);
    await reopened.setShared(true); expect((await reopened.read()).path).toBe(custom);
    expect((await stat(dirname(custom))).mode & 0o777).toBe(0o700);
    await expect(access(dirname(t.paths.sharedPath))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('merges custom existing indexes and preserves local baseline when switching between shared directories', async () => {
    const t = await fixture(), local = t.project('local'), remote = t.project('remote'), custom = join(t.folder, 'custom', 'index.json');
    await catalog(t.paths.localPath, [local]); await catalog(custom, [remote]);
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const edited = {...local, name: 'updated while shared'}; await catalog(t.paths.sharedPath, [edited]);
    await settings.setShared(true, custom);
    expect(await settings.store.list()).toEqual([remote, edited]);
    await settings.setShared(false); expect(await settings.store.list()).toEqual([edited, remote]);
    expect((await settings.read()).sharedPath).toBe(custom);
  });

  it('rejects custom settings/index collisions, relative paths, and malformed existing catalogs', async () => {
    const t = await fixture(), settings = await openProjectSettings(t.paths), bad = join(t.folder, 'bad.json');
    const bytes = '{"article":"not a project registry"}'; await writeFile(bad, bytes);
    for (const path of [t.paths.localPath, t.paths.settingsPath, '../projects.json', join(t.folder, 'not-xml.txt'), bad]) {
      await expect(settings.setShared(false, path)).rejects.toBeDefined();
      expect((await settings.read()).sharedPath).toBe(t.paths.sharedPath);
    }
    expect(await readFile(bad, 'utf8')).toBe(bytes);
    await expect(access(t.paths.settingsPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('keeps the existing custom path if saving a different disabled preference fails', async () => {
    const t = await fixture(), settings = await openProjectSettings(t.paths), first = join(t.folder, 'first', 'projects.json'), second = join(t.folder, 'second', 'projects.json');
    await settings.setShared(false, first); faults.failPath = t.paths.settingsPath;
    await expect(settings.setShared(false, second)).rejects.toMatchObject({code: 'ENOSPC'});
    expect((await settings.read()).sharedPath).toBe(first);
    await expect(access(dirname(second))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('routes register and get through the currently selected store after switching', async () => {
    const t = await fixture(), path = join(t.folder, 'real.xml'); await writeFile(path, '<title>可读稿件</title><p>正文</p>');
    const settings = await openProjectSettings(t.paths); await settings.setShared(true);
    const project = await settings.store.register({name: '新项目', localPath: path, defaultDirection: 'pull'});
    expect(await settings.store.get(project.id)).toEqual(project);
    expect(await registered(t.paths.sharedPath)).toEqual([project]);
    await expect(access(t.paths.localPath)).rejects.toMatchObject({code: 'ENOENT'});
    await settings.setShared(false); expect(await settings.store.get(project.id)).toEqual(project);
    await expect(access(path.replace('.xml', '.review.json'))).rejects.toMatchObject({code: 'ENOENT'});
  });
});
