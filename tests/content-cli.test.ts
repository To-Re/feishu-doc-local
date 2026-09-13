import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContentCLIError, createContentCLI, type ContentCLIRunner } from '../src/server/content-cli';

const profile = { command: 'configured-cli', args: ['--config', '/local config.yml', 'compat', '--as', 'bot'] };
const success = (data: unknown) => JSON.stringify({ ok: true, data });
const argument = (args: readonly string[], key: string) => args[args.indexOf(key) + 1];
const folders: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'content-cli-')); folders.push(dir);
  const path = join(dir, 'draft.xml'); await writeFile(path, '<p><img path="@image.png"/>正文</p>');
  return { dir, path };
}
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('official body CLI transport', () => {
  it('resolves Wiki through a full fetch and keeps the exact reference map and revision', async () => {
    const calls: readonly string[][] = [];
    const runner: ContentCLIRunner = async (command, args) => {
      expect(command).toBe(profile.command); (calls as string[][]).push([...args]);
      expect(args).toEqual([...profile.args, 'docs', '+fetch', '--doc', 'https://example.larkoffice.com/wiki/wiki1', '--doc-format', 'xml', '--detail', 'full', '--scope', 'full', '--format', 'json']);
      return success({ document: { document_id: 'doc1', content: '<title id="doc1">标题</title><p id="p1">文字</p>', revision_id: 9, reference_map: { whiteboards: { b: { future: 1 } } } } });
    };
    expect(await createContentCLI(profile, runner).fetch('https://example.larkoffice.com/wiki/wiki1?from=share#part')).toEqual({ documentId: 'doc1', url: 'https://example.larkoffice.com/docx/doc1', xml: '<title id="doc1">标题</title><p id="p1">文字</p>', revision: 9, referenceMap: { whiteboards: { b: { future: 1 } } } });
    expect(calls).toHaveLength(1);
  });

  it.each([
    { document_id: 'wrong', revision_id: 1, content: '<p/>' },
    { document_id: 'doc1', revision_id: -1, content: '<p/>' },
    { document_id: 'doc1', revision_id: 9007199254740992, content: '<p/>' },
    { document_id: 'doc1', revision_id: 1, content: '<p>' },
    { document_id: 'doc1', revision_id: 1, content: '<p/>', reference_map: [] },
  ])('rejects a wrong identity, revision, or broken XML', async document => {
    await expect(createContentCLI(profile, async () => success({ document })).fetch('doc1')).rejects.toThrow();
  });

  it('stages private sibling XML files, preserves bytes and media base, and surfaces skipped permission', async () => {
    const { dir, path } = await fixture(); let uploaded = '';
    const created = await createContentCLI(profile, async (_command, args) => {
      uploaded = argument(args, '--content').slice(1);
      expect(uploaded).not.toBe(path); expect(dirname(uploaded)).toBe(await import('node:fs/promises').then(fs => fs.realpath(dir)));
      expect((await stat(uploaded)).mode & 0o777).toBe(0o600);
      expect(await readFile(uploaded, 'utf8')).toBe(await readFile(path, 'utf8'));
      expect(argument(args, '--title')).toBe('标题 $(不执行)');
      return success({ document: { document_id: 'new1' }, permission_grant: { status: 'skipped', message: '访问权限未自动授予' } });
    }).create({ title: '标题 $(不执行)', contentPath: path });
    expect(created).toMatchObject({ documentId: 'new1', url: 'https://www.feishu.cn/docx/new1', warnings: ['飞书文档已创建；当前账号访问权限未自动授予，请使用已授权文件夹或在飞书中设置访问权。'] });
    expect(created.receipt?.stdout).toContain('permission_grant');
    await expect(stat(uploaded)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual(['draft.xml']);
  });

  it('passes base revision and reference map by private files and cleans both on a single failed write', async () => {
    const { dir, path } = await fixture(), map = join(dir, 'map.json'); await writeFile(map, '{"comments":{"c1":{"data":"opaque"}}}');
    let calls = 0;
    await expect(createContentCLI(profile, async (_command, args) => {
      calls++;
      expect(argument(args, '--revision-id')).toBe('42'); expect(argument(args, '--block-id')).toBe('p1');
      expect(await readFile(argument(args, '--reference-map').slice(1), 'utf8')).toBe(await readFile(map, 'utf8'));
      throw new Error('secret stderr / token / original argv');
    }).update({ documentId: 'doc1', revision: 42, command: 'block_replace', blockId: 'p1', contentPath: path, referenceMapPath: map })).rejects.toThrow('未确认成功');
    expect(calls).toBe(1); expect((await readdir(dir)).sort()).toEqual(['draft.xml', 'map.json']);
  });

  it.each(['overwrite', 'append', 'block_replace', 'block_insert_after', 'block_delete'] as const)('accepts only complete update receipt for %s', async command => {
    const { path } = await fixture();
    const operation = { documentId: 'doc1', revision: 2, command, ...(command.startsWith('block_') ? { blockId: 'b1' } : {}), ...(command !== 'block_delete' ? { contentPath: path } : {}) };
    let calls = 0;
    const adapter = createContentCLI(profile, async (_command, args) => { calls++; expect(argument(args, '--command')).toBe(command); if (command === 'block_delete') expect(args).not.toContain('--content'); return success({ result: 'success' }); });
    await adapter.update(operation); expect(calls).toBe(1);
    await expect(createContentCLI(profile, async () => success({ result: 'failed' })).update(operation)).rejects.toThrow();
    await expect(createContentCLI(profile, async () => success({})).update(operation)).rejects.toThrow();
  });

  it('rejects unsupported URL, dry-run, async/partial receipt, and unsafe file before treating anything as success', async () => {
    const { dir, path } = await fixture(); let calls = 0;
    const adapter = createContentCLI(profile, async () => { calls++; return success({ dry_run: true }); });
    await expect(adapter.fetch('https://evil.example/docx/doc1')).rejects.toThrow();
    await expect(adapter.update({ documentId: 'doc1', revision: -1, command: 'append', contentPath: path })).rejects.toThrow();
    const alias = join(dir, 'link.xml'); await symlink(path, alias);
    await expect(adapter.create({ title: 'title', contentPath: alias })).rejects.toThrow(); expect(calls).toBe(0);
    await expect(adapter.create({ title: 'title', contentPath: path })).rejects.toThrow(); expect(calls).toBe(1);
    for (const extra of [{ status: 'partial' }, { task_id: 'running' }, { task: { task_id: 'running', status: 'processing' } }, { result: 'processing' }]) await expect(createContentCLI(profile, async () => success({ document: { document_id: 'new1' }, ...extra })).create({ title: 'title', contentPath: path })).rejects.toThrow();
  });

  it('passes official replacement/deletion block lists but rejects duplicate IDs and multi-anchor insertion', async () => {
    const { path } = await fixture(); let calls = 0;
    const adapter = createContentCLI(profile, async (_command, args) => { calls++; expect(argument(args, '--block-id')).toBe('b1,b2'); return success({ result: 'success' }); });
    await adapter.update({ documentId: 'doc1', revision: 3, command: 'block_replace', blockId: 'b1,b2', contentPath: path });
    await adapter.update({ documentId: 'doc1', revision: 4, command: 'block_delete', blockId: 'b1,b2' });
    await expect(adapter.update({ documentId: 'doc1', revision: 3, command: 'block_replace', blockId: 'b1,b1', contentPath: path })).rejects.toThrow();
    await expect(adapter.update({ documentId: 'doc1', revision: 3, command: 'block_insert_after', blockId: 'b1,b2', contentPath: path })).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('downloads into private staging, checks actual bytes, then creates the requested resource without replacement', async () => {
    const { dir } = await fixture(), destination = join(dir, 'asset.png');
    let calls = 0;
    const adapter = createContentCLI(profile, async (_command, args) => {
      calls++; const path = argument(args, '--output'); expect(path.endsWith('.png')).toBe(true); expect(path).not.toBe(destination);
      expect(argument(args, '--type')).toBe('whiteboard'); await writeFile(path, 'image bytes');
      return success({ saved_path: path, size_bytes: 11, content_type: 'image/png' });
    });
    const result = await adapter.download({ token: 'board1', type: 'whiteboard', outputPath: destination });
    expect(await readFile(result.path, 'utf8')).toBe('image bytes'); expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    await expect(adapter.download({ token: 'board1', type: 'whiteboard', outputPath: destination })).rejects.toThrow('已存在'); expect(calls).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['asset.png', 'draft.xml']);
  });

  it('accepts a zero-byte attachment and keeps private file permissions and staging cleanup', async () => {
    const { dir } = await fixture(), destination = join(dir, 'empty.txt'); let calls = 0;
    const result = await createContentCLI(profile, async (_command, args) => {
      calls++; const path = argument(args, '--output');
      expect(argument(args, '--type')).toBe('media'); await writeFile(path, '');
      return success({ saved_path: path, size_bytes: 0, content_type: 'text/plain' });
    }).download({ token: 'attachment1', type: 'media', outputPath: destination });
    expect(await readFile(result.path)).toEqual(Buffer.alloc(0));
    expect((await stat(result.path)).mode & 0o777).toBe(0o600); expect(calls).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['draft.xml', 'empty.txt']);
  });

  it.each([
    { reason: 'negative size', size: -1, bytes: '' },
    { reason: 'fractional size', size: 0.5, bytes: '' },
    { reason: 'unsafe integer size', size: Number.MAX_SAFE_INTEGER + 1, bytes: '' },
    { reason: 'string size', size: '0', bytes: '' },
    { reason: 'null size', size: null, bytes: '' },
    { reason: 'missing size', size: undefined, bytes: '' },
    { reason: 'zero receipt with nonempty file', size: 0, bytes: 'x' },
    { reason: 'positive receipt with empty file', size: 1, bytes: '' },
  ])('rejects $reason without publishing the staged attachment', async ({ size, bytes }) => {
    const { dir } = await fixture(), destination = join(dir, 'empty.txt'); let calls = 0;
    await expect(createContentCLI(profile, async (_command, args) => {
      calls++; const path = argument(args, '--output'); await writeFile(path, bytes);
      return success({ saved_path: path, size_bytes: size, content_type: 'text/plain' });
    }).download({ token: 'attachment1', type: 'media', outputPath: destination })).rejects.toThrow('回执不完整或不匹配');
    expect(calls).toBe(1); await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual(['draft.xml']);
  });

  it.each(['race', 'wrong-size', 'wrong-path', 'no-file'])('never replaces another file or trusts a false download receipt: %s', async reason => {
    const { dir } = await fixture(), destination = join(dir, 'asset.png');
    await expect(createContentCLI(profile, async (_command, args) => {
      const path = argument(args, '--output');
      if (reason !== 'no-file') await writeFile(path, 'download');
      if (reason === 'race') await writeFile(destination, 'user data');
      return success({ saved_path: reason === 'wrong-path' ? destination : path, size_bytes: reason === 'wrong-size' ? 9 : 8, content_type: 'image/png' });
    }).download({ token: 'image1', type: 'media', outputPath: destination })).rejects.toThrow();
    if (reason === 'race') expect(await readFile(destination, 'utf8')).toBe('user data');
    else await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).some(name => name.startsWith('.lark-review'))).toBe(false);
  });

  it('uses literal argv in a real child process and keeps stderr and arguments out of errors', async () => {
    const { dir } = await fixture(), script = join(dir, 'cli.cjs');
    await writeFile(script, `process.stdout.write(JSON.stringify({ok:true,data:{document:{document_id:process.argv[3],revision_id:1,content:'<p/>'}}}));`);
    const adapter = createContentCLI({ command: process.execPath, args: [script, 'literal $(touch never)', 'doc1'] });
    expect((await adapter.fetch('doc1')).documentId).toBe('doc1');
    await writeFile(script, `process.stderr.write('private credential');process.exit(1);`);
    let message = ''; try { await adapter.fetch('doc1'); } catch (error) { message = String(error); }
    expect(message).toContain('未确认成功'); expect(message).not.toContain('private credential'); expect(message).not.toContain(script);
  });

  it('retains a failed process receipt privately without repeating the operation or exposing raw output in the error', async () => {
    const { dir } = await fixture(), script = join(dir, 'failure.cjs');
    const stdout = '{"ok":false,"data":{"document":{"document_id":"already_created"}}}', stderr = 'secret-auth-detail';
    await writeFile(script, `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(7);`);
    let error: unknown;
    try { await createContentCLI({command: process.execPath, args: [script]}).fetch('doc1'); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(ContentCLIError);
    const failure = error as ContentCLIError;
    expect(failure.receipt).toEqual({stdout, stderr, exitCode: 7});
    expect(String(failure)).not.toContain(stderr); expect(String(failure)).not.toContain('already_created');
    expect(JSON.stringify(failure)).not.toContain('receipt'); expect(JSON.stringify(failure)).not.toContain(stderr);
    expect(Object.getOwnPropertyDescriptor(failure, 'receipt')).toMatchObject({enumerable: false, writable: false});
    expect(Object.isFrozen(failure.receipt)).toBe(true);
  });

  it('keeps administrator grant failure separate from successful creation and preserves its private receipt', async () => {
    const {path: source} = await fixture();
    const raw = success({document: {document_id: 'created'}, permission_grant: {status: 'failed', member_id: 'ou_privateAdmin', message: 'Scope diagnostics'}});
    const result = await createContentCLI(profile, async () => raw).create({title: '管理员权限', contentPath: source});
    expect(result.documentId).toBe('created');
    expect(result.warnings).toEqual(['文档已创建，但指定管理员权限尚未确认；请在飞书检查权限。']);
    expect(result.receipt?.stdout).toBe(raw);
    expect(result.warnings.join(' ')).not.toContain('ou_privateAdmin');
    expect(result.warnings.join(' ')).not.toContain('Scope diagnostics');
  });

  it('translates successful creation warnings for readers while retaining exact diagnostics only in its private receipt', async () => {
    const { path } = await fixture();
    const raw = success({document: {document_id: 'created'}, warnings: ['degrade_code: unknown internal detail', {code: 'degrade_format', message: 'English formatting message'}],
      permission_grant: {status: 'skipped', message: 'Resource was created with bot identity; current user open_id missing'}});
    const result = await createContentCLI(profile, async () => ({stdout: raw, stderr: 'private warning', exitCode: 0})).create({title: '文章', contentPath: path});
    expect(result.warnings).toEqual(['飞书调整了部分格式，请通过正文预览核对回读结果。', '飞书文档已创建；当前账号访问权限未自动授予，请使用已授权文件夹或在飞书中设置访问权。']);
    expect(result.receipt).toEqual({stdout: raw, stderr: 'private warning', exitCode: 0});
    expect(result.warnings.join(' ')).not.toContain('degrade_code'); expect(result.warnings.join(' ')).not.toContain('open_id');
  });

  it.each(['typed', 'native'] as const)('preserves %s runner failure streams while replacing its message with a safe one', async kind => {
    const receipt = {stdout: 'partial-create-receipt', stderr: 'sensitive-stderr', exitCode: 1}; let calls = 0;
    const runner: ContentCLIRunner = async () => { calls++; throw kind === 'typed' ? new ContentCLIError('secret argv', receipt) : Object.assign(new Error('secret argv'), {...receipt, code: 1}); };
    let failure: ContentCLIError | undefined;
    try { await createContentCLI(profile, runner).fetch('doc1'); } catch (error) { failure = error as ContentCLIError; }
    expect(calls).toBe(1); expect(failure?.receipt).toEqual(receipt);
    expect(failure?.message).not.toContain('secret'); expect(JSON.stringify(failure)).not.toContain('sensitive');
  });

  it.each([
    'not-json-secret',
    JSON.stringify({ok: false, error: {message: 'private API error'}}),
    success({status: 'partial'}),
    success({document: {document_id: 'wrong', revision_id: 1, content: '<p/>'}}),
    success({document: {document_id: 'doc1', revision_id: 1, content: '<p>'}}),
    success({document: {document_id: 'doc1', revision_id: 1, content: '<p/>', url: 'https://unsafe.example/docx/doc1'}}),
  ])('retains raw stdout and stderr for envelope or full-document validation failure', async stdout => {
    const receipt = {stdout, stderr: 'private diagnostic', exitCode: 0};
    let failure: ContentCLIError | undefined;
    try { await createContentCLI(profile, async () => receipt).fetch('doc1'); } catch (error) { failure = error as ContentCLIError; }
    expect(failure).toBeInstanceOf(ContentCLIError); expect(failure?.receipt).toEqual(receipt);
    expect(JSON.stringify(failure)).not.toContain('private'); expect(failure?.message).not.toContain('unsafe.example');
  });
});
