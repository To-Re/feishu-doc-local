import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadCloudConnection} from '../src/server/cloud-config';
const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
it('only exposes document binding and canonical file path, without starting the configured CLI',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'cloud-config-'));folders.push(folder);
  const path=join(folder,'article.xml'),config=join(folder,'cloud.json');await writeFile(path,'<title/>');
  await writeFile(config,JSON.stringify({command:'this-command-does-not-exist',args:['--as','bot'],documentId:'doc1',url:'https://example.feishu.cn/docx/doc1'}));
  const result=await loadCloudConnection(config,path);
  expect(result.localPath).toBe(await realpath(path));expect(result).not.toHaveProperty('command');expect(result.transport.read).toBeTypeOf('function');
});
it('rejects unrelated or credential-bearing target URLs without printing supplied values',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'cloud-config-'));folders.push(folder);
  const path=join(folder,'article.xml'),config=join(folder,'cloud.json');await writeFile(path,'<title/>');
  for(const url of ['https://evil.test/docx/doc1','https://example.feishu.cn/docx/another','https://secret:credential@example.feishu.cn/docx/doc1','https://example.feishu.cn/docx/doc1?secret=private']){
    await writeFile(config,JSON.stringify({command:'cli',args:[],documentId:'doc1',url}));
    await expect(loadCloudConnection(config,path)).rejects.toThrow(/^飞书关联配置无效：/);
  }
});
