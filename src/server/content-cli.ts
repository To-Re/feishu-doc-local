import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { SaxesParser } from 'saxes';

export interface ContentDocument { documentId: string; url: string; xml: string; revision: number; referenceMap?: unknown }
export interface ContentCreateInput { title: string; contentPath: string; parentToken?: string }
export interface ContentUpdateInput {
  documentId: string; revision: number;
  command: 'overwrite' | 'block_replace' | 'block_delete' | 'block_insert_after' | 'append';
  contentPath?: string; blockId?: string; referenceMapPath?: string;
}
export interface ContentDownloadInput { token: string; type: 'media' | 'whiteboard'; outputPath: string }
export interface ContentTransport {
  fetch(ref: string): Promise<ContentDocument>;
  create(input: ContentCreateInput): Promise<{ documentId: string; url: string; warnings: string[]; receipt?: ContentCLIReceipt }>;
  update(input: ContentUpdateInput): Promise<void>;
  download(input: ContentDownloadInput): Promise<{ path: string }>;
}
export interface ContentCLIReceipt { readonly stdout: string; readonly stderr: string; readonly exitCode: number | string | null }
/** Raw receipts may contain private data. Callers may save receipt explicitly to private evidence, never serialize it into HTTP. */
export class ContentCLIError extends Error {
  declare readonly receipt?: ContentCLIReceipt;
  constructor(message: string, receipt?: ContentCLIReceipt) {
    super(message); this.name = 'ContentCLIError';
    Object.defineProperty(this, 'receipt', {value: receipt ? Object.freeze({stdout: receipt.stdout, stderr: receipt.stderr, exitCode: receipt.exitCode}) : undefined, enumerable: false, writable: false});
  }
}
export interface ContentCLIRunOptions {
  /** The validated body file's directory; never taken from document contents. */
  readonly cwd?: string;
}
export type ContentCLIRunner = (command: string, args: readonly string[], options?: ContentCLIRunOptions) => Promise<string | ContentCLIReceipt>;
type ObjectValue = Record<string, unknown>;
const MAX_BYTES = 16 * 1024 * 1024;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const invalid = (receipt?: ContentCLIReceipt) => new ContentCLIError('飞书 CLI 回执不完整或不匹配，未确认同步成功；请先回读核对。', receipt);
const failed = (receipt?: ContentCLIReceipt) => new ContentCLIError('飞书 CLI 执行未确认成功，请检查本机 CLI；写入请先回读确认，不要直接重试。', receipt);
function failureReceipt(error: unknown): ContentCLIReceipt | undefined {
  if (error instanceof ContentCLIError) return error.receipt;
  // A custom execFile runner may throw its native process error. Preserve only
  // its captured streams and exit status, never its argv-containing message.
  if (!object(error) || (typeof error.stdout !== 'string' && typeof error.stderr !== 'string')) return undefined;
  const code = error.exitCode ?? error.code;
  return {stdout: typeof error.stdout === 'string' ? error.stdout : '', stderr: typeof error.stderr === 'string' ? error.stderr : '',
    exitCode: typeof code === 'number' || typeof code === 'string' ? code : null};
}
const execute: ContentCLIRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], { shell: false, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES, windowsHide: true,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) },
    (error, stdout, stderr) => {
      const receipt: ContentCLIReceipt = {stdout, stderr, exitCode: error ? error.code ?? null : 0};
      if (error) reject(failed(receipt)); else resolve(receipt);
    });
});

function documentRef(input: string): { ref: string; expectedId?: string; origin?: string } {
  if (typeof input !== 'string') throw new Error('飞书文档地址无效。');
  const ref = input.trim();
  if (id(ref)) return { ref, expectedId: ref };
  let url: URL;
  try { url = new URL(ref); } catch { throw new Error('飞书文档地址无效。'); }
  const match = /^\/(docx|wiki)\/([A-Za-z0-9_-]{1,512})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname) || !match) throw new Error('需要飞书或 Lark 的 Docx / Wiki 文档地址。');
  return { ref: url.origin + '/' + match[1] + '/' + match[2], origin: url.origin, ...(match[1] === 'docx' ? { expectedId: match[2] } : {}) };
}

function documentURL(value: unknown, documentId: string, origin = 'https://www.feishu.cn', receipt?: ContentCLIReceipt): string {
  if (value === undefined || value === '') return origin + '/docx/' + documentId;
  if (typeof value !== 'string') throw invalid(receipt);
  let parsed: ReturnType<typeof documentRef>;
  try { parsed = documentRef(value); } catch { throw invalid(receipt); }
  if (parsed.expectedId !== documentId) throw invalid(receipt);
  return parsed.ref;
}

function validateXML(xml: string, receipt?: ContentCLIReceipt) {
  const parser = new SaxesParser({ fragment: true });
  let depth = 0;
  parser.on('error', () => { throw invalid(receipt); });
  parser.on('doctype', () => { throw invalid(receipt); });
  parser.on('opentag', () => { if (++depth > 256) throw invalid(receipt); });
  parser.on('closetag', () => { depth--; });
  parser.write(xml).close();
}

/** Stage beside the source; callers also set cwd because the CLI resolves relative media there first. Original files are never mutable inputs. */
async function privateInput<T>(path: string, kind: 'xml' | 'json', action: (path: string) => Promise<T>): Promise<T> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('正文和引用映射需要本地绝对路径。');
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content: string;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error('只支持 16 MB 以内的普通正文文件。');
    const bytes = await source.readFile();
    const after = await source.stat();
    if (bytes.length > MAX_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('读取期间本地正文已变化，请重新检查同步。');
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (kind === 'xml') validateXML(content);
    else { const value: unknown = JSON.parse(content); if (!object(value) || !Object.keys(value).length) throw new Error('引用映射需要非空 JSON 对象。'); }
  } finally { await source.close(); }
  const temporary = join(await realpath(dirname(path)), '.lark-review-upload-' + randomUUID() + '.' + kind);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content!); await file.sync(); await file.close();
    return await action(temporary);
  } finally { await file.close().catch(() => undefined); await rm(temporary, { force: true }); }
}

/** Only trusted server startup configuration determines the executable and its argument prefix. */
export function createContentCLI(profile: { command: string; args: string[] }, runner: ContentCLIRunner = execute): ContentTransport {
  if (!profile || typeof profile.command !== 'string' || !profile.command.trim() || profile.command.includes('\0') || !Array.isArray(profile.args) ||
    profile.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('本地飞书 CLI 启动配置无效。');
  const command = profile.command, prefix = [...profile.args];
  const receipts = new WeakMap<ObjectValue, ContentCLIReceipt>();
  const call = async (args: string[], cwd?: string): Promise<ObjectValue> => {
    let result: string | ContentCLIReceipt;
    try { result = await runner(command, [...prefix, ...args, '--format', 'json'], cwd === undefined ? undefined : { cwd }); }
    catch (error) { throw failed(failureReceipt(error)); }
    const receipt: ContentCLIReceipt = typeof result === 'string' ? {stdout: result, stderr: '', exitCode: 0} : result;
    if (!receipt || typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string') throw invalid();
    if (receipt.exitCode !== 0) throw failed(receipt);
    const output = receipt.stdout;
    if (Buffer.byteLength(output) > MAX_BYTES) throw invalid(receipt);
    let envelope: unknown;
    try { envelope = JSON.parse(output); } catch { throw invalid(receipt); }
    if (!object(envelope) || envelope.ok !== true || !object(envelope.data) || envelope.dry_run === true) throw invalid(receipt);
    const data = envelope.data;
    if (data.dry_run === true || data.complete === false || data.status === 'partial' || data.result === 'failed' || data.task !== undefined ||
      (object(data.context) && data.context.complete === false) ||
      (object(envelope.meta) && object(envelope.meta.pagination) && envelope.meta.pagination.complete === false)) throw invalid(receipt);
    receipts.set(data, receipt);
    return data;
  };
  return {
    async fetch(ref) {
      const parsed = documentRef(ref);
      const data = await call(['docs', '+fetch', '--doc', parsed.ref, '--doc-format', 'xml', '--detail', 'full', '--scope', 'full']);
      const doc = data.document;
      if (!object(doc) || !id(doc.document_id) || (parsed.expectedId && doc.document_id !== parsed.expectedId) ||
        typeof doc.content !== 'string' || !Number.isSafeInteger(doc.revision_id) || (doc.revision_id as number) < 1) throw invalid(receipts.get(data));
      validateXML(doc.content, receipts.get(data));
      if (doc.reference_map !== undefined && !object(doc.reference_map)) throw invalid(receipts.get(data));
      return { documentId: doc.document_id, url: documentURL(doc.url, doc.document_id, parsed.origin, receipts.get(data)), xml: doc.content,
        revision: doc.revision_id as number, ...(doc.reference_map !== undefined ? { referenceMap: doc.reference_map } : {}) };
    },
    async create(input) {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\0') || (input.parentToken !== undefined && !id(input.parentToken))) throw new Error('新建文档需要标题和有效父目录标识。');
      return privateInput(input.contentPath, 'xml', async path => {
        const data = await call(['docs', '+create', '--title', input.title, '--doc-format', 'xml', '--content', '@' + path,
          ...(input.parentToken ? ['--parent-token', input.parentToken] : [])], dirname(path));
        const doc = data.document;
        if (!object(doc) || !id(doc.document_id) || (data.result !== undefined && data.result !== 'success') || data.task_id) throw invalid(receipts.get(data));
        const warnings: string[] = [];
        if (Array.isArray(data.warnings) && data.warnings.length) warnings.push('飞书调整了部分格式，请通过正文预览核对回读结果。');
        if (object(data.permission_grant) && data.permission_grant.status !== 'granted') {
          warnings.push(data.permission_grant.status === 'failed'
            ? '文档已创建，但指定管理员权限尚未确认；请在飞书检查权限。'
            : '飞书文档已创建；当前账号访问权限未自动授予，请使用已授权文件夹或在飞书中设置访问权。');
        }
        // This result is consumed by the server's private evidence writer. Only
        // project metadata and the translated warnings may be sent to the UI.
        return { documentId: doc.document_id, url: documentURL(doc.url, doc.document_id, undefined, receipts.get(data)), warnings, receipt: receipts.get(data) };
      });
    },
    async update(input) {
      const blockOperation = ['block_replace', 'block_delete', 'block_insert_after'].includes(input.command);
      const blockIds = typeof input.blockId === 'string' ? input.blockId.split(',') : [];
      const validBlocks = blockIds.length > 0 && blockIds.every(id) && new Set(blockIds).size === blockIds.length &&
        (input.command !== 'block_insert_after' || blockIds.length === 1);
      if (!id(input.documentId) || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
        !['overwrite', 'block_replace', 'block_delete', 'block_insert_after', 'append'].includes(input.command) ||
        (blockOperation ? !validBlocks : input.blockId !== undefined) ||
        (input.command === 'block_delete' ? input.contentPath !== undefined || input.referenceMapPath !== undefined : !input.contentPath)) throw new Error('正文同步参数或版本无效，未写入飞书。');
      const perform = async (content?: string, reference?: string) => {
        const data = await call(['docs', '+update', '--doc', input.documentId, '--command', input.command, '--revision-id', String(input.revision), '--doc-format', 'xml',
          ...(input.blockId ? ['--block-id', input.blockId] : []), ...(content ? ['--content', '@' + content] : []), ...(reference ? ['--reference-map', '@' + reference] : [])], content ? dirname(content) : undefined);
        if (data.result !== 'success' || data.task_id || (object(data.document) && data.document.document_id !== undefined && data.document.document_id !== input.documentId)) throw invalid(receipts.get(data));
      };
      if (!input.contentPath) return perform();
      return privateInput(input.contentPath, 'xml', content => input.referenceMapPath ? privateInput(input.referenceMapPath, 'json', reference => perform(content, reference)) : perform(content));
    },
    async download(input) {
      if (!id(input.token) || !['media', 'whiteboard'].includes(input.type) || typeof input.outputPath !== 'string' || !isAbsolute(input.outputPath) || !extname(input.outputPath) || input.outputPath.includes('\0')) throw new Error('下载需要有效素材标识和带扩展名的本地绝对路径。');
      const destination = join(await realpath(dirname(input.outputPath)), basename(input.outputPath));
      try { await lstat(destination); throw new Error('目标资源已存在，未覆盖。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporary = await mkdtemp(join(dirname(destination), '.lark-review-download-'));
      try {
        const output = join(temporary, 'resource' + extname(destination));
        const data = await call(['docs', '+media-download', '--token', input.token, '--type', input.type, '--output', output]);
        if (typeof data.saved_path !== 'string' || resolve(data.saved_path) !== output || !Number.isSafeInteger(data.size_bytes) || (data.size_bytes as number) < 0 || typeof data.content_type !== 'string') throw invalid(receipts.get(data));
        const downloaded = await lstat(output);
        if (!downloaded.isFile() || downloaded.isSymbolicLink() || downloaded.nlink !== 1 || downloaded.size !== data.size_bytes) throw invalid(receipts.get(data));
        await chmod(output, 0o600);
        await link(output, destination); // Atomic no-replace, even if another writer created the destination meanwhile.
        return { path: destination };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    },
  };
}
