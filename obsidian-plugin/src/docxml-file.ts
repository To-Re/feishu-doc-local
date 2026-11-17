import type { TFile, Vault } from 'obsidian';
import { safeDraftPath } from './drafts';

const maximumXMLBytes=5_000_000;
import { assertDocxXML } from '../../src/core/document-kind';
export { assertDocxXML } from '../../src/core/document-kind';

/** Only inspect the selected vault file. No vault-wide content scan or sidecar
 * creation takes place while deciding whether this editor can open it. */
export async function readVaultXML(vault:Vault,file:TFile):Promise<string>{
  const path=file.path,config=vault.configDir;
  if(!safeDraftPath(path)||file.extension.toLowerCase()!=='xml'||(config&&(path===config||path.startsWith(config+'/'))))throw new Error('请选择库内的飞书 XML 文档，不读取 Obsidian 配置文件。');
  if(vault.getFileByPath(path)!==file)throw new Error('文档位置已改变，请重新选择。');
  const size=file.stat.size,mtime=file.stat.mtime;
  if(size>maximumXMLBytes)throw new Error('XML 超过 5 MB，未打开或修改。');
  const xml=await vault.read(file);
  if(file.path!==path||vault.getFileByPath(path)!==file||file.stat.size!==size||file.stat.mtime!==mtime)throw new Error('读取时文档已变化，请重新选择。');
  if(new TextEncoder().encode(xml).length>maximumXMLBytes)throw new Error('XML 超过 5 MB，未打开或修改。');
  return xml;
}

export async function assertDocxXMLFile(vault:Vault,file:TFile):Promise<void>{
  assertDocxXML(await readVaultXML(vault,file));
}
