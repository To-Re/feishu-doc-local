import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedCLIRunner} from '../src/runner';

const folders:string[]=[],runners:ManagedCLIRunner[]=[];
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function folder(){const path=await mkdtemp(join(tmpdir(),'feishu-runner-'));folders.push(path);return path;}
function runner(options:ConstructorParameters<typeof ManagedCLIRunner>[1]={}){const value=new ManagedCLIRunner(undefined,options);runners.push(value);return value;}
async function waitForFile(path:string){for(let i=0;i<100;i++){try{return await readFile(path,'utf8');}catch{await delay(15);}}throw new Error('Fixture did not start');}
afterEach(async()=>{for(const item of runners.splice(0))item.dispose();for(const path of folders.splice(0))await rm(path,{recursive:true,force:true});});

describe('actual CLI process boundaries',()=>{
  it('runs a download fixture inside the trusted vault working directory',async()=>{
    const vault=await realpath(await folder()),script=join(vault,'download.cjs'),output=join(vault,'asset.bin');
    await writeFile(script,"const fs=require('node:fs'),path=require('node:path');const target=process.argv[2],part=path.relative(process.cwd(),target);if(part.startsWith('..')||path.isAbsolute(part))process.exit(2);fs.writeFileSync(target,'public fixture');console.log(JSON.stringify({cwd:process.cwd(),saved_path:target}));");
    const result=await runner({cwd:vault,timeoutMs:1000}).run(process.execPath,[script,output]);
    expect(JSON.parse((result as any).stdout)).toEqual({cwd:vault,saved_path:output});expect(await readFile(output,'utf8')).toBe('public fixture');
  });
  it('runs an npm-style executable with explicit Node despite a GUI PATH without Node',async()=>{
    const root=await folder(),command=join(root,'lark-cli');
    await writeFile(command,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n');await chmod(command,0o700);
    const env={...process.env,PATH:'/usr/bin:/bin'};
    await expect(runner({env,timeoutMs:1000}).run(command,[])).rejects.toThrow('Node');
    const result=await runner({env,nodePath:process.execPath,timeoutMs:1000}).run(command,['a b','$(unchanged)','中文']);
    expect(typeof result).not.toBe('string');expect(JSON.parse((result as any).stdout)).toEqual(['a b','$(unchanged)','中文']);
  });

  it('closes stdin and removes inherited Node startup injection',async()=>{
    const root=await folder(),script=join(root,'stdin.cjs');
    await writeFile(script,"const fs=require('node:fs');console.log(JSON.stringify({input:fs.readFileSync(0,'utf8'),injected:!!process.env.NODE_OPTIONS||!!process.env.NODE_PATH}));");
    const result=await runner({timeoutMs:1000,env:{...process.env,NODE_OPTIONS:'--require /missing-injected-code',NODE_PATH:'/unexpected/modules'}}).run(process.execPath,[script]);
    expect(JSON.parse((result as any).stdout)).toEqual({input:'',injected:false});
  });

  it.each(['dispose','timeout'] as const)('stops both wrapper and inherited-stdio worker on %s',async reason=>{
    if(process.platform==='win32')return;
    const root=await folder(),heartbeat=join(root,'heartbeat'),worker=join(root,'worker.cjs'),wrapper=join(root,'wrapper.cjs');
    await writeFile(worker,"const fs=require('node:fs');const p=process.argv[2];fs.writeFileSync(p,String(Date.now()));setInterval(()=>fs.writeFileSync(p,String(Date.now())),15);");
    await writeFile(wrapper,"require('node:child_process').execFileSync(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit'});");
    const managed=runner({timeoutMs:reason==='timeout'?450:3000});
    const outcome=Promise.resolve(managed.run(process.execPath,[wrapper,worker,heartbeat])).then(()=>null,error=>error);
    await waitForFile(heartbeat);if(reason==='dispose')managed.dispose();
    const error=await outcome;expect(error.message).toMatch(reason==='dispose'?/停止/:/超时/);
    await delay(80);const stopped=await readFile(heartbeat,'utf8');await delay(100);expect(await readFile(heartbeat,'utf8')).toBe(stopped);
  });

  it.each(['dispose','timeout'] as const)('keeps already received IDs private after %s',async reason=>{
    const root=await folder(),ready=join(root,'ready'),script=join(root,'receipt.cjs');
    await writeFile(script,"const fs=require('node:fs');process.stdout.write(JSON.stringify({document_id:'public-fixture-id'}));fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);");
    const managed=runner({timeoutMs:reason==='timeout'?400:1500});
    const outcome=Promise.resolve(managed.run(process.execPath,[script,ready])).then(()=>null,error=>error);
    await waitForFile(ready);await delay(40);if(reason==='dispose')managed.dispose();
    const error=await outcome;expect(error.receipt.stdout).toContain('public-fixture-id');expect(error.receipt.exitCode).toBe(reason==='timeout'?'TIMEOUT':'ABORTED');expect(JSON.stringify(error)).not.toContain('public-fixture-id');
  });

  it('bounds output and promptly settles even while a descendant holds stdout',async()=>{
    const root=await folder(),script=join(root,'large.cjs');
    await writeFile(script,"process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000);");
    await expect(runner({maxBuffer:1024,timeoutMs:1000}).run(process.execPath,[script])).rejects.toThrow('输出超过上限');
  });
});
