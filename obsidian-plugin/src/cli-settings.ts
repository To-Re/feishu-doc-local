import { readPreferences, validatePreferences, type Preferences } from '../../obsidian-sync-plugin/src/preferences';

export interface SettingsFiles {
  exists(path:string):Promise<boolean>;
  read(path:string):Promise<string>;
  write(path:string,text:string):Promise<void>;
  mkdir(path:string):Promise<void>;
}

/** CLI settings never share the draft store's data.json write path. */
export class CLISettingsStore {
  readonly directory:string;
  readonly path:string;
  constructor(private files:SettingsFiles,private configDir:string) {
    this.directory=`${configDir}/plugins/feishu-doc-local`;
    this.path=`${this.directory}/cli-settings.json`;
  }
  async load():Promise<Preferences> {
    if(await this.files.exists(this.path))return readPreferences(JSON.parse(await this.files.read(this.path)));
    const legacy=`${this.configDir}/plugins/feishu-doc-local-sync/data.json`;
    if(!await this.files.exists(legacy))return readPreferences(null);
    const raw=await this.files.read(legacy),value=readPreferences(JSON.parse(raw));
    // Finish recoverable copies before creating the new canonical config.
    const backup=`${this.directory}/migration-${crypto.randomUUID()}`;
    await this.files.mkdir(backup);
    await this.files.write(`${backup}/legacy-sync-data.json`,raw);
    const drafts=`${this.directory}/data.json`;
    if(await this.files.exists(drafts))await this.files.write(`${backup}/editor-data.json`,await this.files.read(drafts));
    // A concurrent initialization may already have migrated; never replace it.
    if(await this.files.exists(this.path))return readPreferences(JSON.parse(await this.files.read(this.path)));
    await this.files.write(this.path,JSON.stringify(value,null,2));
    return value;
  }
  async save(value:Preferences):Promise<void> {
    const checked=validatePreferences(value,true);
    await this.files.write(this.path,JSON.stringify(checked,null,2));
  }
  async legacyEnabled():Promise<boolean> {
    const path=`${this.configDir}/community-plugins.json`;
    if(!await this.files.exists(path))return false;
    const value:unknown=JSON.parse(await this.files.read(path));
    if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new Error('插件启用列表无法读取，未启动重复的同步组件。');
    return value.includes('feishu-doc-local-sync');
  }
}
