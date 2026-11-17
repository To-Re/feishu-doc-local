import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({stat:vi.fn(),readFile:vi.fn(),register:vi.fn(()=>({dispose(){}})),commands:vi.fn(()=>({dispose(){}}))}));
vi.mock('vscode',()=>({workspace:{fs:mock},FileType:{File:1,Directory:2,SymbolicLink:64},Uri:{joinPath:(uri:any,path:string)=>({...uri,path:uri.path+'/'+path})},window:{registerCustomEditorProvider:mock.register},commands:{registerCommand:mock.commands}}));
import { activate,readSafe } from '../src/extension';
const root={scheme:'file',authority:'',path:'/fixture'},uri=(path='/fixture/a.png',scheme='file')=>({scheme,authority:'',path}) as any;
beforeEach(()=>{vi.clearAllMocks();mock.stat.mockResolvedValue({type:1,size:3,mtime:1});mock.readFile.mockResolvedValue(new Uint8Array([1,2,3]));});
describe('host read boundaries',()=>{
 it('uses readonly providers without a save lifecycle',()=>{activate({subscriptions:[],extensionUri:uri()} as any);expect(mock.register).toHaveBeenCalledTimes(2);const reader:any=mock.register.mock.calls[0][1];expect(reader.saveCustomDocument).toBeUndefined();expect(reader.saveCustomDocumentAs).toBeUndefined();});
 it('reads a local file and a remote workspace file with the same filesystem API',async()=>{expect(await readSafe(uri(),10,root as any)).toHaveLength(3);expect(await readSafe(uri('/fixture/a.png','vscode-remote'),10,{...root,scheme:'vscode-remote'} as any)).toHaveLength(3);});
 it.each([uri('/outside/a.png'),uri('/fixture/a.png','https'),{...uri(),authority:'elsewhere'}])('rejects roots and schemes before accessing disk',async target=>{await expect(readSafe(target,10,root as any)).rejects.toThrow();expect(mock.readFile).not.toHaveBeenCalled();});
 it('refuses linked resource folders, oversized files, and changed files',async()=>{
  mock.stat.mockResolvedValueOnce({type:66,size:0,mtime:1});await expect(readSafe(uri('/fixture/link/a.png'),10,root as any)).rejects.toThrow('符号链接');expect(mock.readFile).not.toHaveBeenCalled();
  mock.stat.mockResolvedValueOnce({type:1,size:11,mtime:1});await expect(readSafe(uri(),10)).rejects.toThrow('大小');
  mock.stat.mockResolvedValueOnce({type:1,size:3,mtime:1}).mockResolvedValueOnce({type:1,size:3,mtime:2});await expect(readSafe(uri(),10)).rejects.toThrow('已改变');
 });
});
