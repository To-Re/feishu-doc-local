import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { parseDocxXML } from '../../src/core/docxml';
import { xmlExtensions } from '../../src/ui/xml-extensions';
import { resolvePreview, type ReviewData } from './document';

export interface RenderOptions {
  xml:string;
  review:ReviewData;
  imageURL(path:string):string;
  readSVG(path:string,signal:AbortSignal):Promise<string>;
}
/** Same parser, node views, sanitizers and diagrams as the web app. No source
 * serialization or filesystem mutation exists in the read-only plugin view. */
export function renderDocument(host:HTMLElement,options:RenderOptions) {
  const parsed=parseDocxXML(options.xml);
  const editor=new Editor({element:host,editable:false,injectCSS:false,
    extensions:[...xmlExtensions(options.imageURL,(tag,attrs)=>resolvePreview(options.review.resources,tag,attrs),options.readSVG),
      Extension.create({name:'obsidianReadOnly',addProseMirrorPlugins:()=>[new Plugin({filterTransaction:transaction=>!transaction.docChanged})]})],
    content:parsed.content,editorProps:{attributes:{class:'document-content',tabindex:'0','aria-label':'飞书文档正文','aria-readonly':'true'}}});
  return {editor,warnings:parsed.warnings,destroy:()=>editor.destroy()};
}
