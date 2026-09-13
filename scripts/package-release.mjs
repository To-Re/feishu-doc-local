import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = process.argv.indexOf('--output');
if (option < 0 || !process.argv[option + 1] || process.argv.length !== 4)
  throw new Error('Usage: node scripts/package-release.mjs --output /new/release/packages');
const destination = resolve(process.argv[option + 1]);
const inside = relative(root, destination);
if (!inside || (!inside.startsWith('..' + sep) && !isAbsolute(inside)))
  throw new Error('Choose a new output directory outside this checkout.');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a three-part release version.');
for (const directory of ['obsidian-plugin', 'obsidian-sync-plugin']) {
  for (const file of ['package.json', 'manifest.json', 'dist/manifest.json']) {
    const manifest = JSON.parse(await readFile(resolve(root, directory, file), 'utf8'));
    if (manifest.version !== version) throw new Error(`Rebuild ${directory}: ${file} version differs from ${version}.`);
  }
}

const forbidden = new Set(['.git', '.local', '.obsidian', 'node_modules', 'data.json', 'build-meta.json',
  'coverage', 'test-results', 'playwright-report', 'sync-history', '.review-sync-history']);
function validateName(name) {
  if (isAbsolute(name) || name.split('/').some(part => !part || part === '..' || forbidden.has(part) ||
      part.startsWith('.env') || part.startsWith('.review-') || part.startsWith('feishu-assets-')) ||
      /\.(?:review\.json|pem|key|log|map|zip|tgz)$/.test(name))
    throw new Error(`Unexpected distribution path: ${name}`);
}
function inspect(name, data) {
  validateName(name);
  const text = data.toString('utf8');
  if (text.includes(root) || text.includes(homedir() + '/'))
    throw new Error(`Private machine path detected (value hidden): ${name}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?<![A-Za-z0-9+/])AKIA[0-9A-Z]{16}(?![A-Za-z0-9+/=])|xox[baprs]-[0-9A-Za-z-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(text))
    throw new Error(`Potential credential detected (value hidden): ${name}`);
}
async function copyInput(files, source, target = source) {
  validateName(target);
  const absolute = resolve(root, source);
  // Check every ancestor: lstat on the leaf alone would follow a linked parent.
  const parts = source.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const stat = await lstat(resolve(root, ...parts.slice(0, depth)));
    if (stat.isSymbolicLink()) throw new Error(`Distribution input must not be a symlink: ${source}`);
  }
  const stat = await lstat(absolute);
  if (stat.isDirectory()) {
    for (const child of (await readdir(absolute)).sort())
      await copyInput(files, `${source}/${child}`, `${target}/${child}`);
  } else if (stat.isFile()) {
    if (files.has(target)) throw new Error(`Duplicate distribution path: ${target}`);
    const data = await readFile(absolute);
    inspect(target, data);
    files.set(target, data);
  } else throw new Error(`Distribution input must be a regular file: ${source}`);
}

// A deterministic ZIP writer using Node's standard library. Entries are UTF-8,
// sorted, regular files with mode 0644 and DOS date 1980-01-01; no host metadata.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files, top) {
  const local = [], central = [];
  let offset = 0;
  for (const [path, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const name = Buffer.from(`${top}/${path}`), compressed = deflateRawSync(data, { level: 9 });
    if (name.length > 65535 || data.length > 0xffffffff || compressed.length > 0xffffffff)
      throw new Error('Distribution exceeds ZIP32 bounds.');
    const crc = crc32(data), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (files.size > 65535 || offset + directory.length > 0xffffffff) throw new Error('Distribution exceeds ZIP32 bounds.');
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const artifacts = [];
const browser = new Map();
await copyInput(browser, 'dist/browser', '.browser-stage');
const browserFiles = new Map([...browser].map(([name, data]) => [name.slice('.browser-stage/'.length), data]));
if (!browserFiles.has('index.html')) throw new Error('Browser build missing index.html.');
browserFiles.set('START-HERE.zh-CN.md', Buffer.from(`本地飞书文档 v${version} · 静态浏览器版\n\n将此目录托管在 HTTPS 静态站点，通过桌面 Chrome 打开并授权文档目录。使用者无需安装 Node 或 CLI。不要通过 file:// 直接打开。正文和评论留在已授权的目录，本版不接入飞书同步。\n\n说明：https://github.com/To-Re/feishu-doc-local/releases/tag/v${version}\n`));
artifacts.push({ name: `feishu-doc-local-browser-v${version}.zip`, top: 'feishu-doc-local-browser', files: browserFiles });

const server = new Map();
for (const input of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'examples', 'docs', 'dist/server', 'dist/client'])
  await copyInput(server, input);
if (!server.has('dist/server/start.js') || !server.has('dist/client/index.html')) throw new Error('Local service build is missing.');
server.set('START-HERE.zh-CN.md', Buffer.from(`本地飞书文档 v${version} · 预构建本地服务\n\n安装 Node.js 22.13+，在此目录运行：\n\n    npm start\n\n然后打开 http://127.0.0.1:4318/ 。发布包已包含运行代码，无需安装项目依赖或重新构建；也可运行 node dist/server/start.js。README 中的 npm ci 与 build 命令用于源码开发。需要同步时另装并配置官方 lark-cli，本包不带 CLI、登录状态或用户配置。\n\n说明：https://github.com/To-Re/feishu-doc-local/releases/tag/v${version}\n`));
artifacts.push({ name: `feishu-doc-local-server-v${version}.zip`, top: 'feishu-doc-local', files: server });

for (const [directory, suffix, top] of [
  ['obsidian-plugin', 'obsidian', 'feishu-doc-local'],
  ['obsidian-sync-plugin', 'obsidian-sync', 'feishu-doc-local-sync'],
]) {
  const files = new Map();
  // Exact plugin install allowlist excludes build metadata and local data.json.
  for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses'])
    await copyInput(files, `${directory}/dist/${name}`, name);
  artifacts.push({ name: `feishu-doc-local-${suffix}-v${version}.zip`, top, files });
}

// Build and inspect every archive before creating the exclusive output directory.
const outputs = artifacts.map(item => ({ ...item, bytes: zip(item.files, item.top) }));
await mkdir(destination);
const sums = [];
for (const item of outputs) {
  await writeFile(resolve(destination, item.name), item.bytes, { flag: 'wx' });
  const hash = createHash('sha256').update(item.bytes).digest('hex');
  sums.push(`${hash}  ${item.name}`);
  console.log(`${item.name}: ${item.files.size} files, ${item.bytes.length} bytes`);
}
await writeFile(resolve(destination, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' });
console.log('Prepared exactly four runtime packages and SHA256SUMS; source export remains separate.');
