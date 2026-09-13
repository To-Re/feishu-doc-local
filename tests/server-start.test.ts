import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let executable:string;
const folders:string[]=[];
beforeAll(async()=>{
  const result=await build({entryPoints:[resolve('src/server/start.ts')],bundle:true,platform:'node',format:'esm',target:'node22',write:false});
  executable=result.outputFiles[0].text;
});
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});

describe('local server startup arguments',()=>{
  it.each([
    {name:'retired fixed-file flag without a document',args:()=>['--fixed-file'],invalid:'--fixed-file'},
    {name:'retired fixed-file flag in an existing launch command',args:(file:string,catalog:string)=>['--file',file,'--fixed-file','--projects-file',catalog],invalid:'--fixed-file'},
    {name:'unknown option',args:()=>['--unknown'],invalid:'--unknown'},
    {name:'unexpected positional argument',args:()=>['article.xml'],invalid:'article.xml'},
  ])('rejects $name before creating local state or starting the server',async({args,invalid})=>{
    const root=await mkdtemp(join(tmpdir(),'review-server-start-'));folders.push(root);
    const serverFolder=join(root,'dist/server');await mkdir(serverFolder,{recursive:true});
    const entry=join(serverFolder,'start.mjs');await writeFile(entry,executable);
    const file=join(root,'article.xml'),catalog=join(root,'project-state/projects.json'),xml='<p>Keep the original document</p>';
    await writeFile(file,xml);
    const result=spawnSync(process.execPath,[entry,...args(file,catalog)],{cwd:root,encoding:'utf8',timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).toBe(1);
    expect(result.stderr).toContain('不支持的启动参数：'+invalid);expect(result.stdout).toBe('');
    expect(await readdir(root)).toEqual(['article.xml','dist']);expect(await readFile(file,'utf8')).toBe(xml);
  });
});
