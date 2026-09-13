import {describe,it,expect,vi} from 'vitest';
import {ManagedCLIRunner,validateProfile} from '../src/runner';
import {withSyncLease,SYNC_EVENT} from '../src/bridge';
import type {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
const fakeChild=()=>Object.assign(new EventEmitter(),{kill:vi.fn(()=>true),stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
describe('editor lease',()=>{
  it('requires the enabled base plugin before entering sync',async()=>{const run=vi.fn();await expect(withSyncLease({trigger:vi.fn()},'article.xml',run)).rejects.toThrow('基础插件');expect(run).not.toHaveBeenCalled();});
  it('waits for local save and releases after success',async()=>{const order:string[]=[];const workspace={trigger:(name:string,...args:unknown[])=>{expect(name).toBe(SYNC_EVENT);const request=args[0] as {path:string;acquire:(lease:Promise<{release:()=>Promise<void>}>)=>void};expect(request.path).toBe('article.xml');request.acquire(Promise.resolve().then(()=>{order.push('saved');return {release:async()=>{order.push('reload');}};}));}};await withSyncLease(workspace,'article.xml',async()=>{order.push('cloud');});expect(order).toEqual(['saved','cloud','reload']);});
  it('releases lock after a failed operation and never runs on invalid editor drafts',async()=>{const release=vi.fn(async()=>{});const workspace={trigger:(_name:string,...args:unknown[])=>(args[0] as any).acquire(Promise.resolve({release}))};await expect(withSyncLease(workspace,'draft.xml',async()=>{throw new Error('conflict');})).rejects.toThrow('conflict');expect(release).toHaveBeenCalledOnce();const run=vi.fn();await expect(withSyncLease({trigger:(_name,...args)=>(args[0] as any).acquire(Promise.reject(new Error('源码无效')))},'draft.xml',run)).rejects.toThrow('源码无效');expect(run).not.toHaveBeenCalled();});
});
describe('trusted CLI process lifecycle',()=>{
  it('passes only an explicit host working directory and preserves the default spawn behavior',async()=>{
    for(const cwd of [undefined,'/trusted/vault with spaces']){
      const child=fakeChild(),execute=vi.fn((_command:string,_args:string[],_options:{cwd?:string})=>{queueMicrotask(()=>child.emit('close',0));return child;});
      const runner=new ManagedCLIRunner(execute as unknown as typeof spawn,cwd===undefined?{}:{cwd});
      await runner.run('/configured/lark-cli',['docs','+fetch']);
      const options=execute.mock.calls[0][2] as {cwd?:string};
      if(cwd===undefined)expect(options).not.toHaveProperty('cwd');else expect(options.cwd).toBe(cwd);
    }
  });
  it.each(['relative/vault','/vault\0invalid'])('rejects an invalid host working directory before spawning',async cwd=>{
    const execute=vi.fn(),runner=new ManagedCLIRunner(execute as unknown as typeof spawn,{cwd});
    await expect(runner.run('/configured/lark-cli',[])).rejects.toThrow('仓库绝对路径');expect(execute).not.toHaveBeenCalled();
  });
  it('validates explicit executable and fixed args without shell interpolation',()=>{expect(validateProfile({command:'/opt/local/lark-cli',args:['--profile','test with spaces']})).toEqual({command:'/opt/local/lark-cli',args:['--profile','test with spaces']});expect(()=>validateProfile({command:'lark-cli',args:[]})).toThrow('绝对路径');expect(()=>validateProfile({command:'/bin/cli',args:['bad\0value']})).toThrow();});
  it('spawns nothing at construction and rejects immediately on unload',async()=>{const child=fakeChild();const execute=vi.fn((_command,_args,options)=>{expect(options.shell).toBe(false);return child;});const runner=new ManagedCLIRunner(execute as unknown as typeof spawn);expect(execute).not.toHaveBeenCalled();const pending=runner.run('/configured/lark-cli',['docs','+fetch']);runner.dispose();expect(child.kill).toHaveBeenCalledWith('SIGKILL');await expect(pending).rejects.toThrow('停止');await expect(runner.run('/configured/lark-cli',[])).rejects.toThrow('已卸载');expect(execute).toHaveBeenCalledOnce();});
  it('does not expose process argv or raw stderr through the error message',async()=>{const child=fakeChild();const execute=vi.fn(()=>{queueMicrotask(()=>{child.stdout.write('private stdout');child.stderr.write('private stderr');child.emit('exit',1);child.emit('close',1);});return child;});const runner=new ManagedCLIRunner(execute as unknown as typeof spawn);try{await runner.run('/configured/lark-cli',[]);throw new Error('expected failure');}catch(error){expect((error as Error).message).not.toContain('private');expect(JSON.stringify(error)).not.toContain('private');}});
});

it('retains uncertain-write context if releasing the editor also fails',async()=>{await expect(withSyncLease({trigger:(_name,...args)=>(args[0] as any).acquire(Promise.resolve({release:async()=>{throw new Error('回读失败');}}))},'draft.xml',async()=>{throw new Error('发布未确认');})).rejects.toThrow('发布未确认；重新读取本地编辑器失败：回读失败');});
