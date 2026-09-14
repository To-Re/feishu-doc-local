import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline: never fetch packages, licenses, credentials, or project documents.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--check', '--verify-bundle'].includes(flag))) {
  throw new Error('Usage: node scripts/generate-third-party-notices.mjs [--check] [--verify-bundle]');
}
const check = flags.has('--check');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(resolve(root, path));
const lock = JSON.parse(await read('package-lock.json'));
const project = JSON.parse(await read('package.json'));
const generated = new Map();
const records = [];
const tools = new Set(['esbuild', 'vite', 'typescript', '@vitejs/plugin-react', 'lightningcss']);
const seed = await read('licenses/upstream/saxes-6.0.0-LICENSE.txt');
if (hash(seed) !== '0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e') {
  throw new Error('The pinned saxes 6.0.0 license differs; review its upstream provenance.');
}
const ofl = await read('licenses/upstream/OFL-1.1-template.txt');
if (hash(ofl) !== '1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e') {
  throw new Error('The pinned official OFL 1.1 text differs; review its upstream provenance.');
}
function add(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const previous = generated.get(path);
  if (previous && !previous.equals(bytes)) throw new Error(`Conflicting generated license: ${path}`);
  generated.set(path, bytes);
  return { path, sha256: hash(bytes) };
}
function repositoryURL(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) return null;
  const value = raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  // Do not copy private registry or credential-bearing repository URLs into notices.
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (!['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!path) continue;
  const nameFromPath = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (entry.dev && !tools.has(nameFromPath)) continue;
  const pkg = JSON.parse(await read(`${path}/package.json`));
  if (pkg.version !== entry.version) throw new Error(`${path}: installed version differs from package-lock; run npm ci.`);
  const name = pkg.name;
  const slug = `${name.replace(/^@/, '').replaceAll('/', '__')}-${entry.version}`;
  let license = entry.license || pkg.license;
  const notices = [];
  const names = (await readdir(resolve(root, path))).filter(name => /^(?:licen[cs]e|copying|notice|ofl)(?:$|[.-])/i.test(name)).sort();
  for (const filename of names) {
    const bytes = await read(`${path}/${filename}`);
    notices.push({ source: `${path}/${filename}`, ...add(`licenses/packages/${slug}/${filename}`, bytes) });
  }
  if (name === 'saxes' && entry.version === '6.0.0' && notices.length === 0) {
    notices.push({ source: 'https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE',
      ...add(`licenses/packages/${slug}/LICENSE`, seed) });
  }
  if (name === 'khroma' && !license && notices.some(item => /license$/i.test(item.source))) {
    const text = (await read(`${path}/license`)).toString('utf8');
    if (text.startsWith('The MIT License (MIT)')) license = 'MIT';
  }
  if (!license || typeof license !== 'string' || !notices.length) {
    throw new Error(`${name}@${entry.version}: missing declared license or complete license file; no inferred fallback.`);
  }
  if (name === 'dompurify') {
    const firstLine = (await read(`${path}/dist/purify.es.mjs`)).toString('utf8').split('\n')[0];
    if (!firstLine.startsWith('/*! @license DOMPurify')) throw new Error('Review the DOMPurify attribution header.');
    notices.push({ source: `${path}/dist/purify.es.mjs (original first line)`,
      ...add(`licenses/packages/${slug}/COPYRIGHT.txt`, `${firstLine}\n`) });
  }
  let selectedLicense = name === 'dompurify' ? 'Apache-2.0' : license;
  if (name === 'elkjs') {
    // These plain source comments are removed by minifiers. The package's root
    // EPL text does not include its authors or the embedded Apache Worker notice.
    const source = `${path}/lib/elk.bundled.js`;
    const comments = [...(await read(source)).toString('utf8').matchAll(/\/\*[\s\S]*?\*\//g)]
      .map(match => match[0]).filter(comment => /copyright/i.test(comment));
    const expected = [
      '9cba89b66d6fc021c4713addf7b3139ebcb04116c1fa5891752e61798a0ffb4c',
      '62331fccefdebd6b35ba827022e702f544deacc38031b59c427bb33c58b214e9',
      '9d0b9f85b5469b975a799fd9237d7939273647c5f9ee8f6b8ccbaaba0d7610cd',
    ];
    if (entry.version !== '0.9.3' || comments.length !== expected.length
      || comments.some((comment, index) => hash(comment) !== expected[index])) {
      throw new Error('Review the elkjs bundled copyright and embedded license notices against the upstream version.');
    }
    // Use the already installed, complete Apache text, verified independently of
    // the DOMPurify package version; never substitute a short header for it.
    const apache = await read('node_modules/dompurify/LICENSE');
    if (hash(apache) !== 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30') {
      throw new Error('Review the complete Apache 2.0 text used for the embedded elkjs Worker.');
    }
    notices.push({ source: `${source} (original copyright and license comments; trailing whitespace trimmed)`,
      ...add(`licenses/packages/${slug}/COPYRIGHT.txt`, `${comments.map(comment => comment.replace(/[ \t]+$/gm, '')).join('\n\n')}\n`) },
    { source: 'node_modules/dompurify/LICENSE (complete Apache 2.0 text for the embedded elkjs Worker)',
      ...add(`licenses/packages/${slug}/Apache-2.0.txt`, apache) });
    selectedLicense = 'EPL-2.0 AND Apache-2.0';
  }
  records.push({ name, version: entry.version, packagePath: path,
    scope: entry.dev ? 'build-tooling-not-shipped' : 'runtime-dependency-closure',
    declaredLicense: license, selectedLicense,
    repository: repositoryURL(pkg),
    sourceArchive: typeof entry.resolved === 'string' && entry.resolved.startsWith('https://registry.npmjs.org/') ? entry.resolved : null,
    integrity: entry.integrity || null, notices });
}

// Font copyright and OFL/RFN notices are inside the shipped TTF name tables,
// separate from KaTeX JavaScript's MIT LICENSE. WOFF/WOFF2 use the same named fonts.
function fontNames(bytes) {
  const tableCount = bytes.readUInt16BE(4);
  let offset;
  for (let index = 0; index < tableCount; index++) {
    const row = 12 + index * 16;
    if (bytes.toString('ascii', row, row + 4) === 'name') offset = bytes.readUInt32BE(row + 8);
  }
  if (offset === undefined) throw new Error('Font has no name table.');
  const count = bytes.readUInt16BE(offset + 2);
  const strings = offset + bytes.readUInt16BE(offset + 4);
  const values = new Map();
  for (let index = 0; index < count; index++) {
    const row = offset + 6 + index * 12;
    const platform = bytes.readUInt16BE(row);
    const id = bytes.readUInt16BE(row + 6);
    if (![0, 13, 14].includes(id)) continue;
    const length = bytes.readUInt16BE(row + 8);
    const start = strings + bytes.readUInt16BE(row + 10);
    const raw = Buffer.from(bytes.subarray(start, start + length));
    const value = platform === 0 || platform === 3 ? raw.swap16().toString('utf16le') : raw.toString('latin1');
    if (!values.has(id)) values.set(id, new Set());
    values.get(id).add(value);
  }
  return Object.fromEntries([...values].map(([id, values]) => [id, [...values].sort()]));
}
const fontDir = 'node_modules/katex/dist/fonts';
const fontFiles = (await readdir(resolve(root, fontDir))).filter(name => /\.(ttf|woff2?)$/.test(name)).sort();
const fontRecords = [];
const fontNotices = [];
for (const filename of fontFiles.filter(name => name.endsWith('.ttf'))) {
  const metadata = fontNames(await read(`${fontDir}/${filename}`));
  if (!metadata[13]?.every(value => value.includes('SIL Open Font License, Version 1.1'))) {
    throw new Error(`Unexpected font license in ${filename}; review before regenerating.`);
  }
  fontNotices.push(`FONT: ${filename}\n\n${metadata[0].join('\n')}\n\n${metadata[13].join('\n')}\n`);
}
for (const filename of fontFiles) {
  const ttf = filename.replace(/\.(woff2?|ttf)$/, '.ttf');
  if (!fontFiles.includes(ttf)) throw new Error(`No matching TTF metadata for ${filename}`);
  fontRecords.push({ source: `${fontDir}/${filename}`, sha256: hash(await read(`${fontDir}/${filename}`)),
    attributionSource: `${fontDir}/${ttf}` });
}
const oflText = ofl.toString('utf8');
const oflStart = oflText.indexOf('SIL OPEN FONT LICENSE Version 1.1');
if (oflStart < 0) throw new Error('Missing OFL full text.');
const fontNotice = add('licenses/KaTeX-fonts-OFL-1.1.txt',
  `KaTeX font files: original copyright and reserved font names\n\n${fontNotices.join('\n---\n\n')}\n${oflText.slice(oflStart)}`);

const manifest = { schemaVersion: 1, description: 'Installed lockfile runtime closure, selected build-tool notices, and redistributed font metadata. Runtime closure is a conservative superset of bundled modules.',
  packages: records, fonts: { package: `katex@${lock.packages['node_modules/katex'].version}`, license: 'OFL-1.1', notice: fontNotice, files: fontRecords } };
add('licenses/dependencies.json', `${JSON.stringify(manifest, null, 2)}\n`);
const runtime = records.filter(item => item.scope === 'runtime-dependency-closure');
const tooling = records.filter(item => item.scope === 'build-tooling-not-shipped');
const table = items => items.map(item => `| ${item.name} | ${item.version} | ${item.selectedLicense.replaceAll('|', '\\|')} | ${item.notices.map(notice => `[${notice.path.split('/').at(-1)}](${notice.path.slice('licenses/'.length)})`).join(', ')} |`).join('\n');
add('licenses/README.md', `# 第三方许可清单\n\n由 \`node scripts/generate-third-party-notices.mjs\` 离线生成；来源为当前锁文件、已安装包的原始许可文本和已核对的上游补充文件。缺少许可或版本不符会失败。完整来源、版本、哈希和包完整性值见 [dependencies.json](dependencies.json)。\n\n## 运行时依赖\n\n以下 ${runtime.length} 项为运行时依赖闭包，覆盖构建入包依赖并包含被 tree shaking 去掉的包；不是声称每个包都进入最终 JS。\n\n| 包 | 版本 | 本分发使用的许可 | 完整文本与通知 |\n| --- | --- | --- | --- |\n${table(runtime)}\n\n## 构建工具\n\n这些工具用于安装、转换或构建，不作为编辑器运行时代码打包。平台二进制、测试依赖和完整 node_modules 不随本项目分发；若改变分发范围，需重新审计。\n\n| 包 | 版本 | 许可 | 完整文本与通知 |\n| --- | --- | --- | --- |\n${table(tooling)}\n\n## 字体\n\nKaTeX 的 ${fontRecords.length} 个字体文件按 **OFL-1.1** 单独记录，包含原始版权、各字体保留名称和完整许可：[字体通知](KaTeX-fonts-OFL-1.1.txt)。JS/CSS 的 MIT 不能替代字体许可。\n\n运行 \`node scripts/generate-third-party-notices.mjs --check --verify-bundle\`，可比较清单与安装状态，并以内存构建核对 Vite 和 esbuild 实际模块及字体覆盖范围；该检查不改写 dist。\n`);

if (flags.has('--verify-bundle')) {
  const found = new Set();
  function collect(id) {
    const path = relative(root, id.replace(/^\0/, '')).replaceAll('\\', '/');
    const matches = [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    if (!matches.length) return;
    const match = matches.at(-1);
    const end = match.index + match[0].length;
    const packagePath = path.slice(0, end);
    if (!records.some(item => item.packagePath === packagePath)) throw new Error(`Bundled dependency missing from notice inventory: ${packagePath}`);
    found.add(packagePath);
  }
  const { build: viteBuild } = await import('vite');
  for(const config of ['vite.config.ts','vite.browser.config.ts'])await viteBuild({ root, configFile:resolve(root,config), logLevel: 'silent', build: { write: false }, plugins: [{ name: 'verify-license-coverage',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') for (const id of Object.keys(output.modules)) collect(id);
        if (output.type === 'asset' && /\.(woff2?|ttf)$/.test(output.fileName)) {
          const contentHash = hash(output.source);
          if (!fontRecords.some(font => font.sha256 === contentHash)) throw new Error(`Unattributed bundled font: ${output.fileName}`);
        }
      }
    } }] });
  const { build: esbuild } = await import('esbuild');
  const server = await esbuild({ absWorkingDir: root, entryPoints: ['src/server/start.ts'], outfile: 'dist/server/start.js',
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent' });
  for (const id of Object.keys(server.metafile.inputs)) collect(resolve(root, id));
  const pluginRoot=resolve(root,'obsidian-plugin');
  const plugin=await esbuild({absWorkingDir:pluginRoot,entryPoints:['src/main.ts'],outfile:'dist/main.js',bundle:true,
    platform:'browser',format:'cjs',target:'es2022',external:['obsidian'],loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},write:false,metafile:true,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
  for(const id of Object.keys(plugin.metafile.inputs))collect(resolve(pluginRoot,id));
  const syncRoot=resolve(root,'obsidian-sync-plugin');
  const sync=await esbuild({absWorkingDir:syncRoot,entryPoints:['src/main.tsx'],outfile:'dist/main.js',bundle:true,
    platform:'node',format:'cjs',target:'es2022',external:['obsidian','electron'],write:false,metafile:true,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
  for(const id of Object.keys(sync.metafile.inputs))collect(resolve(syncRoot,id));
  console.log(`Verified ${found.size} bundled package paths and emitted font assets.`);
}

for (const [path, expected] of generated) {
  if (check) {
    let actual;
    try { actual = await read(path); } catch { throw new Error(`Missing generated file: ${path}`); }
    if (!actual.equals(expected)) throw new Error(`Outdated generated file: ${path}; regenerate and review the diff.`);
  } else {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), expected);
  }
}
console.log(`${check ? 'Checked' : 'Generated'} ${generated.size} license files: ${runtime.length} runtime packages, ${tooling.length} build tools, ${fontRecords.length} fonts for ${project.name}.`);
