import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=process.argv.indexOf('--output');
if(output<0||!process.argv[output+1])throw new Error('Usage: node scripts/prepare-public-source.mjs --output /new/public/source');
const destination=resolve(process.argv[output+1]);
const within=relative(root,destination);
if(!within||(!within.startsWith('..'+sep)&&!isAbsolute(within)))throw new Error('Choose a new directory outside this development checkout.');
const rootFiles=new Set(['.gitignore','.gitattributes','AGENTS.md','README.md','LICENSE','CONTRIBUTING.md','CONTRIBUTORS.md','SECURITY.md','THIRD_PARTY_NOTICES.md',
  'package.json','package-lock.json','index.html','browser.html','tsconfig.json','vite.config.ts','vite.browser.config.ts','vitest.config.ts']);
const directories=new Set(['.github','src','tests','docs','examples','scripts','licenses','obsidian-plugin','obsidian-sync-plugin']);
const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root}).toString().split('\0').filter(name=>name&&name!=='SOURCE_MANIFEST.json');
const files=[...new Set(names)].sort();
const forbiddenParts=new Set(['.git','.local','.obsidian','node_modules','dist','coverage','test-results','playwright-report','sync-history','.review-sync-history','.gradle','.gradle-cache','build','.idea','.intellijPlatform']);
const findings=[];const manifest=[];const contents=new Map();
for(const name of files) {
  const parts=name.split('/');
  if(isAbsolute(name)||parts.includes('..')||parts.some(part=>forbiddenParts.has(part)||['.review-assets-','feishu-assets-','.review-import-'].some(prefix=>part.startsWith(prefix)))||
    (!rootFiles.has(name)&&!directories.has(parts[0]))||/\.(?:review\.json|pem|key|log|zip|tgz)$/.test(name)||parts.some(part=>part.startsWith('.env')))
    throw new Error(`File outside public source allowlist: ${name}`);
  for(let depth=1;depth<parts.length;depth++) {
    const parent=await lstat(resolve(root,...parts.slice(0,depth)));
    if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error(`Only real source directories are allowed: ${name}`);
  }
  const source=resolve(root,name),stat=await lstat(source);
  if(!stat.isFile())throw new Error(`Only regular source files are allowed: ${name}`);
  const data=await readFile(source),text=data.toString('utf8');
  contents.set(name,data);
  const patterns=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['access-token',/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{20,})/],
    ['jwt',/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/]];
  if(text.includes(root)||text.includes(homedir()+'/'))findings.push({file:name,category:'current-machine-path'});
  for(const [category,pattern] of patterns)if(pattern.test(text))findings.push({file:name,category});
  manifest.push({path:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
if(findings.length)throw new Error('Review these potential private values before exporting (values hidden): '+JSON.stringify(findings));
// mkdir is exclusive: this tool never replaces a previous candidate or user files.
await mkdir(destination);
for(const item of manifest) {
  await mkdir(dirname(resolve(destination,item.path)),{recursive:true});
  await writeFile(resolve(destination,item.path),contents.get(item.path),{flag:'wx'});
  const exported=await readFile(resolve(destination,item.path));
  if(createHash('sha256').update(exported).digest('hex')!==item.sha256)throw new Error(`Source changed during export: ${item.path}`);
}
await writeFile(resolve(destination,'SOURCE_MANIFEST.json'),JSON.stringify({formatVersion:1,files:manifest},null,2)+'\n',{flag:'wx'});
console.log(`Prepared ${manifest.length} reviewed source files without development history or runtime data.`);
