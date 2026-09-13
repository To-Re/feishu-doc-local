export const modals:Modal[]=[];
export function prepareDOM(){
  const proto=HTMLElement.prototype as any;
  proto.empty=function(){this.replaceChildren();};proto.addClass=function(...names:string[]){this.classList.add(...names);};
  proto.createEl=function(tag:string,options:any={}){const element=document.createElement(tag);if(options.text)element.textContent=options.text;if(options.cls)element.className=options.cls;if(options.href)element.setAttribute('href',options.href);for(const [key,value]of Object.entries(options.attr||{}))element.setAttribute(key,String(value));this.append(element);return element;};
  proto.createDiv=function(options:any={}){return this.createEl('div',typeof options==='string'?{cls:options}:options);};
}
export class TFile {extension='xml';path='article.xml';basename='article';}
export class FileSystemAdapter {getBasePath(){return '/vault';}}
export class Plugin {app:any;commands:any[]=[];constructor(app:any){this.app=app;}async loadData(){return null;}async saveData(_value:unknown){}addCommand(value:any){this.commands.push(value);}registerEvent(_event:unknown){}addSettingTab(_value:unknown){}}
export class Modal {modalEl:HTMLElement;contentEl:HTMLElement;constructor(public app:any){this.modalEl=document.createElement('div');this.contentEl=this.modalEl.appendChild(document.createElement('div'));}open(){modals.push(this);document.body.append(this.modalEl);(this as any).onOpen?.();}close(){(this as any).onClose?.();this.modalEl.remove();const index=modals.indexOf(this);if(index>=0)modals.splice(index,1);}}
export class FuzzySuggestModal<T> extends Modal {setPlaceholder(_value:string){}}
export class PluginSettingTab {containerEl=document.createElement('div');constructor(public app:any,_plugin:unknown){}}
export class Setting {private element:HTMLElement;private name='';constructor(container:HTMLElement){this.element=container.appendChild(document.createElement('div'));}setName(value:string){this.name=value;this.element.appendChild(document.createElement('label')).textContent=value;return this;}setDesc(_value:string){return this;}addText(action:any){const input=this.element.appendChild(document.createElement('input'));input.setAttribute('aria-label',this.name);const api={setPlaceholder:(value:string)=>{input.placeholder=value;return api;},setValue:(value:string)=>{input.value=value;return api;},onChange:(callback:any)=>{input.oninput=()=>callback(input.value);return api;}};action(api);return this;}addButton(action:any){const button=this.element.appendChild(document.createElement('button'));const api={setButtonText:(value:string)=>{button.textContent=value;return api;},setCta:()=>api,onClick:(callback:any)=>{button.onclick=callback;return api;}};action(api);return this;}}

export class Notice {constructor(public message:string){}}
