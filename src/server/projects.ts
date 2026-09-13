import { constants } from 'node:fs';
import { open, realpath, lstat, link, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectCloud, ReviewProject, SyncDirection } from '../core/projects';
import { FileError, openLocalFile } from './files';

export interface RegisterProjectInput {
  name: string; localPath: string; defaultDirection: SyncDirection; cloud?: ProjectCloud;
}
export interface UpdateProjectInput { name?: string; defaultDirection?: SyncDirection; cloud?: ProjectCloud; expectUnbound?: true; }
export interface ProjectStore {
  list(): Promise<ReviewProject[]>;
  get(id: string): Promise<ReviewProject | undefined>;
  register(input: RegisterProjectInput): Promise<ReviewProject>;
  update(id: string, patch: UpdateProjectInput): Promise<ReviewProject>;
}

interface Catalog { version: 1; projects: ReviewProject[]; }
interface CatalogAccess {
  path: string;
  run<T>(action: () => Promise<T>): Promise<T>;
  transaction<T>(action: (catalog: Catalog, save: () => Promise<void>, verify: () => Promise<void>) => Promise<T>): Promise<T>;
}
const catalogs = new WeakMap<ProjectStore, CatalogAccess>();
const LIMIT = 2_000_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
const exactKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const fail = (message: string, code = 'PROJECT_FORMAT', status = 400): never => { throw new FileError(message, code, status); };
const clone = <T>(value: T): T => structuredClone(value);

function projectName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    return fail('项目名称需要 1 至 200 个字符，不能包含控制字符。');
  return value.trim();
}
function direction(value: unknown): SyncDirection {
  if (value !== 'pull' && value !== 'push') return fail('默认同步方向必须为 pull 或 push。');
  return value;
}
function cloudTarget(value: unknown): ProjectCloud {
  if (!record(value) || !exactKeys(value, ['documentId', 'url']) || !identifier(value.documentId) || typeof value.url !== 'string')
    return fail('飞书关联需要明确的文档 ID 和基础 URL。');
  const raw = value.url.trim();
  let url: URL;
  try { url = new URL(raw); } catch { return fail('飞书文档 URL 无效。'); }
  const match = /^https:\/\/[A-Za-z0-9.-]+\/(docx|wiki)\/([A-Za-z0-9_-]{1,256})\/?$/.exec(raw);
  if (!match || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname))
    return fail('只支持不含查询参数或片段的飞书 Docx/Wiki HTTPS 基础 URL。');
  if (match[1] === 'docx' && match[2] !== value.documentId) return fail('Docx URL 与文档 ID 不一致。');
  // Wiki's URL token differs from its underlying Docx ID; the caller resolves it.
  return {documentId: value.documentId, url: url.href.replace(/\/$/, '')};
}
function canonicalStoredPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value && /\.xml$/i.test(value) && !value.includes('\0');
}
function validateCatalog(raw: string): Catalog {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('项目索引不是合法 JSON，原文件未被覆盖。'); }
  if (!record(value) || !exactKeys(value, ['version', 'projects']) || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > 10000)
    return fail('项目索引格式不受支持，原文件未被覆盖。');
  const ids = new Set<string>(), paths = new Set<string>(), documents = new Set<string>();
  const projects: ReviewProject[] = value.projects.map(item => {
    if (!record(item) || !exactKeys(item, ['id', 'name', 'localPath', 'defaultDirection', 'cloud', 'createdAt']) ||
      !identifier(item.id) || !canonicalStoredPath(item.localPath) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)))
      return fail('项目记录字段不正确，原文件未被覆盖。');
    const project: ReviewProject = {id: item.id, name: projectName(item.name), localPath: item.localPath,
      defaultDirection: direction(item.defaultDirection), createdAt: item.createdAt,
      ...(item.cloud !== undefined ? {cloud: cloudTarget(item.cloud)} : {})};
    if (ids.has(project.id) || paths.has(project.localPath) || (project.cloud && documents.has(project.cloud.documentId)))
      return fail('项目索引包含重复绑定，原文件未被覆盖。');
    ids.add(project.id); paths.add(project.localPath); if (project.cloud) documents.add(project.cloud.documentId);
    return project;
  });
  return {version: 1, projects};
}

/** Validate metadata snapshots without opening the referenced document files. */
export function validateProjectRegistrations(projects: unknown): ReviewProject[] {
  return validateCatalog(JSON.stringify({version: 1, projects})).projects;
}

/** A separate local index. It never stores document bodies, CLI argv or credentials. */
export async function openProjectStore(input: string): Promise<ProjectStore> {
  if (!isAbsolute(input) || !/\.json$/i.test(input) || input.includes('\0')) return fail('项目索引需要绝对 JSON 文件路径。', 'INVALID_PATH');
  let folder: string;
  try { folder = await realpath(dirname(input)); } catch { return fail('项目索引父目录不存在。', 'NOT_FOUND', 404); }
  const directory = await lstat(folder);
  if (!directory.isDirectory()) return fail('项目索引父路径不是目录。', 'INVALID_PATH');
  const path = join(folder, basename(input)), lockPath = path + '.lock';
  let observed: string | null = null, existed = false;

  async function checkDirectory() {
    try {
      const current = await lstat(folder);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino || await realpath(folder) !== folder)
        return fail('项目索引目录已被替换，请重新打开。', 'PATH_CHANGED', 409);
    } catch (error) {
      if (error instanceof FileError) throw error;
      return fail('项目索引目录已被移动或删除，请重新打开。', 'PATH_CHANGED', 409);
    }
  }
  async function readRaw(): Promise<string | null> {
    await checkDirectory();
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) return fail('项目索引必须是小于 2 MB 的独立普通文件。', 'UNSAFE_FILE', 409);
      const bytes = await handle.readFile();
      const after = await handle.stat(), entry = await lstat(path);
      await checkDirectory();
      if (bytes.length > LIMIT || entry.isSymbolicLink() || after.ino !== entry.ino || after.dev !== entry.dev ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1)
        return fail('项目索引读取期间被修改，请重试读取。', 'PROJECT_CONFLICT', 409);
      try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
      catch { return fail('项目索引必须使用 UTF-8 编码。'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (existed) return fail('原项目索引已被删除，未创建空索引覆盖。', 'PROJECT_CONFLICT', 409);
        return null;
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return fail('项目索引不能是软链接。', 'UNSAFE_FILE', 409);
      throw error;
    } finally { await handle?.close(); }
  }
  async function load(): Promise<Catalog> {
    const raw = await readRaw(), catalog = raw === null ? {version: 1 as const, projects: []} : validateCatalog(raw);
    observed = raw; existed ||= raw !== null;
    return catalog;
  }
  await load();

  async function transaction<T>(action: (catalog: Catalog, save: () => Promise<void>, verify: () => Promise<void>) => Promise<T>): Promise<T> {
    await checkDirectory();
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('项目索引正在被另一进程修改，或存在未清理的写入锁。', 'PROJECT_BUSY', 409);
      throw error;
    }
    const lockInfo = await lock.stat();
    try {
      let expected = observed;
      const raw = await readRaw();
      if (raw !== expected) return fail('项目索引已在外部变化，请先刷新项目列表。', 'PROJECT_CONFLICT', 409);
      const catalog: Catalog = raw === null ? {version: 1, projects: []} : validateCatalog(raw);
      const verify = async () => {
        await checkDirectory();
        const currentLock = await lstat(lockPath);
        if (currentLock.ino !== lockInfo.ino || currentLock.dev !== lockInfo.dev || currentLock.isSymbolicLink() || await readRaw() !== expected)
          return fail('项目索引或写入锁在保存期间变化，未覆盖。', 'PROJECT_CONFLICT', 409);
      };
      const save = async () => {
        const next = JSON.stringify(catalog, null, 2) + '\n';
        if (Buffer.byteLength(next) > LIMIT) return fail('项目索引超过 2 MB，未写入。', 'TOO_LARGE', 413);
        const temporary = path + '.tmp-' + randomUUID();
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(next, 'utf8'); await file.sync(); } finally { await file.close(); }
          await checkDirectory();
          const currentLock = await lstat(lockPath);
          if (currentLock.ino !== lockInfo.ino || currentLock.dev !== lockInfo.dev || currentLock.isSymbolicLink())
            return fail('项目写入锁已变化，未覆盖索引。', 'PROJECT_CONFLICT', 409);
          if (await readRaw() !== expected) return fail('项目索引在保存期间变化，未覆盖。', 'PROJECT_CONFLICT', 409);
          if (expected === null) { await link(temporary, path); await unlink(temporary); }
          else await rename(temporary, path);
          const parent = await open(folder, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
          const verified = await readRaw();
          if (verified !== next) return fail('项目索引在保存后变化，请重新读取。', 'PROJECT_CONFLICT', 409);
          observed = next; expected = next; existed = true;
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      };
      return clone(await action(catalog, save, verify));
    } finally {
      await lock.close();
      try { const current = await lstat(lockPath); if (current.dev === lockInfo.dev && current.ino === lockInfo.ino) await unlink(lockPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async function mutate<T>(change: (catalog: Catalog) => Promise<T>): Promise<T> {
    return transaction(async (catalog, save) => { const result = await change(catalog); await save(); return result; });
  }
  async function duplicate(catalog: Catalog, project: ReviewProject) {
    for (const other of catalog.projects) {
      if (other.id === project.id) continue;
      let canonical = other.localPath;
      try { canonical = await realpath(other.localPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (canonical === project.localPath) return fail('这份本地稿件已经属于另一个项目。', 'PROJECT_DUPLICATE', 409);
      if (canonical !== other.localPath) return fail('已有项目的稿件路径被替换，请先核对绑定。', 'PATH_CHANGED', 409);
    }
    if (project.cloud && catalog.projects.some(other => other.id !== project.id && other.cloud?.documentId === project.cloud!.documentId))
      return fail('这份飞书文档已经属于另一个项目。', 'PROJECT_DUPLICATE', 409);
  }
  async function validateLocal(pathInput: string) {
    if (!isAbsolute(pathInput) || !/\.xml$/i.test(pathInput) || pathInput.includes('\0'))
      return fail('请选择真实本地 XML 文件的绝对路径。', 'INVALID_PATH');
    let canonical: string;
    try { canonical = await realpath(pathInput); } catch { return fail('本地稿件不存在。', 'NOT_FOUND', 404); }
    const info = await lstat(canonical);
    if (!info.isFile() || info.nlink !== 1) return fail('本地稿件必须为独立普通 XML 文件。', 'UNSAFE_FILE', 409);
    const local = await openLocalFile(canonical, {readOnly: true});
    if (local.path !== canonical) return fail('稿件路径在校验期间发生变化。', 'PATH_CHANGED', 409);
    if (local.reviewPath === path) return fail('项目索引不能占用文章旁置评论文件。', 'INVALID_PATH');
    return local;
  }
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => { const next = queue.then(action, action); queue = next.catch(() => undefined); return next; };
  const store: ProjectStore = {
    list: () => run(async () => clone((await load()).projects)),
    get: id => run(async () => clone((await load()).projects.find(project => project.id === id))),
    register: input => run(() => mutate(async catalog => {
      if (!record(input) || !exactKeys(input, ['name', 'localPath', 'defaultDirection', 'cloud']) || typeof input.localPath !== 'string')
        return fail('项目注册参数不正确。');
      const name = projectName(input.name), defaultDirection = direction(input.defaultDirection);
      const cloud = input.cloud === undefined ? undefined : cloudTarget(input.cloud);
      const local = await validateLocal(input.localPath);
      const project: ReviewProject = {id: randomUUID(), name, localPath: local.path, defaultDirection, createdAt: new Date().toISOString(), ...(cloud ? {cloud} : {})};
      await duplicate(catalog, project);
      catalog.projects.push(project);
      return project;
    })),
    update: (id, patch) => run(() => mutate(async catalog => {
      if (!record(patch) || !exactKeys(patch, ['name', 'defaultDirection', 'cloud', 'expectUnbound']) || patch.expectUnbound !== undefined && patch.expectUnbound !== true) return fail('项目修改参数不正确。');
      const project = catalog.projects.find(project => project.id === id);
      if (!project) return fail('项目不存在。', 'NOT_FOUND', 404);
      if (patch.expectUnbound && project.cloud) return fail('这个项目已经关联飞书文档，不能重复关联或换绑。', 'CLOUD_BINDING', 409);
      if ((await validateLocal(project.localPath)).path !== project.localPath) return fail('项目稿件路径被替换，请先核对绑定。', 'PATH_CHANGED', 409);
      if (own(patch, 'name')) project.name = projectName(patch.name);
      if (own(patch, 'defaultDirection')) project.defaultDirection = direction(patch.defaultDirection);
      if (own(patch, 'cloud')) { if (patch.cloud === undefined) delete project.cloud; else project.cloud = cloudTarget(patch.cloud); }
      await duplicate(catalog, project);
      return project;
    })),
  };
  catalogs.set(store, {path, run, transaction});
  return store;
}

/** Merge registration metadata only, keeping both catalog locks until the caller commits its settings switch. */
export async function mergeProjectStores(source: ProjectStore, target: ProjectStore, commitSwitch: () => Promise<void>, options?: {targetBaseline?: ReviewProject[]}): Promise<ReviewProject[]> {
  const sourceAccess = catalogs.get(source), targetAccess = catalogs.get(target);
  if (!sourceAccess || !targetAccess || sourceAccess.path === targetAccess.path) return fail('项目合并需要两份独立受控索引。', 'INVALID_PATH');
  const ordered = [sourceAccess, targetAccess].sort((a, b) => a.path.localeCompare(b.path));
  return ordered[0].run(() => ordered[1].run(() => ordered[0].transaction(async (first, saveFirst, verifyFirst) =>
    ordered[1].transaction(async (second, saveSecond, verifySecond) => {
      const incoming = ordered[0] === sourceAccess ? first : second;
      const destination = ordered[0] === targetAccess ? first : second;
      const save = ordered[0] === targetAccess ? saveFirst : saveSecond;
      const merged = clone(destination.projects);
      const baseline = options?.targetBaseline === undefined ? undefined : validateProjectRegistrations(options.targetBaseline);
      for (const project of incoming.projects) {
        const sameId = merged.find(existing => existing.id === project.id);
        const samePath = merged.find(existing => existing.localPath === project.localPath);
        if (sameId && sameId.localPath !== project.localPath) return fail('项目 ID 在两份索引中指向不同稿件，未切换共享状态。', 'PROJECT_CONFLICT', 409);
        if (samePath) {
          if (samePath.cloud?.documentId !== project.cloud?.documentId || samePath.cloud?.url !== project.cloud?.url)
            return fail('同一稿件的飞书绑定存在冲突，未切换共享状态。', 'PROJECT_CONFLICT', 409);
          if (samePath.name !== project.name || samePath.defaultDirection !== project.defaultDirection) {
            const before = baseline?.find(item => item.id === samePath.id && item.localPath === samePath.localPath);
            if (!before || before.cloud?.documentId !== samePath.cloud?.documentId || before.cloud?.url !== samePath.cloud?.url)
              return fail('同一稿件的项目名称或方向存在冲突，未切换共享状态。', 'PROJECT_CONFLICT', 409);
            const unchanged = (value: ReviewProject) => value.name === before.name && value.defaultDirection === before.defaultDirection;
            if (unchanged(samePath)) { samePath.name = project.name; samePath.defaultDirection = project.defaultDirection; }
            else if (!unchanged(project)) return fail('本地和共享项目登记都已修改且内容不同，未切换共享状态。', 'PROJECT_CONFLICT', 409);
          }
          continue; // The destination's existing ID is canonical; no project is recreated.
        }
        if (project.cloud && merged.some(existing => existing.cloud?.documentId === project.cloud!.documentId))
          return fail('同一飞书文档绑定了不同本地稿件，未切换共享状态。', 'PROJECT_CONFLICT', 409);
        merged.push(clone(project));
      }
      const checked = validateCatalog(JSON.stringify({version: 1, projects: merged}));
      await verifyFirst(); await verifySecond();
      if (JSON.stringify(checked.projects) !== JSON.stringify(destination.projects)) { destination.projects = checked.projects; await save(); }
      await verifyFirst(); await verifySecond();
      await commitSwitch();
      return clone(destination.projects);
    }))));
}
