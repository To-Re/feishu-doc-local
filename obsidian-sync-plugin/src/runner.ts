import {spawn,type ChildProcess} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ContentCLIError,type ContentCLIRunner,type ContentCLIReceipt} from '../../src/server/content-cli';
export interface CLIProfile {command:string;args:string[];}
export function validateProfile(value:CLIProfile):CLIProfile {
  if(!value||typeof value.command!=='string'||value.command.length>4096||!isAbsolute(value.command)||/[\0\r\n]/.test(value.command)||!Array.isArray(value.args)||value.args.length>32||value.args.some(arg=>typeof arg!=='string'||arg.length>4096||/[\0\r\n]/.test(arg)))throw new Error('请在插件设置中填写 CLI 可执行文件绝对路径，以及 JSON 格式的固定参数数组。');
  return {command:value.command,args:[...value.args]};
}
export interface RunnerOptions {
  nodePath?:string;timeoutMs?:number;maxBuffer?:number;env?:NodeJS.ProcessEnv;
  /** Trusted vault root supplied by the desktop host, never document or CLI data. */
  cwd?:string;
}
interface RunningCLI {child:ChildProcess;abort:(reason:string,code?:string)=>void;}
/** This runner is non-interactive. Login is a separate user-controlled flow. */
export class ManagedCLIRunner {
  private children=new Set<RunningCLI>();private disposed=false;
  constructor(private readonly execute:typeof spawn=spawn,private readonly options:RunnerOptions={}){}
  readonly run:ContentCLIRunner=(command,args)=>new Promise<ContentCLIReceipt>((resolve,reject)=>{
    if(this.disposed){reject(new Error('飞书同步扩展已卸载，未执行命令。'));return;}
    if(this.options.cwd!==undefined&&(typeof this.options.cwd!=='string'||!isAbsolute(this.options.cwd)||/[\0\r\n]/.test(this.options.cwd))){reject(new Error('CLI 工作目录必须是宿主提供的仓库绝对路径。'));return;}
    let settled=false,job:RunningCLI|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0;
    const finish=(error:Error|null,receipt?:ContentCLIReceipt)=>{
      if(settled)return;settled=true;if(timer)clearTimeout(timer);if(job)this.children.delete(job);
      if(error)reject(error);else resolve(receipt!);
    };
    const env={...(this.options.env??process.env)};delete env.NODE_OPTIONS;delete env.NODE_PATH;
    const program=this.options.nodePath||command,parameters=this.options.nodePath?[command,...args]:[...args];
    try{
      const child=this.execute(program,parameters,{shell:false,detached:process.platform!=='win32',env,...(this.options.cwd===undefined?{}:{cwd:this.options.cwd}),
        stdio:['pipe','pipe','pipe'],windowsHide:true});
      job={child,abort:(reason,code='ABORTED')=>{
        if(settled)return;const stopped=this.killTree(child);
        finish(new ContentCLIError(reason+(stopped?'':'；部分子进程未确认退出'),{stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exitCode:code}));
        child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
      }};
      this.children.add(job);
      const collect=(target:Buffer[],chunk:Buffer)=>{
        if(settled)return;bytes+=chunk.length;
        if(bytes>(this.options.maxBuffer??16*1024*1024)){job?.abort('CLI 输出超过上限；请核对本地待定记录，勿直接重复发布。','OUTPUT_LIMIT');return;}
        target.push(chunk);
      };
      child.stdout?.on('data',(chunk:Buffer)=>collect(stdout,chunk));child.stderr?.on('data',(chunk:Buffer)=>collect(stderr,chunk));
      child.stdout?.on('error',()=>job?.abort('CLI 输出读取失败；请核对本地待定记录。'));
      child.stderr?.on('error',()=>job?.abort('CLI 输出读取失败；请核对本地待定记录。'));
      child.stdin?.on('error',()=>job?.abort('CLI 输入通道失败；请核对本地待定记录。'));
      child.on('error',(error:NodeJS.ErrnoException)=>{
        if(settled)return;this.killTree(child);
        const message=error.code==='ENOENT'?'CLI 或 Node 无法启动；npm 版 CLI 请配置 Node 可执行文件绝对路径。':'CLI 进程启动失败；请检查 CLI 和可选 Node 的绝对路径。';
        finish(new ContentCLIError(message,{stdout:'',stderr:'',exitCode:error.code??null}));
      });
      child.on('exit',()=>{if(!settled&&!this.killTree(child))job?.abort('CLI 子进程未确认退出；请核对本地待定记录。');});
      child.on('close',(code:number|null)=>{
        if(settled)return;
        const receipt:ContentCLIReceipt={stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exitCode:code};
        if(code===0)finish(null,receipt);
        else{const missing=/env:.*node.*(?:No such file|not found)/i.test(receipt.stderr);
          finish(new ContentCLIError(missing?'CLI 或 Node 无法启动；npm 版 CLI 请配置 Node 可执行文件绝对路径。':'CLI 未确认成功；请检查已登录的官方 CLI 和本地待定记录。',receipt));}
      });
      // EOF prevents an unexpected TTY/password prompt from silently waiting for user input.
      child.stdin?.end();
      if(!settled)timer=setTimeout(()=>job?.abort('CLI 执行超时；请核对本地待定记录，勿直接重复发布。','TIMEOUT'),this.options.timeoutMs??120_000);
    }catch{finish(new Error('CLI 进程启动失败；请检查 CLI 和可选 Node 的绝对路径。'));}
  });
  private killTree(child:ChildProcess):boolean {
    // Each POSIX child owns its process group, including descendants created by npm wrappers.
    if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');return true;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}}
    try{const killed=child.kill('SIGKILL');return child.pid?killed:true;}catch{return !child.pid;}
  }
  dispose(){this.disposed=true;for(const job of [...this.children])job.abort('同步已停止；请检查本地待定记录，勿直接重复发布。');}
}
