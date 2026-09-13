import { execFile } from 'node:child_process';
import { SaxesParser } from 'saxes';
import type { CloudCLIOptions, CloudComment, CloudReply, CloudSnapshot, CloudTransport } from '../core/cloud-types';

type ObjectValue = Record<string, unknown>;
export type CloudCLIRunner = (command: string, args: readonly string[]) => Promise<string>;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_PAGES = 200;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const invalid = () => new Error('飞书 CLI 返回的数据不完整或格式不正确，未应用本次同步。');

/** The command is configured at startup, never by document or browser input. */
const execute: CloudCLIRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { shell: false, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout) => {
    // execFile errors include argv and stderr. Neither belongs in HTTP responses or logs.
    if (error) reject(new Error('飞书 CLI 执行未确认成功，请检查本机 CLI 状态；写入操作请先回读确认，不要直接重试。'));
    else resolve(stdout);
  });
});

function timestamp(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) throw invalid();
  return date.toISOString();
}

function replyBody(value: unknown): string {
  if (!object(value) || !Array.isArray(value.elements)) throw invalid();
  return value.elements.map(element => {
    if (!object(element) || typeof element.type !== 'string') throw invalid();
    if (element.type === 'text_run') {
      if (!object(element.text_run) || typeof element.text_run.text !== 'string') throw invalid();
      return element.text_run.text;
    }
    if (element.type === 'docs_link') {
      if (!object(element.docs_link) || typeof element.docs_link.url !== 'string') throw invalid();
      return element.docs_link.url;
    }
    if (element.type === 'person') {
      if (!object(element.person) || typeof element.person.user_id !== 'string') throw invalid();
      return '@' + element.person.user_id;
    }
    // Preserve unsupported rich content in raw; the readable body never pretends it is empty.
    return `[${element.type}]`;
  }).join('');
}

function normalizeReply(value: unknown): CloudReply {
  if (!object(value) || !id(value.reply_id)) throw invalid();
  return { id: value.reply_id, body: replyBody(value.content), author: text(value.user_id), createdAt: timestamp(value.create_time), raw: value };
}

interface DocumentData { id: string; xml: string; blocks: Set<string>; boards: Map<string, Set<string>>; comments: Map<string, Set<string>>; }
function parseDocument(value: unknown, expectedId: string): DocumentData {
  if (!object(value) || value.document_id !== expectedId || typeof value.content !== 'string' || value.content.length > MAX_OUTPUT) throw invalid();
  const blocks = new Set<string>(), boards = new Map<string, Set<string>>(), comments = new Map<string, Set<string>>(), commentRefs = new Map<string, Set<string>>();
  const stack: Array<{ block?: string; protected: boolean }> = [];
  const parser = new SaxesParser({ fragment: true });
  const add = (map: Map<string, Set<string>>, key: string, block: string) => { if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(block); };
  parser.on('error', () => { throw invalid(); });
  parser.on('doctype', () => { throw invalid(); });
  parser.on('opentag', node => {
    if (stack.length > 256) throw invalid();
    const parent = stack.at(-1), attrs = node.attributes as Record<string, string>;
    let block = parent?.block;
    if (!parent?.protected && attrs.id) {
      if (!id(attrs.id) || blocks.has(attrs.id)) throw invalid();
      block = attrs.id; blocks.add(block);
      if (node.name === 'whiteboard') for (const key of ['token', 'src']) if (attrs[key]) add(boards, attrs[key], block);
    }
    if (!parent?.protected && block && attrs['comment-refs']) {
      for (const ref of attrs['comment-refs'].split(/[ ,]+/).filter(Boolean)) add(commentRefs, ref, block);
    }
    stack.push({ block, protected: !!parent?.protected || node.name === 'whiteboard' });
  });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(value.content).close();
  // c1 is an export-local reference, not a Drive comment ID. Only the explicit
  // comment-id in the official reference-map XML may connect it to API results.
  const referenceComments = object(value.reference_map) && object(value.reference_map.comments) ? value.reference_map.comments : {};
  for (const [ref, entry] of Object.entries(referenceComments)) {
    if (!object(entry) || typeof entry.data !== 'string') throw invalid();
    const reference = new SaxesParser({ fragment: true });
    reference.on('error', () => { throw invalid(); });
    reference.on('doctype', () => { throw invalid(); });
    reference.on('opentag', node => {
      if (node.name !== 'comment') return;
      const attrs = node.attributes as Record<string, string>, commentId = attrs['comment-id'];
      if (!id(commentId)) throw invalid();
      if (blocks.has(attrs['block-id'])) add(comments, commentId, attrs['block-id']);
      for (const block of commentRefs.get(ref) || []) add(comments, commentId, block);
    });
    reference.write(entry.data).close();
  }
  return { id: expectedId, xml: value.content, blocks, boards, comments };
}

function commentLocation(comment: ObjectValue, document: DocumentData): Pick<CloudComment, 'blockId'|'boardToken'|'whole'> {
  if (typeof comment.is_whole !== 'boolean') throw invalid();
  if (comment.is_whole) return { whole: true };
  const candidates = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && document.blocks.has(value)) candidates.add(value); };
  const relation = comment.relation;
  if (object(relation) && relation.content_deleted === true) return { whole: false };
  if (object(comment.anchor)) add(comment.anchor.block_id);
  if (object(relation) && relation.relation !== undefined && relation.relation !== null && relation.relation !== '') {
    let value: unknown = relation.relation;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw invalid(); } }
    const walk = (part: unknown, depth: number) => {
      if (depth > 64) throw invalid();
      if (Array.isArray(part)) for (const child of part) walk(child, depth + 1);
      else if (object(part)) {
        if (object(part.positionInfo)) add(part.positionInfo.blockID);
        for (const child of Object.values(part)) if (object(child) || Array.isArray(child)) walk(child, depth + 1);
      }
    };
    walk(value, 0);
  }
  for (const block of document.comments.get(text(comment.comment_id)) || []) add(block);
  const boardToken = comment.parent_type === 'WHITEBOARD_BLOCK' ? text(comment.parent_token) : '';
  if (boardToken) for (const block of document.boards.get(boardToken) || []) add(block);
  if (comment.parent_type === 'DOCX_BLOCK') add(comment.parent_token);
  return { whole: false, ...(boardToken ? { boardToken } : {}), ...(candidates.size === 1 ? { blockId: [...candidates][0] } : {}) };
}

/** Official CLI argv and output only. No dependency on a particular installed implementation. */
export function createCloudCLI(options: CloudCLIOptions, runner: CloudCLIRunner = execute): CloudTransport {
  if (!options.command.trim() || options.command.includes('\0') || !Array.isArray(options.args) ||
    options.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !id(options.documentId))
    throw new Error('本地飞书 CLI 启动配置无效。');
  const command = options.command, prefix = [...options.args], documentId = options.documentId;
  const call = async (args: string[]): Promise<ObjectValue> => {
    let output: string;
    try { output = await runner(command, [...prefix, ...args, '--format', 'json']); }
    catch { throw new Error('飞书 CLI 执行未确认成功，请检查本机 CLI 状态；写入操作请先回读确认，不要直接重试。'); }
    if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT) throw invalid();
    let envelope: unknown;
    try { envelope = JSON.parse(output); } catch { throw invalid(); }
    if (!object(envelope) || envelope.ok !== true || envelope.dry_run === true || !object(envelope.data)) throw invalid();
    const data = envelope.data;
    if (data.status === 'partial' || data.complete === false || data.comments_complete === false || data.replies_complete === false ||
      (object(data.context) && data.context.complete === false) ||
      (object(envelope.meta) && object(envelope.meta.pagination) && envelope.meta.pagination.complete === false)) throw invalid();
    return data;
  };
  const fetchDocument = async () => parseDocument((await call(['docs', '+fetch', '--doc', documentId, '--doc-format', 'xml', '--detail', 'full', '--scope', 'full'])).document, documentId);
  const pages = async (args: string[], expectedComment?: string): Promise<ObjectValue[]> => {
    const items: ObjectValue[] = [], seenTokens = new Set<string>(), seenIds = new Set<string>();
    let token = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call([...args, '--token', documentId, '--type', 'docx', '--page-size', '100', ...(token ? ['--page-token', token] : [])]);
      if (data.file_token !== documentId || data.file_type !== 'docx' || (expectedComment && data.comment_id !== expectedComment) ||
        !Array.isArray(data.items) || typeof data.has_more !== 'boolean' || typeof data.page_token !== 'string') throw invalid();
      for (const item of data.items) {
        const itemId = object(item) ? item[expectedComment ? 'reply_id' : 'comment_id'] : undefined;
        if (!object(item) || !id(itemId) || seenIds.has(itemId)) throw invalid();
        seenIds.add(itemId); items.push(item);
      }
      if (!data.has_more) return items;
      token = data.page_token;
      if (!token.trim() || token.length > 8192 || seenTokens.has(token)) throw invalid();
      seenTokens.add(token);
    }
    throw new Error('飞书评论分页超过本地读取上限，未应用不完整的结果。');
  };
  const bodyArgument = (body: string): string => {
    if (typeof body !== 'string' || !body.trim() || [...body].length > 10_000) throw new Error('评论需要 1 至 10000 个字符。');
    return JSON.stringify([{ type: 'text', text: body }]);
  };
  const requireId = (value: string) => { if (!id(value)) throw new Error('飞书评论或块标识无效。'); };
  return {
    async read(): Promise<CloudSnapshot> {
      const document = await fetchDocument();
      const raw = new Map<string, ObjectValue>();
      for (const scope of ['whole', 'partial']) for (const solved of ['false', 'true']) {
        const items = await pages(['drive', '+list-comments', '--comment-scope', scope, '--solved-status', solved, '--need-relation']);
        for (const item of items) {
          // Repeated IDs across disjoint filters mean the read raced with a cloud change.
          if (raw.has(item.comment_id as string) || item.is_whole !== (scope === 'whole') || item.is_solved !== (solved === 'true')) throw invalid();
          raw.set(item.comment_id as string, item);
        }
      }
      const comments: CloudComment[] = [];
      for (const [commentId, comment] of raw) {
        const values = await pages(['drive', '+list-replies', '--comment-id', commentId], commentId);
        if (!values.length) throw invalid();
        const replies = values.map(normalizeReply), first = replies[0];
        comments.push({ id: commentId, body: first.body, author: text(comment.user_id) || first.author,
          createdAt: timestamp(comment.create_time) || first.createdAt, status: comment.is_solved ? 'resolved' : 'open',
          quote: text(comment.quote), ...commentLocation(comment, document), replies: replies.slice(1),
          raw: { ...comment, reply_list: { ...(object(comment.reply_list) ? comment.reply_list : {}), replies: values }, has_more: false, page_token: '' } });
      }
      const finalDocument = await fetchDocument();
      if (finalDocument.xml !== document.xml) throw new Error('读取评论期间云端正文已变化，未应用本次同步，请重新读取。');
      return { documentId, xml: document.xml, comments };
    },
    async create(blockId, body) {
      const content = bodyArgument(body);
      if (blockId !== undefined) requireId(blockId);
      const document = await fetchDocument();
      if (blockId !== undefined && !document.blocks.has(blockId)) throw new Error('云端文档中已找不到这个块，未发送评论。');
      const result = await call(['drive', '+add-comment', '--doc', documentId, '--type', 'docx', ...(blockId ? ['--block-id', blockId] : ['--full-comment']), '--content', content]);
      if (!id(result.comment_id) || (result.file_token !== undefined && result.file_token !== documentId)) throw invalid();
      return { id: result.comment_id };
    },
    async reply(commentId, body) {
      requireId(commentId); const content = bodyArgument(body);
      const result = await call(['drive', '+add-reply', '--token', documentId, '--type', 'docx', '--comment-id', commentId, '--content', content]);
      if (!id(result.reply_id) || (result.file_token !== undefined && result.file_token !== documentId) || (result.comment_id !== undefined && result.comment_id !== commentId)) throw invalid();
      return { id: result.reply_id };
    },
    async resolve(commentId, solved) {
      requireId(commentId);
      if (typeof solved !== 'boolean') throw new Error('评论状态无效。');
      const result = await call(['drive', solved ? '+resolve-comment' : '+restore-comment', '--token', documentId, '--type', 'docx', '--comment-id', commentId]);
      if ((result.file_token !== undefined && result.file_token !== documentId) || (result.comment_id !== undefined && result.comment_id !== commentId)) throw invalid();
    },
  };
}
