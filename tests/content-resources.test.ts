import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,writeFile,readFile,rm,symlink,link,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cacheContentResources,localAssetHashes} from '../src/server/content-resources';
import type {ResourceManifest} from '../src/core/types';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHXsAAAAASUVORK5CYII=','base64');
const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function setup(){const folder=await realpath(await mkdtemp(join(tmpdir(),'review-content-assets-')));folders.push(folder);const path=join(folder,'article.xml');await writeFile(path,'<p/>');return {folder,path};}
const downloader=()=>({download:vi.fn(async(input:{outputPath:string})=>{await writeFile(input.outputPath,png,{flag:'wx'});return {path:input.outputPath};})});

describe('explicit and safe content resource snapshots',()=>{
  it('hashes only explicit supported local assets, never arbitrary attributes or drawing-internal paths',async()=>{
    const t=await setup();await mkdir(join(t.folder,'assets'));await writeFile(join(t.folder,'assets','colors.png'),png);
    const hashes=await localAssetHashes('<p path="@not-a-resource">正文</p><img path="@./assets/colors.png"/><img path="@assets/colors.png"/><whiteboard><svg><path path="@not-a-file"/></svg></whiteboard>',t.path);
    expect(hashes).toEqual({'assets/colors.png':createHash('sha256').update(png).digest('hex')});
  });
  it('rejects parent escape, out-of-folder symlinks, hardlinks and FIFOs without blocking',async()=>{
    const t=await setup(),outside=await setup();await writeFile(join(outside.folder,'secret.bin'),'private');
    await symlink(join(outside.folder,'secret.bin'),join(t.folder,'alias.bin'));
    await writeFile(join(t.folder,'original.bin'),'private');await link(join(t.folder,'original.bin'),join(t.folder,'hard.bin'));
    execFileSync('mkfifo',[join(t.folder,'pipe.bin')]);
    for(const path of ['../secret.bin','alias.bin','hard.bin','pipe.bin'])await expect(localAssetHashes(`<source path="@${path}"/>`,t.path)).rejects.toMatchObject({code:'INVALID_PATH'});
  });
  it('reuses immutable media but refreshes a whiteboard preview even when its token is unchanged',async()=>{
    const t=await setup();await writeFile(join(t.folder,'old.png'),png);
    const previous:ResourceManifest={version:1,items:[{tag:'img',attribute:'token',value:'image',path:'old.png',representation:'original'},
      {tag:'whiteboard',attribute:'token',value:'board',path:'old.png',representation:'preview'}]};
    const api=downloader(),result=await cacheContentResources(t.path,'<img token="image"/><whiteboard token="board"/>',previous,api);
    expect(api.download).toHaveBeenCalledTimes(1);expect(api.download.mock.calls[0][0]).toMatchObject({token:'board',type:'whiteboard'});
    expect(result.resources.items[0].path).toBe('old.png');expect(result.resources.items[1].path).not.toBe('old.png');
    expect(await readFile(join(t.folder,result.resources.items[1].path))).toEqual(png);
  });
  it('keeps exact token/src selectors separate and does not overwrite either cache file',async()=>{
    const t=await setup(),api=downloader();
    const result=await cacheContentResources(t.path,'<img src="image"/><img token="image"/><img src="image"/>',undefined,api);
    expect(api.download).toHaveBeenCalledTimes(2);expect(result.resources.items.map(item=>item.attribute)).toEqual(['src','token']);
    expect(new Set(result.resources.items.map(item=>item.path)).size).toBe(2);
  });
  it('refuses invalid download receipts and unsafe cached special files',async()=>{
    const t=await setup(),api=downloader();
    await expect(cacheContentResources(t.path,'<img token="I"/>',undefined,{download:async()=>({path:join(t.folder,'other.png')})})).rejects.toMatchObject({code:'RESOURCE_DOWNLOAD'});
    await expect(cacheContentResources(t.path,'<img token="I"/>',undefined,{download:async input=>{await mkdir(input.outputPath);return {path:input.outputPath};}})).rejects.toMatchObject({code:'INVALID_PATH'});
    execFileSync('mkfifo',[join(t.folder,'cache.png')]);
    await expect(cacheContentResources(t.path,'<img token="I"/>',{version:1,items:[{tag:'img',attribute:'token',value:'I',path:'cache.png',representation:'original'}]},api)).rejects.toMatchObject({code:'INVALID_PATH'});
    expect(api.download).not.toHaveBeenCalled();
  });
  it('does not relabel an unsupported attachment src as an official token selector',async()=>{
    const t=await setup(),api=downloader(),result=await cacheContentResources(t.path,'<source src="unknown"/>',undefined,api);
    expect(result.resources.items).toEqual([]);expect(result.warnings).toHaveLength(1);expect(api.download).not.toHaveBeenCalled();
  });
  it('uses visible Obsidian resource directories and refreshes previously hidden media without replacing it',async()=>{
    const t=await setup();await mkdir(join(t.folder,'.review-assets-old'));await writeFile(join(t.folder,'.review-assets-old','photo.png'),png);
    const previous:ResourceManifest={version:1,items:[{tag:'img',attribute:'token',value:'image',path:'.review-assets-old/photo.png',representation:'original'}]},api=downloader();
    const result=await cacheContentResources(t.path,'<img token="image"/>',previous,api,{directoryPrefix:'feishu-assets-'});
    expect(api.download).toHaveBeenCalledTimes(1);expect(result.resources.items[0].path).toMatch(/^feishu-assets-[^/]+\//);
    expect(await readFile(join(t.folder,'.review-assets-old','photo.png'))).toEqual(png);
    await cacheContentResources(t.path,'<img token="image"/>',result.resources,api,{directoryPrefix:'feishu-assets-'});expect(api.download).toHaveBeenCalledTimes(1);
    await expect(cacheContentResources(t.path,'<img token="image"/>',undefined,api,{directoryPrefix:'../escape-' as 'feishu-assets-'})).rejects.toMatchObject({code:'INVALID_PATH'});
  });
});
