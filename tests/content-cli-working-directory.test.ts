import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('body CLI resource working directory in real processes', () => {
  it.each(['web', 'obsidian'])('uses the body directory for %s writes without changing fileless operations', async mode => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'feishu-cli-cwd-')));
    temporary.push(root);
    const host = join(root, '服务 Vault 根'), document = join(root, '文章 空格 中文'), references = join(root, '引用 映射');
    for (const directory of [host, document, references]) await mkdir(directory);
    const resource = '配图 1.png';
    await writeFile(join(host, resource), 'wrong host asset');
    await writeFile(join(references, resource), 'wrong reference-map asset');
    await writeFile(join(document, resource), 'correct document asset');
    const contentPath = join(document, '初稿 文档.xml'), referenceMapPath = join(references, '映射 文件.json');
    const xml = `<p>测试</p><img path="@${resource}"/>`;
    await writeFile(contentPath, xml);
    await writeFile(referenceMapPath, '{"images":{}}');
    const script = join(root, 'fixture-cli.cjs'), records = join(root, 'calls.jsonl'), driver = join(root, 'driver.cjs');
    // Reproduce the official CLI's cwd-first, then XML-directory resource lookup.
    // This stub only reads/writes the isolated fixture and never contacts a cloud.
    await writeFile(script, `
const fs = require('node:fs'), path = require('node:path');
const recordPath = process.argv[2], args = process.argv.slice(3);
const arg = key => args[args.indexOf(key) + 1];
const record = { command: args[1], operation: args.includes('--command') ? arg('--command') : undefined, cwd: process.cwd() };
if (args.includes('--content')) {
  const body = arg('--content').slice(1), xml = fs.readFileSync(body, 'utf8');
  const relative = /path="@([^"]+)"/.exec(xml)[1];
  const fromCwd = path.resolve(relative), fromBody = path.resolve(path.dirname(body), relative);
  const selected = fs.existsSync(fromCwd) ? fromCwd : fromBody;
  record.asset = fs.readFileSync(selected, 'utf8');
  record.selected = selected;
  record.bodyDirectory = path.dirname(body);
  if (args.includes('--reference-map')) record.referenceDirectory = path.dirname(arg('--reference-map').slice(1));
}
fs.appendFileSync(recordPath, JSON.stringify(record) + '\\n');
let data;
if (args[1] === '+fetch') data = { document: { document_id: 'doc1', revision_id: 1, content: '<p/>' } };
else if (args[1] === '+create') data = { document: { document_id: 'doc1' }, result: 'success' };
else if (args[1] === '+media-download') { fs.writeFileSync(arg('--output'), 'ok'); data = { saved_path: arg('--output'), size_bytes: 2, content_type: 'image/png' }; }
else data = { result: 'success' };
process.stdout.write(JSON.stringify({ ok: true, data }));
`);
    await build({
      absWorkingDir: repository, outfile: driver, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      stdin: { resolveDir: repository, contents: `
import { createContentCLI } from './src/server/content-cli';
import { ManagedCLIRunner } from './obsidian-sync-plugin/src/runner';
const mode = process.argv[2], input = JSON.parse(process.argv[3]);
const managed = mode === 'obsidian' ? new ManagedCLIRunner(undefined, { cwd: input.host }) : undefined;
const adapter = createContentCLI({ command: process.execPath, args: [input.script, input.records] }, managed?.run);
(async () => {
  try {
    await adapter.create({ title: '中文 title $(literal)', contentPath: input.contentPath });
    for (const command of ['overwrite', 'append', 'block_replace', 'block_insert_after']) {
      await adapter.update({ documentId: 'doc1', revision: 1, command, contentPath: input.contentPath,
        referenceMapPath: input.referenceMapPath, ...(command.startsWith('block_') ? { blockId: 'b1' } : {}) });
    }
    await adapter.fetch('doc1');
    await adapter.update({ documentId: 'doc1', revision: 1, command: 'block_delete', blockId: 'b1' });
    await adapter.download({ token: 'image1', type: 'media', outputPath: input.output });
  } finally { managed?.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
` },
    });
    // The driver itself has the conflicting host cwd. Only the individual body
    // write children should change directory; no process.chdir affects tests.
    await execute(process.execPath, [driver, mode, JSON.stringify({ host, script, records, contentPath, referenceMapPath, output: join(host, 'download.png') })], { cwd: host });
    const calls = (await readFile(records, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const writes = calls.filter(call => call.bodyDirectory);
    expect(writes).toHaveLength(5);
    for (const call of writes) {
      expect(call).toMatchObject({ cwd: document, bodyDirectory: document, selected: join(document, resource), asset: 'correct document asset' });
      if (call.operation) expect(call.referenceDirectory).toBe(references);
    }
    expect(calls.filter(call => !call.bodyDirectory).map(call => [call.command, call.operation, call.cwd]))
      .toEqual([['+fetch', undefined, host], ['+update', 'block_delete', host], ['+media-download', undefined, host]]);
    expect(await readFile(contentPath, 'utf8')).toBe(xml);
    expect((await readdir(document)).sort()).toEqual(['初稿 文档.xml', resource].sort());
    expect((await readdir(references)).sort()).toEqual(['映射 文件.json', resource].sort());
    expect(await readFile(join(references, resource), 'utf8')).toBe('wrong reference-map asset');
    expect(await readFile(join(host, resource), 'utf8')).toBe('wrong host asset');
  });
});
