import type { TFile, TFolder, Vault } from 'obsidian';
import { BrowserFileError, openBrowserDirectory, type BrowserDirectoryHandle, type BrowserDocument, type BrowserDocumentStore } from '../../src/browser/files';

// The browser store owns validation, paired revisions and the recovery journal.
// This adapter supplies only the file-handle operations that store uses, through
// Obsidian's public Vault API. In particular it does not use adapter/fs writes.
const writers = new WeakMap<Vault, Set<string>>();
const maximumFileBytes = 25_000_000;
const notFound = () => new DOMException('文件或目录已不存在。', 'NotFoundError');
const conflict = () => new BrowserFileError('文件已在另一处修改，未覆盖；当前输入仍保留。');

function relativePath(path: string): string {
  if (path === '' || path === '/') return '';
  if (path !== path.trim() || /[\\:\0-\x1f\x7f]/.test(path) || path.startsWith('/') || path.endsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new BrowserFileError('请选择当前 Obsidian 仓库中的目录。', 'INVALID_DIRECTORY', 400);
  }
  return path;
}

/** Open a directory already selected in this vault, without OS file access,
 * a local service, credential access or network requests. Paths are vault-relative. */
export async function openObsidianDirectory(vault: Vault, directory: string | TFolder = ''): Promise<BrowserDocumentStore> {
  const rootPath = relativePath(typeof directory === 'string' ? directory : directory.path);
  const reserved = new Map<string, symbol>();
  const activeWriters = writers.get(vault) || new Set<string>();
  writers.set(vault, activeWriters);
  const configPath = vault.configDir;
  let disposed = false;
  const active = () => { if (disposed) throw new BrowserFileError('此目录会话已关闭，请重新打开。', 'CLOSED', 410); };
  function safe(path: string) {
    relativePath(path);
    if (configPath && (path === configPath || path.startsWith(configPath + '/'))) {
      throw new BrowserFileError('插件不读取或修改 Obsidian 配置目录。', 'UNSAFE_RESOURCE', 403);
    }
    if (rootPath && path !== rootPath && !path.startsWith(rootPath + '/')) {
      throw new BrowserFileError('文件必须位于所选目录内。', 'UNSAFE_RESOURCE', 403);
    }
    return path;
  }
  function folder(path: string) {
    active(); safe(path);
    const entry = path ? vault.getFolderByPath(path) : vault.getRoot();
    if (!entry) throw notFound();
    return entry;
  }
  function child(parent: string, name: string) {
    if (!name || /[\\/:\0-\x1f\x7f]/.test(name) || name === '.' || name === '..') {
      throw new BrowserFileError('文件名或资源路径不安全。', 'UNSAFE_RESOURCE', 403);
    }
    return safe(parent ? `${parent}/${name}` : name);
  }
  folder(rootPath);

  function fileHandle(path: string, reservation?: symbol): FileSystemFileHandle {
    const name = path.split('/').at(-1)!;
    return {
      kind: 'file', name,
      async getFile() {
        active(); safe(path);
        const file = vault.getFileByPath(path);
        if (!file) {
          if (reservation && reserved.get(path) === reservation) return new File([], name);
          throw notFound();
        }
        if (file.stat.size > maximumFileBytes) throw new BrowserFileError('文件过大，未读取或覆盖。', 'TOO_LARGE', 413);
        const size = file.stat.size, mtime = file.stat.mtime;
        // readBinary reads the disk, not Obsidian's Markdown content cache. This
        // also preserves UTF-8 BOMs and CRLF for the shared parser/revision code.
        const content = await vault.readBinary(file);
        active();
        if (vault.getFileByPath(path) !== file || file.stat.size !== size || file.stat.mtime !== mtime) throw conflict();
        if (content.byteLength > maximumFileBytes) throw new BrowserFileError('文件过大，未读取或覆盖。', 'TOO_LARGE', 413);
        return new File([content], name, { lastModified: mtime });
      },
      async createWritable() {
        active(); safe(path);
        if (activeWriters.has(path)) throw new DOMException('另一视图正在保存此文件。', 'NoModificationAllowedError');
        activeWriters.add(path);
        try {
          const file = vault.getFileByPath(path);
          const creating = reservation !== undefined && reserved.get(path) === reservation;
          if (creating && vault.getAbstractFileByPath(path)) throw new BrowserFileError('同名文件刚刚被创建，未覆盖。', 'EXISTS');
          if (!creating && !file) throw notFound();
          const original = file ? await vault.read(file) : null;
          let buffered = '', closed = false;
          const ready = () => { active(); if (closed) throw new BrowserFileError('此写入已关闭。', 'CLOSED', 410); };
          return {
            async write(value: FileSystemWriteChunkType) {
              ready();
              if (typeof value !== 'string') throw new BrowserFileError('文档写入必须是 UTF-8 文本。', 'INVALID_REQUEST', 400);
              buffered = value;
            },
            async close() {
              ready();
              try {
                if (creating) {
                  if (reserved.get(path) !== reservation || vault.getAbstractFileByPath(path)) throw new BrowserFileError('同名文件刚刚被创建，未覆盖。', 'EXISTS');
                  // create fails if another writer creates this path. No empty
                  // physical file exists before close, so abort never deletes a
                  // real file or races an external writer's empty document.
                  try { await vault.create(path, buffered); }
                  catch (error) {
                    if (vault.getAbstractFileByPath(path)) throw new BrowserFileError('同名文件刚刚被创建，未覆盖。', 'EXISTS');
                    throw error;
                  }
                  reserved.delete(path);
                } else {
                  if (vault.getFileByPath(path) !== file) throw conflict();
                  await vault.process(file as TFile, current => {
                    if (vault.getFileByPath(path) !== file || current !== original) throw conflict();
                    return buffered;
                  });
                }
              } finally { closed = true; activeWriters.delete(path); }
            },
            async abort() {
              closed = true; activeWriters.delete(path);
              if (reservation && reserved.get(path) === reservation) reserved.delete(path);
            },
          } as FileSystemWritableFileStream;
        } catch (error) { activeWriters.delete(path); throw error; }
      },
    } as FileSystemFileHandle;
  }

  function directoryHandle(path: string): BrowserDirectoryHandle {
    return {
      kind: 'directory', name: path || vault.getName(),
      queryPermission: async () => { folder(path); return 'granted'; },
      requestPermission: async () => { folder(path); return 'granted'; },
      async *values() {
        const entry = folder(path);
        for (const item of entry.children) {
          active();
          if (item.path === configPath || item.path.startsWith(configPath + '/')) continue;
          yield { kind: vault.getFolderByPath(item.path) ? 'directory' : 'file', name: item.name } as FileSystemHandle;
        }
      },
      async getDirectoryHandle(name: string) {
        folder(path); const next = child(path, name); folder(next); return directoryHandle(next);
      },
      async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
        folder(path); const target = child(path, name);
        if (vault.getFileByPath(target)) {
          if (options?.create) throw new BrowserFileError('同名文件刚刚被创建，未覆盖。', 'EXISTS');
          return fileHandle(target);
        }
        if (vault.getAbstractFileByPath(target)) throw new DOMException('此路径不是文件。', 'TypeMismatchError');
        let reservation = reserved.get(target);
        if (!reservation && options?.create) { reservation = Symbol(target); reserved.set(target, reservation); }
        if (!reservation) throw notFound();
        return fileHandle(target, reservation);
      },
      async removeEntry(name: string) {
        folder(path);
        // Shared-store failure cleanup may remove only our virtual empty file.
        // Never call vault.delete(), including if a real empty file now exists.
        reserved.delete(child(path, name));
      },
    } as unknown as BrowserDirectoryHandle;
  }

  const store = await openBrowserDirectory(directoryHandle(rootPath));
  function exposed(document: BrowserDocument): BrowserDocument {
    document.handle.path = rootPath ? `${rootPath}/${document.handle.name}` : document.handle.name;
    document.handle.reviewPath = document.handle.path.replace(/\.xml$/i, '.review.json');
    return document;
  }
  return {
    directoryName: rootPath || vault.getName(),
    listDocuments: () => store.listDocuments(),
    open: async name => exposed(await store.open(name)),
    create: async (name, title) => exposed(await store.create(name, title)),
    dispose() { store.dispose(); disposed = true; reserved.clear(); },
  };
}
