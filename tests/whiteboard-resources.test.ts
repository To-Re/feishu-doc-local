// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { Editor } from '@tiptap/core';
import { parseDocxXML } from '../src/core/docxml';
import { isResourceMapping, resolveResource, RESOURCE_REFRESH, type ResourceTextLoader } from '../src/core/resources';
import type { ResourceManifest, ResourceMapping } from '../src/core/types';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { readWhiteboardResource } from '../src/ui/Reader';

const entry: ResourceMapping = {tag:'whiteboard',attribute:'token',value:'example-board',path:'previews/board.svg',representation:'preview'};
const safeSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="130" viewBox="0 35 680 130"><rect x="20" y="55" width="175" height="90" fill="#e8f0fe"/><text x="30" y="90">图源文字</text></svg>';
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); vi.unstubAllGlobals(); });

function open(xml: string, load: ResourceTextLoader, entries: ResourceMapping[] = [entry]) {
  let manifest: ResourceManifest = {version:1,items:entries};
  const adapter = parseDocxXML(xml);
  const assets: string[] = [];
  const editor = new Editor({element:document.createElement('div'),content:adapter.content,
    extensions:xmlExtensions(path => {assets.push(path);return '/api/asset?path='+encodeURIComponent(path);},
      (tag,attrs) => resolveResource(manifest,tag,attrs),load)});
  editors.push(editor);
  return {editor,adapter,assets,refresh(items:ResourceMapping[]) {manifest={version:1,items};editor.view.dispatch(editor.state.tr.setMeta(RESOURCE_REFRESH,true));}};
}

describe('cached cloud whiteboard SVG', () => {
  it('requires exact whiteboard selectors and only permits SVG as a whiteboard preview', () => {
    for (const attribute of ['src','token','path'] as const) {
      const mapping = {...entry,attribute,value:attribute==='path'?'@./source.svg':'example-board'};
      expect(isResourceMapping(mapping)).toBe(true);
      expect(resolveResource({version:1,items:[mapping]},'whiteboard',{[attribute]:mapping.value})).toEqual(mapping);
      expect(resolveResource({version:1,items:[mapping]},'whiteboard',{id:mapping.value})).toBeUndefined();
    }
    for (const invalid of [
      {...entry,tag:'img',representation:'original'}, {...entry,representation:'original'},
      {...entry,attribute:'id'}, {...entry,path:'https://example.com/board.svg'},
      {...entry,path:'../board.svg'}, {...entry,path:'/board.svg'}, {...entry,path:'previews/board.html'},
    ]) expect(isResourceMapping(invalid)).toBe(false);
    expect(resolveResource({version:1,items:[entry,entry]},'whiteboard',{token:entry.value})).toBeUndefined();
  });

  it('sanitizes cached SVG, keeps the service viewBox and never inserts it as an image URL or changes XML', async () => {
    const xml = '<whiteboard token="example-board"/><p>原文</p>';
    const load = vi.fn(async () => safeSVG.replace('<rect ', '<script>alert(1)</script><image href="https://example.com/pixel"/><rect onload="bad()" '));
    const {editor,adapter,assets} = open(xml,load);
    const doc = editor.state.doc;
    await waitFor(() => expect(editor.view.dom.querySelector('svg')).not.toBeNull());
    const svg = editor.view.dom.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 35 680 130');
    expect(svg.querySelector('script,image,iframe,foreignObject')).toBeNull();
    expect(svg.querySelector('rect')?.hasAttribute('onload')).toBe(false);
    expect(svg.textContent).toContain('图源文字');
    expect(svg.getAttribute('aria-label')).toContain('云端');
    expect(load).toHaveBeenCalledWith(entry.path,expect.any(AbortSignal));
    expect(assets).toEqual([]); expect(editor.view.dom.querySelector('img')).toBeNull();
    expect(editor.state.doc).toBe(doc); expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('uses cached cloud layout for returned diagram sources, while inline SVG remains authoritative', async () => {
    for (const type of ['mermaid','plantuml']) {
      const xml = `<whiteboard type="${type}" token="example-board"><![CDATA[unchanged diagram source]]></whiteboard>`;
      const load = vi.fn(async () => safeSVG);
      const {editor,adapter} = open(xml,load);
      await waitFor(() => expect(editor.view.dom.querySelector('svg')).not.toBeNull());
      expect(load).toHaveBeenCalledTimes(1); expect(adapter.serialize(editor.getJSON())).toBe(xml);
    }
    const load = vi.fn(async () => {throw new Error('must not load');});
    const {editor} = open('<whiteboard type="svg" token="example-board">'+safeSVG+'</whiteboard>',load);
    await waitFor(() => expect(editor.view.dom.querySelector('svg')).not.toBeNull());
    expect(load).not.toHaveBeenCalled();
  });

  it('displays a cached raster for returned PlantUML source without losing that source or editor history', () => {
    const xml='<whiteboard id="board-block" token="example-board" type="plantuml">@startuml\nactor 人类\n人类 -&gt; AI: 评审\n@enduml</whiteboard><p>后文</p>';
    const mapping:ResourceMapping={...entry,path:'previews/board.jpg'};
    const load=vi.fn(async()=>{throw new Error('raster previews must not use the text loader');});
    const {editor,adapter,assets}=open(xml,load,[mapping]);
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('/api/asset?path=previews%2Fboard.jpg');
    expect(editor.view.dom.querySelector('img')?.alt).toBe('白板预览（本地缓存）');
    expect(editor.view.dom.textContent).not.toContain('暂不支持');
    expect(assets).toEqual([mapping.path]);expect(load).not.toHaveBeenCalled();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    editor.commands.insertContentAt(editor.state.doc.content.size-1,'修改');
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('后文','后文修改'));
    editor.commands.undo();expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('requires an exact raster selector for unsupported source types and reports absent or failed cache', () => {
    const xml='<whiteboard token="example-board" type="plantuml"><![CDATA[@startuml\nA -> B: hello\n@enduml]]></whiteboard>';
    const load=vi.fn(async()=>safeSVG),mapping:ResourceMapping={...entry,path:'previews/board.png'};
    for(const entries of [[],[{...mapping,value:'another-board'}],[mapping,mapping]]){
      const missing=open(xml,load,entries);
      expect(missing.editor.view.dom.querySelector('img')).toBeNull();
      expect(missing.editor.view.dom.textContent).toContain('暂不支持 plantuml');
      expect(missing.assets).toEqual([]);expect(missing.adapter.serialize(missing.editor.getJSON())).toBe(xml);
    }
    const cached=open(xml,load,[mapping]);cached.editor.view.dom.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(cached.editor.view.dom.querySelector('img')).toBeNull();expect(cached.editor.view.dom.textContent).toContain('缓存不可用');
    expect(cached.adapter.serialize(cached.editor.getJSON())).toBe(xml);expect(load).not.toHaveBeenCalled();
  });

  it('refreshes a returned unsupported diagram raster without changing its selection or source', () => {
    const xml='<whiteboard token="example-board" type="custom-diagram">original source</whiteboard>';
    const {editor,adapter,refresh}=open(xml,async()=>safeSVG,[]);
    editor.commands.setNodeSelection(0);const doc=editor.state.doc,selection=editor.state.selection;
    refresh([{...entry,path:'previews/board.webp'}]);
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toContain('board.webp');
    expect(editor.state.doc).toBe(doc);expect(editor.state.selection).toBe(selection);expect(adapter.serialize(editor.getJSON())).toBe(xml);
    refresh([]);expect(editor.view.dom.querySelector('img')).toBeNull();expect(editor.view.dom.textContent).toContain('暂不支持 custom-diagram');
  });

  it('cancels superseded loads and preserves selection/history across resource refresh', async () => {
    let complete!: (value:string) => void;
    const load = vi.fn((_path:string,signal:AbortSignal) => new Promise<string>(resolve => {complete=resolve; void signal;}));
    const xml = '<whiteboard token="example-board"/><p>原文</p>';
    const {editor,adapter,refresh} = open(xml,load);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const signal = load.mock.calls[0][1];
    editor.commands.insertContentAt(editor.state.doc.content.size-1,'修改');
    const doc = editor.state.doc, selection = editor.state.selection;
    refresh([]);
    expect(signal.aborted).toBe(true);
    complete(safeSVG);
    await Promise.resolve(); await Promise.resolve();
    expect(editor.view.dom.querySelector('svg')).toBeNull();
    expect(editor.state.doc).toBe(doc); expect(editor.state.selection).toBe(selection);
    expect(editor.can().undo()).toBe(true); editor.commands.undo();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('keeps missing or invalid SVG cache errors outside the source document and never previews SVG attachments', async () => {
    const xml = '<whiteboard token="example-board"/>';
    const {editor,adapter} = open(xml,async () => '<!DOCTYPE svg><svg/>');
    await waitFor(() => expect(editor.view.dom.textContent).toContain('缓存不可用'));
    expect(editor.view.dom.querySelector('svg')).toBeNull(); expect(adapter.serialize(editor.getJSON())).toBe(xml);
    const load = vi.fn(async () => safeSVG);
    const attachment = open('<figure view-type="Preview"><source token="example-board" name="附件.svg"/></figure>',load,
      [{tag:'source',attribute:'token',value:'example-board',path:'previews/board.svg',representation:'original'}]);
    expect(attachment.editor.view.dom.querySelector('svg,img,iframe')).toBeNull(); expect(load).not.toHaveBeenCalled();
  });

  it('loads inert text only through the current same-origin document resource endpoint', async () => {
    const fetch = vi.fn(async () => ({ok:true,json:async () => ({path:entry.path,text:safeSVG})})); vi.stubGlobal('fetch',fetch);
    const signal = new AbortController().signal;
    const assetURL = (path:string) => '/api/asset?id=current-document&path='+encodeURIComponent(path);
    expect(await readWhiteboardResource(assetURL,entry.path,signal)).toBe(safeSVG);
    expect(fetch).toHaveBeenCalledWith('/api/resource?id=current-document&path=previews%2Fboard.svg',{signal,redirect:'error'});
    fetch.mockClear();
    for (const url of ['https://example.com/api/asset?id=current-document&path=previews%2Fboard.svg','/api/asset?path=previews%2Fboard.svg','/api/asset?id=current-document&path=wrong.svg','/api/resource?id=current-document&path=previews%2Fboard.svg']) {
      await expect(readWhiteboardResource(() => url,entry.path,signal)).rejects.toThrow();
    }
    await expect(readWhiteboardResource(assetURL,'../board.svg',signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementation(async () => ({ok:true,json:async () => ({path:'wrong.svg',text:safeSVG})}));
    await expect(readWhiteboardResource(assetURL,entry.path,signal)).rejects.toThrow('不匹配');
  });
});
