import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudCLI, type CloudCLIRunner } from '../src/server/cloud-cli';
import type { CloudCLIOptions } from '../src/core/cloud-types';

const options: CloudCLIOptions = { command: 'configured-cli', args: ['--config', '/local config/config.yml', 'compat', '--as', 'bot'], documentId: 'doc_1', url: 'https://example.feishu.cn/docx/doc_1' };
const xml = '<title id="title_1">文档</title><p id="p_1">正文</p><whiteboard id="board_block" src="board_token"/>';
const success = (data: unknown) => JSON.stringify({ ok: true, data });
const fetchResult = () => success({ document: { document_id: 'doc_1', content: xml } });
const pageResult = (items: unknown[], extra: Record<string, unknown> = {}) => success({ file_token: 'doc_1', file_type: 'docx', items, has_more: false, page_token: '', count: items.length, ...extra });
const get = (args: readonly string[], key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const reply = (replyId: string, body: string) => ({ reply_id: replyId, user_id: 'reviewer', create_time: 1700000000, content: { elements: [{ type: 'text_run', text_run: { text: body } }] } });
const comment = (commentId: string, whole = false, solved = false) => ({ comment_id: commentId, is_whole: whole, is_solved: solved, create_time: 1700000000, quote: '原引用', reply_list: { replies: [reply('incomplete_preview', '列表的预览不能当完整正文')] } });
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('official CLI cloud transport', () => {
  it('reads all four filters and both pagination levels, separates only the first root reply, and retains native context', async () => {
    const calls: string[][] = [];
    const runner: CloudCLIRunner = async (command, args) => {
      expect(command).toBe(options.command); calls.push([...args]);
      expect(args.slice(0, options.args.length)).toEqual(options.args);
      expect(args.slice(-2)).toEqual(['--format', 'json']);
      if (args.includes('+fetch')) {
        expect(get(args, '--doc')).toBe('doc_1'); expect(get(args, '--detail')).toBe('full');
        return fetchResult();
      }
      if (args.includes('+list-comments')) {
        expect(args).toContain('--need-relation'); expect(get(args, '--token')).toBe('doc_1');
        if (get(args, '--comment-scope') === 'partial' && get(args, '--solved-status') === 'false') {
          if (!get(args, '--page-token')) return pageResult([{ ...comment('native_board'), parent_type: 'WHITEBOARD_BLOCK', parent_token: 'board_token',
            relation: { relation: JSON.stringify({ doc: { positionInfo: { blockID: 'board_block' } } }) }, future: { kept: true } }], { has_more: true, page_token: 'next comments' });
          expect(get(args, '--page-token')).toBe('next comments');
          return pageResult([{ ...comment('block_comment'), anchor: { block_id: 'p_1' } }]);
        }
        if (get(args, '--comment-scope') === 'whole' && get(args, '--solved-status') === 'true') return pageResult([comment('whole_resolved', true, true)]);
        return pageResult([]);
      }
      const cid = get(args, '--comment-id')!;
      if (cid === 'native_board') {
        if (!get(args, '--page-token')) return pageResult([reply('root_board', '白板的意见'), reply('reply_1', '第一页回复')], { comment_id: cid, has_more: true, page_token: 'next replies' });
        expect(get(args, '--page-token')).toBe('next replies');
        return pageResult([reply('reply_2', '第二页第一条仍是回复')], { comment_id: cid });
      }
      return pageResult([reply('root_' + cid, cid)], { comment_id: cid });
    };
    const result = await createCloudCLI(options, runner).read();
    expect(result.documentId).toBe('doc_1'); expect(result.xml).toBe(xml);
    expect(result.comments).toHaveLength(3);
    const board = result.comments.find(c => c.id === 'native_board')!;
    expect(board).toMatchObject({ body: '白板的意见', author: 'reviewer', createdAt: '2023-11-14T22:13:20.000Z', status: 'open', boardToken: 'board_token', blockId: 'board_block', whole: false });
    expect(board.replies.map(r => r.id)).toEqual(['reply_1', 'reply_2']);
    expect(board.raw).toMatchObject({ future: { kept: true }, has_more: false, reply_list: { replies: expect.any(Array) } });
    expect(result.comments.find(c => c.id === 'whole_resolved')).toMatchObject({ status: 'resolved', whole: true, body: 'whole_resolved', replies: [] });
    expect(result.comments.find(c => c.id === 'block_comment')?.blockId).toBe('p_1');
    expect(new Set(calls.filter(args => args.includes('+list-comments')).map(args => get(args, '--comment-scope') + ':' + get(args, '--solved-status')))).toEqual(new Set(['whole:false', 'whole:true', 'partial:false', 'partial:true']));
  });

  it.each(['missing-page-token', 'repeated-token', 'duplicate-item', 'wrong-document', 'partial', 'reply-failure', 'empty-replies', 'reply-missing-id', 'wrong-comment'])('rejects incomplete reads without returning an empty success: %s', async reason => {
    let listCalls = 0;
    const runner: CloudCLIRunner = async (_command, args) => {
      if (args.includes('+fetch')) return reason === 'wrong-document' ? success({ document: { document_id: 'different', content: xml } }) : fetchResult();
      if (args.includes('+list-comments')) {
        if (get(args, '--comment-scope') !== 'partial' || get(args, '--solved-status') !== 'false') return pageResult([]);
        listCalls++;
        if (reason === 'partial') return success({ status: 'partial', items: [] });
        if (reason === 'missing-page-token') return pageResult([comment('c')], { has_more: true });
        if (reason === 'repeated-token') return pageResult([comment('c' + listCalls)], { has_more: true, page_token: 'same' });
        if (reason === 'duplicate-item') return pageResult([comment('c')], { has_more: true, page_token: 'page' + listCalls });
        return pageResult([comment('c')]);
      }
      if (reason === 'reply-failure') throw new Error('sensitive stderr');
      if (reason === 'empty-replies') return pageResult([], { comment_id: 'c' });
      if (reason === 'reply-missing-id') return pageResult([{ ...reply('r', 'text'), reply_id: undefined }], { comment_id: 'c' });
      return pageResult([reply('r', 'text')], { comment_id: 'wrong' });
    };
    await expect(createCloudCLI(options, runner).read()).rejects.toThrow();
  });

  it('does not guess block IDs from quotes, deleted relations, or ambiguous references', async () => {
    const comments = [
      { ...comment('quote_only'), quote: '正文' },
      { ...comment('deleted'), relation: { content_deleted: true, relation: { x: { positionInfo: { blockID: 'p_1' } } } } },
      { ...comment('ambiguous'), relation: { relation: [{ positionInfo: { blockID: 'p_1' } }, { positionInfo: { blockID: 'board_block' } }] } },
      { ...comment('parent'), parent_type: 'WHITEBOARD_BLOCK', parent_token: 'board_token' },
    ];
    const runner: CloudCLIRunner = async (_command, args) => args.includes('+fetch') ? fetchResult() : args.includes('+list-comments')
      ? pageResult(get(args, '--comment-scope') === 'partial' && get(args, '--solved-status') === 'false' ? comments : [])
      : pageResult([reply('r_' + get(args, '--comment-id'), '正文')], { comment_id: get(args, '--comment-id') });
    const snapshot = await createCloudCLI(options, runner).read();
    expect(snapshot.comments.map(c => c.blockId)).toEqual([undefined, undefined, undefined, 'board_block']);
    expect(snapshot.comments.at(-1)?.boardToken).toBe('board_token');
  });

  it('resolves export-local comment refs through official reference-map XML without confusing aliases with real IDs', async () => {
    const runner: CloudCLIRunner = async (_command, args) => args.includes('+fetch')
      ? success({ document: { document_id: 'doc_1', content: '<p id="p_1" comment-refs="c1">正文</p>',
        reference_map: { comments: { c1: { data: '<comment comment-id="actual_comment" block-id="p_1"><msg>意见</msg></comment>' } } } } })
      : args.includes('+list-comments') ? pageResult(get(args, '--comment-scope') === 'partial' && get(args, '--solved-status') === 'false' ? [comment('actual_comment'), comment('c1')] : [])
      : pageResult([reply('root_' + get(args, '--comment-id'), '意见')], { comment_id: get(args, '--comment-id') });
    const snapshot = await createCloudCLI(options, runner).read();
    expect(snapshot.comments.map(c => [c.id, c.blockId])).toEqual([['actual_comment', 'p_1'], ['c1', undefined]]);
  });

  it('rejects a read if the document changes while comment pages are being read', async () => {
    let fetches = 0;
    const runner: CloudCLIRunner = async (_command, args) => args.includes('+fetch')
      ? success({ document: { document_id: 'doc_1', content: ++fetches === 1 ? xml : xml.replace('正文', '正文已改') } }) : pageResult([]);
    await expect(createCloudCLI(options, runner).read()).rejects.toThrow('正文已变化');
    expect(fetches).toBe(2);
  });

  it('uses explicit official write commands, validates current block IDs, and never retries an uncertain write', async () => {
    const calls: string[][] = [];
    const runner: CloudCLIRunner = async (_command, args) => {
      calls.push([...args]);
      if (args.includes('+fetch')) return fetchResult();
      if (args.includes('+add-comment')) return success({ comment_id: 'new_comment', file_token: 'doc_1' });
      if (args.includes('+add-reply')) return success({ reply_id: 'new_reply', comment_id: 'new_comment', file_token: 'doc_1' });
      return success({ comment_id: 'new_comment', file_token: 'doc_1' });
    };
    const api = createCloudCLI(options, runner);
    expect(await api.create('board_block', '节点父白板意见')).toEqual({ id: 'new_comment' });
    expect(await api.create(undefined, '全文意见')).toEqual({ id: 'new_comment' });
    expect(await api.reply('new_comment', '回复')).toEqual({ id: 'new_reply' });
    await api.resolve('new_comment', true); await api.resolve('new_comment', false);
    expect(calls.some(args => args.includes('--block-id') && get(args, '--block-id') === 'board_block')).toBe(true);
    expect(calls.some(args => args.includes('--full-comment'))).toBe(true);
    expect(calls.some(args => args.includes('+resolve-comment'))).toBe(true);
    expect(calls.some(args => args.includes('+restore-comment'))).toBe(true);
    const previousWrites = calls.filter(args => args.includes('+add-comment')).length;
    await expect(api.create('missing_block', '意见')).rejects.toThrow('找不到');
    expect(calls.filter(args => args.includes('+add-comment'))).toHaveLength(previousWrites);
    let attempts = 0;
    const failed = createCloudCLI(options, async () => { attempts++; throw new Error('token SECRET; stderr'); });
    await expect(failed.reply('new_comment', '回复')).rejects.toThrow('未确认'); expect(attempts).toBe(1);
  });

  it.each([success({}), success({ reply_id: 123 }), JSON.stringify({ ok: true, dry_run: true, data: { reply_id: 'dry' } }), JSON.stringify({ ok: false, error: { secret: 'hidden' } }), 'not JSON'])('requires a real write receipt and standard success envelope', async response => {
    await expect(createCloudCLI(options, async () => response).reply('comment', '回复')).rejects.toThrow('不完整');
  });

  it('keeps content as one argv value in a real child process, without executing shell syntax', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lark-cli-argv-')); folders.push(folder);
    const script = join(folder, 'fake-cli.mjs'), captured = join(folder, 'argv.json');
    await writeFile(script, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));console.log(JSON.stringify({ok:true,data:{reply_id:'real_receipt'}}));");
    const input = "中文\n'$HOME' `touch never` $(echo nope); > never & <xml>😀";
    const api = createCloudCLI({ ...options, command: process.execPath, args: [script, captured] });
    expect(await api.reply('comment', input)).toEqual({ id: 'real_receipt' });
    const args = JSON.parse(await readFile(captured, 'utf8')) as string[];
    expect(JSON.parse(get(args, '--content')!)).toEqual([{ type: 'text', text: input }]);
    expect(args).toEqual(['drive', '+add-reply', '--token', 'doc_1', '--type', 'docx', '--comment-id', 'comment', '--content', JSON.stringify([{ type: 'text', text: input }]), '--format', 'json']);
  });

  it('does not expose real child stderr or command paths on failure', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lark-cli-error-')); folders.push(folder);
    const script = join(folder, 'private-cli.mjs');
    await writeFile(script, "console.error('token=SECRET_VALUE');process.exit(1);");
    const api = createCloudCLI({ ...options, command: process.execPath, args: [script] });
    let error: unknown; try { await api.resolve('comment', true); } catch (value) { error = value; }
    expect(String(error)).toContain('未确认'); expect(String(error)).not.toMatch(/SECRET_VALUE|private-cli|token=/);
  });
});
