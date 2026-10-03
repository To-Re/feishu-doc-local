// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { Editor } from '@tiptap/core';
import { parseDocxXML } from '../src/core/docxml';
import { resolveResource } from '../src/core/resources';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { captureAnchor } from '../src/core/anchors';

const editors:Editor[]=[];
const originalCreate=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),originalRevoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
beforeEach(()=>{
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:local-text')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
});
afterEach(()=>{
  editors.splice(0).forEach(editor=>editor.destroy());
  vi.restoreAllMocks();
  for(const [name,descriptor]of [['createObjectURL',originalCreate],['revokeObjectURL',originalRevoke]] as const){if(descriptor)Object.defineProperty(URL,name,descriptor);else Reflect.deleteProperty(URL,name);}
});
function open(xml:string,load:(path:string,signal:AbortSignal)=>Promise<string>=async()=> 'local text'){
  const parsed=parseDocxXML(xml),manifest={version:1,items:[{tag:'source',attribute:'token',value:'note',path:'media/note.md',representation:'original'},{tag:'source',attribute:'token',value:'video',path:'media/demo.mp4',representation:'original'}]};
  const editor=new Editor({element:document.createElement('div'),content:parsed.content,extensions:xmlExtensions(path=>'blob:'+path,(tag,attrs)=>resolveResource(manifest,tag,attrs),load)});
  editors.push(editor);return{editor,parsed,dom:editor.view.dom};
}
describe('readable local attachments',()=>{
  it('previews Markdown as inert text and MP4 with controls, retaining exact XML and comment positions',async()=>{
    const xml='<figure view-type="Preview"><source token="note" name="note.md" mime="text/markdown"/></figure><figure view-type="Preview"><source token="video" name="demo.mp4" mime="video/mp4"/></figure><p>尾文</p>';
    const load=vi.fn(async()=> '# 标题\n<script>never execute</script>'),{editor,parsed,dom}=open(xml,load);
    editor.commands.setNodeSelection(0);const anchor=captureAnchor(editor.state.doc,0,1),selection=editor.state.selection;
    await waitFor(()=>expect(dom.querySelector('pre')?.textContent).toContain('<script>never execute</script>'));
    expect(dom.querySelector('script,iframe,object,embed')).toBeNull();expect(load).toHaveBeenCalledWith('media/note.md',expect.any(AbortSignal));
    expect(dom.querySelector('video')?.getAttribute('src')).toBe('blob:media/demo.mp4');
    expect(dom.querySelector('video')?.controls).toBe(true);expect(dom.querySelector('video')?.autoplay).toBe(false);
    expect(parsed.serialize(editor.getJSON())).toBe(xml);expect(editor.state.selection).toBe(selection);expect(captureAnchor(editor.state.doc,0,1)).toEqual(anchor);
  });
  it('distinguishes missing source files from unsupported formats without loading remote tokens',()=>{
    const load=vi.fn(),{dom}=open('<source token="missing" name="runbook.md" mime="text/markdown"/><source token="missing2" name="screen.mp4" mime="video/mp4"/><source path="@code.html" name="code.html" mime="text/html"/><source path="@https://example.com/a.mp4"/>',load);
    expect(dom.textContent).toContain('附件未下载到本地');expect(dom.textContent).toContain('此附件暂不支持本地预览');
    expect(load).not.toHaveBeenCalled();expect(dom.querySelector('video,iframe,script,img')).toBeNull();
  });
  it('loads card text only after expansion and cancels reads when the editor is destroyed',async()=>{
    let finish!:(value:string)=>void;const load=vi.fn((_path:string,_signal:AbortSignal)=>new Promise<string>(resolve=>{finish=resolve;}));
    const {dom,editor}=open('<figure view-type="Card"><source token="note" name="note.md"/></figure>',load);
    expect(load).not.toHaveBeenCalled();dom.querySelector('button')!.click();expect(load).toHaveBeenCalledTimes(1);
    const signal=load.mock.calls[0][1];editor.destroy();expect(signal.aborted).toBe(true);finish('late text');await Promise.resolve();expect(dom.querySelector('pre')).toBeNull();
  });
  it('reports read failure and does not replace the XML with an error message',async()=>{
    const xml='<source token="note" name="note.md"/>';
    const {dom,editor,parsed}=open(xml,async()=>{throw new Error('missing');});
    await waitFor(()=>expect(dom.textContent).toContain('附件文件缺失或不可读取'));
    expect(parsed.serialize(editor.getJSON())).toBe(xml);
  });
});
