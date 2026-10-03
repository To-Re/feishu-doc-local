import {describe,expect,it,vi} from 'vitest';
import {CLISettingsStore} from '../src/cli-settings';
const config={command:'/trusted/lark',args:['--config','local.json'],catalogPath:'/projects/index.json'};
const primary='.obsidian/plugins/feishu-doc-local',legacy='.obsidian/plugins/feishu-doc-local-sync/data.json';
function setup(){
  const files=new Map<string,string>([[legacy,JSON.stringify(config)],[`${primary}/data.json`,'{"version":1,"drafts":{"retained":{"private":"draft"}}}']]);
  const io={exists:async(path:string)=>files.has(path),read:async(path:string)=>{if(!files.has(path))throw new Error('missing');return files.get(path)!;},write:vi.fn(async(path:string,text:string)=>{files.set(path,text);}),mkdir:vi.fn(async()=>{})};
  return{files,io,store:new CLISettingsStore(io,'.obsidian')};
}
describe('CLI configuration migration independent of editor drafts',()=>{
  it('backs up both legacy settings and drafts, migrates once, and keeps later writes independent',async()=>{
    const {store,files,io}=setup(),drafts=files.get(`${primary}/data.json`),old=files.get(legacy);
    expect(await store.load()).toEqual(config);
    expect([...files.keys()].filter(p=>p.endsWith('/legacy-sync-data.json'))).toHaveLength(1);
    expect([...files.values()].filter(v=>v===drafts)).toHaveLength(2);
    const writes=io.write.mock.calls.length;expect(await store.load()).toEqual(config);expect(io.write).toHaveBeenCalledTimes(writes);
    await store.save({...config,command:''});
    expect(files.get(`${primary}/data.json`)).toBe(drafts);expect(files.get(legacy)).toBe(old);
    expect(await store.load()).toEqual({...config,command:''});
  });
  it('does not create canonical settings if backup fails and never overwrites malformed or existing settings',async()=>{
    const {store,files,io}=setup();io.write.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.load()).rejects.toThrow();expect(files.has(store.path)).toBe(false);
    files.set(store.path,'invalid settings');await expect(store.load()).rejects.toThrow();expect(files.get(store.path)).toBe('invalid settings');
    files.set(store.path,JSON.stringify({...config,command:'/new/cli'}));expect((await store.load()).command).toBe('/new/cli');
  });
  it('works in a Vault without legacy configuration and detects the enabled old plugin without changing its list',async()=>{
    const {store,files,io}=setup();files.delete(legacy);
    expect((await store.load()).command).toBe('');expect(io.write).not.toHaveBeenCalled();
    expect(await store.legacyEnabled()).toBe(false);
    files.set('.obsidian/community-plugins.json',JSON.stringify(['other','feishu-doc-local-sync','feishu-doc-local']));
    expect(await store.legacyEnabled()).toBe(true);expect(io.write).not.toHaveBeenCalled();
  });
});
