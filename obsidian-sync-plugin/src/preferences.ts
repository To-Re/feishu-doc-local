import {homedir} from 'node:os';
import {isAbsolute,resolve} from 'node:path';
import {validateProfile,type CLIProfile} from './runner';
export interface Preferences extends CLIProfile {catalogPath:string;nodePath?:string;}
export const defaultPreferences=():Preferences=>({command:'',args:[],catalogPath:resolve(homedir(),'.lark-review/projects.json')});
export function validatePreferences(value:Preferences,allowUnconfigured=false):Preferences{
  const profile=validateProfile({...value,command:allowUnconfigured&&value.command===''?'/unconfigured-cli':value.command});
  if(typeof value.catalogPath!=='string'||!isAbsolute(value.catalogPath)||!value.catalogPath.endsWith('.json')||value.catalogPath.length>4096||/[\u0000-\u001f\u007f]/.test(value.catalogPath))throw new Error('项目配置文件需要有效的绝对 JSON 路径。');
  if(value.nodePath!==undefined&&(typeof value.nodePath!=='string'||(value.nodePath!==''&&(!isAbsolute(value.nodePath)||value.nodePath.length>4096||/[\u0000-\u001f\u007f]/.test(value.nodePath)))))throw new Error('Node 可执行文件需要有效的绝对路径，原生 CLI 可留空。');
  return {command:value.command,args:profile.args,catalogPath:value.catalogPath,...(value.nodePath?{nodePath:value.nodePath}:{})};
}
/** Stored data is configuration, never executable document data or permissive partial defaults. */
export function readPreferences(value:unknown):Preferences{
  if(value===null||value===undefined)return defaultPreferences();
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['command','args','catalogPath','nodePath'].includes(key)))throw new Error('保存的同步配置格式无效，原配置未改动；请在插件设置中重新保存。');
  try{return validatePreferences(value as Preferences,true);}catch{throw new Error('保存的同步配置无效，原配置未改动；请在插件设置中重新保存。');}
}
