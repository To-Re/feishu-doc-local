import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, link, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileError } from './files';
import { mergeProjectStores, openProjectStore, validateProjectRegistrations, type ProjectStore } from './projects';
import type { ReviewProject } from '../core/projects';

// Legacy shared fields remain on the API for older clients. `path` is always
// the effective catalog and is the source of the current directory shown in UI.
export interface ProjectSettingsState { shared: boolean; path: string; defaultSharedPath: string; sharedPath: string; hasSharedPath:boolean }
export interface ProjectSettings {
  store: ProjectStore;
  read(): Promise<ProjectSettingsState>;
  setShared(enabled: boolean, path?: string): Promise<ProjectSettingsState>;
}
const fail = (message: string, code = 'PROJECT_SETTINGS_CONFLICT', status = 409): never => { throw new FileError(message, code, status); };
interface SettingsDocument { shared: boolean; sharedPath?: string; localBaseline?: ReviewProject[] }
function parse(raw: string | null): SettingsDocument {
  if (raw === null) return {shared: false};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('项目设置不是合法 JSON，原文件未被覆盖。', 'PROJECT_SETTINGS_FORMAT', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'shared', 'sharedPath', 'localBaseline'].includes(key)) ||
    (value as {version?: unknown}).version !== 1 || typeof (value as {shared?: unknown}).shared !== 'boolean')
    return fail('项目设置格式不受支持，原文件未被覆盖。', 'PROJECT_SETTINGS_FORMAT', 400);
  const data = value as {shared: boolean; sharedPath?: unknown; localBaseline?: unknown};
  if (data.sharedPath !== undefined && (typeof data.sharedPath !== 'string' || !isAbsolute(data.sharedPath) || !/\.json$/i.test(data.sharedPath) || data.sharedPath.includes('\0')))
    return fail('项目配置需要绝对 JSON 文件路径。', 'INVALID_PATH', 400);
  return {shared: data.shared, ...(data.sharedPath === undefined ? {} : {sharedPath: data.sharedPath as string}), ...(data.localBaseline === undefined ? {} : {localBaseline: validateProjectRegistrations(data.localBaseline)})};
}

/** New installations use the user catalog. Existing instance catalogs/settings
 * retain their effective path until an explicit directory change. */
export async function openProjectSettings(options: { localPath: string; settingsPath: string; sharedPath: string; preferLocal?: boolean }): Promise<ProjectSettings> {
  const paths=[options.localPath,options.settingsPath,options.sharedPath];
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path) || !/\.json$/i.test(path) || path.includes('\0')) ||
    new Set(paths).size !== 3 || options.preferLocal!==undefined&&typeof options.preferLocal!=='boolean') return fail('项目设置需要三份独立的绝对 JSON 路径。', 'INVALID_PATH', 400);
  const settingsFolder = await realpath(dirname(options.settingsPath));
  const directory = await lstat(settingsFolder);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return fail('项目设置父路径必须是目录。', 'INVALID_PATH', 400);
  const settingsPath = join(settingsFolder, basename(options.settingsPath)), lockPath = settingsPath + '.lock';
  const localPath = join(await realpath(dirname(options.localPath)), basename(options.localPath));
  if (localPath === settingsPath) return fail('项目设置不能覆盖项目索引。', 'INVALID_PATH', 400);
  function selectedPath(input: string) {
    if (typeof input !== 'string' || !isAbsolute(input) || !/\.json$/i.test(input) || input.includes('\0'))
      return fail('项目配置需要绝对 JSON 文件路径。', 'INVALID_PATH', 400);
    const path = normalize(input);
    if ([localPath, settingsPath, normalize(options.localPath), normalize(options.settingsPath)].includes(path))
      return fail('所选配置不能覆盖本实例索引或设置文件。', 'INVALID_PATH', 400);
    return path;
  }
  async function resolveSelection(input: string, create: boolean, inspect: boolean): Promise<string> {
    const path = selectedPath(input);
    if (create) await mkdir(dirname(path), {recursive: true, mode: 0o700});
    let folder: string;
    try {
      const info = await lstat(dirname(path));
      if (!info.isDirectory() || info.isSymbolicLink()) return fail('项目配置目录不能是软链接。', 'UNSAFE_FILE');
      folder = await realpath(dirname(path));
    } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return path; throw error; }
    const canonical = selectedPath(join(folder, basename(path)));
    if (inspect) await openProjectStore(canonical);
    return canonical;
  }
  let existed = false;
  async function checkDirectory() {
    const current = await lstat(settingsFolder);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino || await realpath(settingsFolder) !== settingsFolder)
      return fail('项目设置目录已被替换，请重新打开。', 'PATH_CHANGED');
  }
  async function rawSettings(): Promise<string | null> {
    await checkDirectory();
    let handle;
    try {
      handle = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 2_100_000) return fail('项目设置必须为不超过 2.1 MB 的独立普通文件。', 'UNSAFE_FILE');
      const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(settingsPath);
      if (bytes.length > 2_100_000 || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1)
        return fail('项目设置读取期间已变化，请重新读取。');
      await checkDirectory();
      existed = true;
      try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
      catch { return fail('项目设置需要 UTF-8 编码。', 'PROJECT_SETTINGS_FORMAT', 400); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (existed) return fail('原项目设置已被删除，未重新创建覆盖。');
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return fail('项目设置不能是软链接。', 'UNSAFE_FILE');
      throw error;
    } finally { await handle?.close(); }
  }
  let observed = await rawSettings();
  let existingLocal=false;
  if(observed===null){
    try{await lstat(localPath);existingLocal=true;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  // Even an empty/invalid old index counts as existing: validate it in place,
  // rather than silently selecting a different catalog and losing its projects.
  const freshDefault=observed===null&&!existingLocal&&!options.preferLocal;
  let stored:SettingsDocument=observed===null?{shared:freshDefault}:parse(observed), shared=stored.shared;
  let chosen = selectedPath(stored.sharedPath ?? options.sharedPath);
  if (shared) chosen = await resolveSelection(chosen, freshDefault, true);
  let active = await openProjectStore(shared ? chosen : localPath);
  const state = (): ProjectSettingsState => ({shared, path: shared ? chosen : localPath, defaultSharedPath: options.sharedPath, sharedPath: chosen,hasSharedPath:stored.sharedPath!==undefined});
  async function refresh() {
    const raw = await rawSettings();
    if (raw !== observed) {
      const parsed = parse(raw), enabled = parsed.shared;
      const requested = selectedPath(parsed.sharedPath ?? options.sharedPath);
      const selection = enabled ? await resolveSelection(requested, false, true) : requested;
      const replacement = enabled === shared && (!enabled || selection === chosen) ? active : await openProjectStore(enabled ? selection : localPath);
      active = replacement; shared = enabled; chosen = selection; observed = raw; stored = parsed;
    }
  }
  async function locked<T>(action: (verifyLock: () => Promise<void>) => Promise<T>): Promise<T> {
    await checkDirectory();
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('项目配置正在被另一进程修改，或存在未清理的写入锁。', 'PROJECT_SETTINGS_BUSY'); throw error; }
    const info = await lock.stat();
    const verifyLock = async () => {
      await checkDirectory();
      const current = await lstat(lockPath);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) return fail('项目配置的写入锁已变化。');
    };
    try { return await action(verifyLock); }
    finally {
      await lock.close();
      try { const current = await lstat(lockPath); if (current.ino === info.ino && current.dev === info.dev) await unlink(lockPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async function writeSettings(enabled: boolean, selection: string, expected: string | null, verifyLock: () => Promise<void>, baseline?: ReviewProject[]) {
    const next = JSON.stringify({version: 1, shared: enabled, sharedPath: selection, ...(baseline ? {localBaseline: baseline} : {})}, null, 2) + '\n';
    if (Buffer.byteLength(next) > 2_100_000) return fail('项目设置快照超过大小限制，未切换。', 'TOO_LARGE', 413);
    const temporary = settingsPath + '.tmp-' + randomUUID();
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(next, 'utf8'); await file.sync(); } finally { await file.close(); }
      await verifyLock();
      if (await rawSettings() !== expected) return fail('项目配置在外部变化，未覆盖已有选择。');
      if (expected === null) { await link(temporary, settingsPath); await unlink(temporary); }
      else await rename(temporary, settingsPath);
      const parent = await open(settingsFolder, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      if (await rawSettings() !== next) return fail('项目设置在保存后已变化，请重新读取。');
      return next;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => { const next = queue.then(action, action); queue = next.catch(() => undefined); return next; };
  const use = <T>(action: (store: ProjectStore) => Promise<T>) => run(() => locked(async () => { await refresh(); return action(active); }));
  if(freshDefault)await locked(async verifyLock=>{
    // Persist the initial choice with the same CAS/lock as later switches. If
    // another instance already chose a location, use that committed choice.
    await refresh();
    if(observed===null){observed=await writeSettings(true,chosen,null,verifyLock);stored=parse(observed);}
  });
  const store: ProjectStore = {
    list: () => use(store => store.list()), get: id => use(store => store.get(id)),
    register: input => use(store => store.register(input)), update: (id, patch) => use(store => store.update(id, patch)),
  };
  return {
    store,
    read: () => run(() => locked(async () => { await refresh(); return state(); })),
    setShared: (enabled, path) => run(() => locked(async verifyLock => {
      if (typeof enabled !== 'boolean') return fail('项目配置参数不正确。', 'PROJECT_SETTINGS_FORMAT', 400);
      if (await rawSettings() !== observed) return fail('项目设置已在外部变化，请刷新后再切换。');
      let selection = path === undefined ? chosen : await resolveSelection(path, false, true);
      if (enabled === shared && selection === chosen) return state();
      if (!enabled && !shared) {
        observed = await writeSettings(false, selection, observed, verifyLock);
        stored = parse(observed); chosen = selection;
        return state();
      }
      if (enabled) selection = await resolveSelection(selection, true, true);
      const target = await openProjectStore(enabled ? selection : localPath);
      const sourceProjects = await active.list(); await target.list();
      let committed: string | undefined;
      await mergeProjectStores(active, target, async () => { committed = await writeSettings(enabled, selection, observed, verifyLock, enabled ? (shared ? stored.localBaseline : sourceProjects) : undefined); },
        enabled ? undefined : {targetBaseline: stored.localBaseline});
      // Switch the proxy only after settings reached disk successfully.
      observed = committed!; stored = parse(observed); shared = enabled; chosen = selection; active = target;
      return state();
    })),
  };
}
