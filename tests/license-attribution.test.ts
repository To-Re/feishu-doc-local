import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'feishu-license-attribution-'));
  temporary.push(directory);
  for (const path of ['scripts', 'licenses/upstream', 'node_modules/elkjs/lib']) {
    await mkdir(resolve(directory, path), { recursive: true });
  }
  for (const path of ['scripts/generate-third-party-notices.mjs',
    'licenses/upstream/saxes-6.0.0-LICENSE.txt', 'licenses/upstream/OFL-1.1-template.txt',
    'node_modules/elkjs/package.json', 'node_modules/elkjs/LICENSE.md', 'node_modules/elkjs/lib/elk.bundled.js']) {
    await copyFile(resolve(repository, path), resolve(directory, path));
  }
  // Only ELK is edited below; the other installed packages are read-only inputs.
  for (const name of ['dompurify', 'katex']) {
    await symlink(resolve(repository, 'node_modules', name), resolve(directory, 'node_modules', name), 'dir');
  }
  const lock = JSON.parse(await readFile(resolve(repository, 'package-lock.json'), 'utf8'));
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify({
    packages: Object.fromEntries(['elkjs', 'dompurify', 'katex'].map(name => {
      const path = `node_modules/${name}`;
      return [path, lock.packages[path]];
    })),
  }));
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'license-attribution-fixture' }));
  return {
    directory,
    source: resolve(directory, 'node_modules/elkjs/lib/elk.bundled.js'),
    run: (...args: string[]) => exec(process.execPath, ['scripts/generate-third-party-notices.mjs', ...args], { cwd: directory }),
  };
}

describe('bundled ELK attribution', () => {
  it('distributes every original source notice with both complete licenses and checks the generated files', async () => {
    const test = await fixture();
    await test.run();
    await test.run('--check');
    const destination = resolve(test.directory, 'licenses/packages/elkjs-0.9.3');
    const source = await readFile(test.source, 'utf8');
    const original = [...source.matchAll(/\/\*[\s\S]*?\*\//g)]
      .map(match => match[0]).filter(comment => /copyright/i.test(comment));
    expect(original).toHaveLength(3);
    expect(await readFile(resolve(destination, 'COPYRIGHT.txt'), 'utf8'))
      .toBe(`${original.map(comment => comment.replace(/[ \t]+$/gm, '')).join('\n\n')}\n`);
    expect(await readFile(resolve(destination, 'LICENSE.md'), 'utf8'))
      .toBe(await readFile(resolve(repository, 'node_modules/elkjs/LICENSE.md'), 'utf8'));
    expect(await readFile(resolve(destination, 'Apache-2.0.txt'), 'utf8'))
      .toBe(await readFile(resolve(repository, 'node_modules/dompurify/LICENSE'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(test.directory, 'licenses/dependencies.json'), 'utf8'));
    expect(manifest.packages.find((item: { name: string }) => item.name === 'elkjs')).toMatchObject({
      declaredLicense: 'EPL-2.0', selectedLicense: 'EPL-2.0 AND Apache-2.0',
    });
    await writeFile(resolve(destination, 'COPYRIGHT.txt'), 'Incomplete attribution\n');
    await expect(test.run('--check')).rejects.toThrow('Outdated generated file: licenses/packages/elkjs-0.9.3/COPYRIGHT.txt');
  });

  it.each(['missing Kiel', 'missing Google', 'altered author', 'new notice'])(
    'blocks generation after an unreviewed source change: %s', async change => {
      const test = await fixture();
      await test.run();
      const before = await readFile(resolve(test.directory, 'licenses/dependencies.json'), 'utf8');
      let source = await readFile(test.source, 'utf8');
      if (change === 'missing Kiel' || change === 'missing Google') {
        const author = change === 'missing Kiel' ? '2017 Kiel University' : '2020 Google LLC';
        source = source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.includes(author) ? '' : comment);
      } else if (change === 'altered author') {
        source = source.replace('2017 Kiel University', '2017 Different Author');
      } else {
        source += '\n/* Copyright 2026 Additional Author */\n';
      }
      await writeFile(test.source, source);
      await expect(test.run()).rejects.toThrow('Review the elkjs bundled copyright and embedded license notices');
      expect(await readFile(resolve(test.directory, 'licenses/dependencies.json'), 'utf8')).toBe(before);
    },
  );
});
