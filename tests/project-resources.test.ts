import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalFile } from '../src/server/files';
import { createReview } from '../src/core/types';

const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function fixture(paths:string[]) {
  const folder=await realpath(await mkdtemp(join(tmpdir(),'review-project-')));folders.push(folder);
  const document=join(folder,'article.xml');
  const xml='<p>公开测试</p>'+paths.map(path=>`<source path="@${path}"/>`).join('');
  await writeFile(document,xml);
  return {folder,document,xml,file:await openLocalFile(document)};
}
describe('read-only project resource files',()=>{
  it('reads only current explicit UTF-8 resources and retains whitespace and literal markup',async()=>{
    const f=await fixture(['assets/note.txt','table.csv','drawing.svg']);
    await mkdir(join(f.folder,'assets'));
    const text='\uFEFF中文😀\r\n<script>这是文本</script>\t保留\r\n';
    await writeFile(join(f.folder,'assets/note.txt'),text);
    await writeFile(join(f.folder,'table.csv'),'name,value\nA,2\n');
    await writeFile(join(f.folder,'drawing.svg'),'<svg><script>alert(1)</script></svg>');
    await writeFile(join(f.folder,'secret.txt'),'unreferenced');
    expect(await f.file.resource('./assets/note.txt')).toEqual({path:'assets/note.txt',text});
    expect((await f.file.resource('table.csv')).text).toBe('name,value\nA,2\n');
    expect((await f.file.resource('drawing.svg')).text).toContain('<script>');
    await expect(f.file.resource('secret.txt')).rejects.toMatchObject({code:'UNLISTED_RESOURCE'});
    await expect(f.file.resource('article.xml')).rejects.toMatchObject({code:'UNLISTED_RESOURCE'});
    await writeFile(f.document,'<p>引用已移除</p>');
    await expect(f.file.resource('table.csv')).rejects.toMatchObject({code:'UNLISTED_RESOURCE'});
  });
  it('supports exact attachment resources from sidecar metadata without adding a write endpoint',async()=>{
    const f=await fixture([]);
    await writeFile(join(f.folder,'note.txt'),'附件内容');
    const review={...createReview('article.xml',f.xml),resources:{version:1 as const,items:[{tag:'source' as const,attribute:'token' as const,value:'exact-token',path:'note.txt',representation:'original' as const}]}};
    const before=await f.file.read();await f.file.save(f.xml,review,before.revision);
    expect(await f.file.resource('note.txt')).toEqual({path:'note.txt',text:'附件内容'});
  });
  it('rejects symlinks, linked ancestors, hardlinks, directories and FIFOs without hanging',async()=>{
    const names=['sym.txt','sub/note.txt','hard.txt','folder.txt','fifo.txt'];
    const f=await fixture(names);await writeFile(join(f.folder,'note.txt'),'本地文件');
    await symlink('note.txt',join(f.folder,'sym.txt'));
    await mkdir(join(f.folder,'actual'));await writeFile(join(f.folder,'actual/note.txt'),'本地文件');
    await symlink('actual',join(f.folder,'sub'));await link(join(f.folder,'note.txt'),join(f.folder,'hard.txt'));
    await mkdir(join(f.folder,'folder.txt'));await promisify(execFile)('mkfifo',[join(f.folder,'fifo.txt')]);
    for(const name of names)await expect(f.file.resource(name)).rejects.toMatchObject({code:'UNSAFE_RESOURCE'});
    for(const name of ['../note.txt',join(f.folder,'note.txt'),'https://example.com/note.txt','..\\note.txt'])
      await expect(f.file.resource(name)).rejects.toMatchObject({code:'UNSAFE_RESOURCE'});
  });
  it('rejects oversized, binary, invalid UTF-8 and unsupported formats, and reports missing files',async()=>{
    const f=await fixture(['large.txt','binary.txt','invalid.txt','file.pdf','missing.txt']);
    await writeFile(join(f.folder,'large.txt'),'x'.repeat(2_000_001));
    await writeFile(join(f.folder,'binary.txt'),Buffer.from([65,0,66]));
    await writeFile(join(f.folder,'invalid.txt'),Buffer.from([0xff]));
    await writeFile(join(f.folder,'file.pdf'),'%PDF');
    for(const [path,code] of [['large.txt','TOO_LARGE'],['binary.txt','UNSUPPORTED_RESOURCE'],['invalid.txt','INVALID_ENCODING'],['file.pdf','UNSUPPORTED_RESOURCE'],['missing.txt','NOT_FOUND']])
      await expect(f.file.resource(path)).rejects.toMatchObject({code});
  });
});
