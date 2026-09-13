import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from './server';
import { loadCloudConnection,loadCLIProfile } from './cloud-config';
import { createContentCLI } from './content-cli';
import { createCloudCLI } from './cloud-cli';
import { openProjectSettings } from './project-settings';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const supportedOptions = new Set(['--port','--file','--cloud-config','--cli-config','--projects-file']);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!supportedOptions.has(name)) throw new Error(`不支持的启动参数：${name}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数。`);
}
function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const port = Number(option('--port') || '4318');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535 的整数。');
const selected = option('--file');
const cloudConfig = option('--cloud-config');
const cliConfig=option('--cli-config');
if(cloudConfig&&cliConfig)throw new Error('--cloud-config 和 --cli-config 选择一项即可。');
if(cloudConfig&&!selected)throw new Error('--cloud-config 需要同时指定 --file，明确关联哪份本地稿件。');
let initial: string;
if (selected) initial = resolve(selected);
else {
  await mkdir(resolve(root,'.local'),{recursive:true});
  await mkdir(resolve(root,'.local/assets'),{recursive:true});
  await copyFile(resolve(root,'examples/assets/colors.png'),resolve(root,'.local/assets/colors.png'),1).catch(error => { if (error.code !== 'EEXIST') throw error; });
  initial = resolve(root,'.local/welcome.xml');
  await copyFile(resolve(root,'examples/demo.xml'),initial,1).catch(error => { if (error.code !== 'EEXIST') throw error; });
}
const cloud=cloudConfig?await loadCloudConnection(resolve(cloudConfig),initial):undefined;
const profile=cliConfig||cloudConfig?await loadCLIProfile(resolve((cliConfig||cloudConfig)!)):undefined;
const selectedProjects=option('--projects-file');
const projectPath=resolve(selectedProjects||resolve(root,'.local/projects.json'));
await mkdir(dirname(projectPath),{recursive:true,mode:0o700});
const defaultSharedPath=resolve(homedir(),'.lark-review/projects.json');
const settings=await openProjectSettings({localPath:projectPath,settingsPath:resolve(dirname(projectPath),'project-settings.json'),sharedPath:defaultSharedPath,preferLocal:selectedProjects!==undefined});
const server = await createLocalServer(resolve(root,'dist/client'),initial,{cloud,projectSettings:{...settings,defaultSharedPath},projects:{store:settings.store,
  historyRoot:resolve(dirname(projectPath),'sync-history'),
  ...(profile?{transport:createContentCLI(profile),comments:(project)=>project.cloud?{...project.cloud,localPath:project.localPath,transport:createCloudCLI({...profile,...project.cloud})}:undefined}:{})}});
server.on('error',error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port,'127.0.0.1',() => console.log(`本地飞书文档：http://127.0.0.1:${port}/\n文档：${initial}\n编辑和评论自动保存到 XML 与相邻 .review.json`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => server.close(() => process.exit(0)));
