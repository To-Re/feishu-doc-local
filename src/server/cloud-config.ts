import { readFile, realpath, stat } from 'node:fs/promises';
import { createCloudCLI } from './cloud-cli';
import type { CloudCLIOptions } from '../core/cloud-types';
import type { CloudConnection } from './cloud-sync';

export async function loadCLIProfile(path:string):Promise<{command:string;args:string[]}>{
  try{
    const info=await stat(path);if(!info.isFile()||info.size>65536)throw new Error();
    const value=JSON.parse(await readFile(path,'utf8'));
    if(!value||typeof value.command!=='string'||!value.command.trim()||value.command.length>4096||value.command.includes('\0')||
      !Array.isArray(value.args)||value.args.length>100||value.args.some((arg:unknown)=>typeof arg!=='string'||arg.length>8192||arg.includes('\0'))||
      Object.keys(value).some(key=>!['command','args','documentId','url'].includes(key)))throw new Error();
    return {command:value.command,args:[...value.args]};
  }catch{throw new Error('本机 CLI 配置无效：需要 command 和 args，不从浏览器接受可执行命令。');}
}

/** Local operator configuration only. It is never accepted from an HTTP request or article. */
export async function loadCloudConnection(path:string,localPath:string):Promise<CloudConnection> {
  let options:CloudCLIOptions;
  try {
    const info=await stat(path);
    if(!info.isFile()||info.size>65536)throw new Error();
    options=JSON.parse(await readFile(path,'utf8'));
    if(!options||typeof options.command!=='string'||!options.command.trim()||options.command.length>4096||
      !Array.isArray(options.args)||options.args.length>100||options.args.some(arg=>typeof arg!=='string'||arg.length>8192)||
      typeof options.url!=='string'||typeof options.documentId!=='string'||
      !/^[A-Za-z0-9_-]{1,512}$/.test(options.documentId)||
      Object.keys(options).some(key=>!['command','args','documentId','url'].includes(key)))throw new Error();
    const url=new URL(options.url);
    if(url.protocol!=='https:'||url.username||url.password||url.port||
      !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)||
      !/^\/(docx|wiki)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)||url.search||url.hash)throw new Error();
    if(url.pathname.startsWith('/docx/')&&url.pathname.split('/')[2]!==options.documentId)throw new Error();
  } catch { throw new Error('飞书关联配置无效：需要本机 CLI command、args、documentId 和对应的 HTTPS 文档 url。'); }
  return {localPath:await realpath(localPath),documentId:options.documentId,url:options.url,transport:createCloudCLI(options)};
}
