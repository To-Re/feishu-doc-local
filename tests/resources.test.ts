// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { Editor } from '@tiptap/core';
import { parseDocxXML } from '../src/core/docxml';
import { resolveResource, RESOURCE_REFRESH } from '../src/core/resources';
import type { ResourceManifest, ResourceMapping } from '../src/core/types';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { captureAnchor, mapAnchor } from '../src/core/anchors';

const resources: ResourceManifest = { version: 1, items: [
  { tag: 'img', attribute: 'src', value: 'image-token', path: 'resources/image.png', representation: 'original' },
  { tag: 'whiteboard', attribute: 'token', value: 'board-token', path: 'resources/board.jpg', representation: 'preview' },
] };
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

function open(xml: string, manifest: ResourceManifest | undefined = resources) {
  const adapter = parseDocxXML(xml);
  const paths: string[] = [];
  let current: ResourceManifest | undefined = manifest;
  const editor = new Editor({
    element: document.createElement('div'), content: adapter.content,
    extensions: xmlExtensions(path => { paths.push(path); return `/api/asset?path=${encodeURIComponent(path)}`; }, (tag,attrs) => resolveResource(current,tag,attrs)),
  });
  editors.push(editor);
  return { editor, adapter, paths, refresh(next: ResourceManifest | undefined) { current = next; editor.view.dispatch(editor.state.tr.setMeta(RESOURCE_REFRESH,true)); } };
}

describe('exact, local-only resource mapping', () => {
  it('requires matching tag, attribute and value, without matching captions, ids or aliases', () => {
    expect(resolveResource(resources,'img',{src:'image-token'})).toEqual(resources.items[0]);
    expect(resolveResource(resources,'whiteboard',{token:'board-token'})).toEqual(resources.items[1]);
    for (const attrs of [{token:'image-token'}, {id:'image-token'}, {caption:'image-token'}, {src:'other-token'}]) expect(resolveResource(resources,'img',attrs)).toBeUndefined();
    expect(resolveResource(resources,'whiteboard',{src:'board-token'})).toBeUndefined();
    for (const tag of ['source','figure','sheet']) expect(resolveResource(resources,tag,{src:'image-token',token:'board-token'})).toBeUndefined();
  });

  it('refuses ambiguous mappings, unsafe paths, wrong representations and malformed manifests', () => {
    const entry = resources.items[0];
    expect(resolveResource({...resources,items:[entry,entry]},'img',{src:entry.value})).toBeUndefined();
    expect(resolveResource({...resources,items:[entry,{...entry,attribute:'token'}]},'img',{src:entry.value,token:entry.value})).toBeUndefined();
    for (const path of ['https://example.com/x.png','/outside.png','../outside.png','folder/../x.png','folder\\x.png','resources/image.svg','resources/image.html','x\0.png']) {
      expect(resolveResource({...resources,items:[{...entry,path}]},'img',{src:entry.value})).toBeUndefined();
    }
    expect(resolveResource({...resources,items:[{...entry,representation:'preview'}]},'img',{src:entry.value})).toBeUndefined();
    for (const manifest of [null,[],{version:2,items:resources.items},{version:1,items:null}]) expect(resolveResource(manifest,'img',{src:entry.value})).toBeUndefined();
  });

  it('renders cached original images and labeled whiteboard previews without mutating official XML', () => {
    const xml = '<img id="image-block" src="image-token" name="colors.png" caption="原图" width="720" height="180" scale="0.500000"/><whiteboard id="board-block" token="board-token"/><source token="image-token" name="附件.png"/><figure view-type="Preview"><source token="image-token" name="附件.png"/></figure><sheet token="board-token" sheet-id="tab"/><p>尾文</p>';
    const {editor,adapter,paths} = open(xml);
    const images = editor.view.dom.querySelectorAll('img');
    expect(paths).toEqual(['resources/image.png','resources/board.jpg']);
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('width')).toBe('360');
    expect(images[0].getAttribute('height')).toBe('90');
    expect(images[1].alt).toBe('白板预览（本地缓存）');
    expect(editor.view.dom.textContent).toContain('白板预览（本地缓存）');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    editor.commands.insertContentAt(editor.state.doc.content.size-1,'修改');
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('尾文','尾文修改'));
  });

  it('prefers returned inline SVG content over a cached whiteboard preview with the same token', async () => {
    const xml = '<whiteboard token="board-token" type="svg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="blue"/></svg></whiteboard>';
    const {editor,adapter,paths} = open(xml);
    await waitFor(() => expect(editor.view.dom.querySelector('.whiteboard-preview svg rect')).not.toBeNull());
    expect(paths).toEqual([]);
    expect(editor.view.dom.querySelector('img')).toBeNull();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('refreshes only displayed resources while preserving document positions, source XML and undo history', () => {
    const xml = '<img src="image-token"/><p>原文</p>';
    const {editor,adapter,refresh} = open(xml,{version:1,items:[]});
    expect(editor.view.dom.querySelector('img')).toBeNull();
    editor.commands.insertContentAt(2,'新');
    const doc = editor.state.doc;
    const selection = editor.state.selection;
    refresh(resources);
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toContain('resources%2Fimage.png');
    expect(editor.state.doc).toBe(doc);
    expect(editor.state.selection).toBe(selection);
    expect(editor.can().undo()).toBe(true);
    editor.commands.undo();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    refresh({version:1,items:[]});
    expect(editor.view.dom.querySelector('img')).toBeNull();
  });

  it('reports missing cache content as a local preview error without replacing the original reference', () => {
    const xml = '<whiteboard token="board-token"/>';
    const {editor,adapter} = open(xml);
    editor.view.dom.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(editor.view.dom.querySelector('img')).toBeNull();
    expect(editor.view.dom.textContent).toContain('缓存不可用');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('resolves source tokens independently from image tokens and rejects attachment previews masquerading as originals', () => {
    const entry = {tag:'source',attribute:'token',value:'file-token',path:'resources/file.png',representation:'original'};
    const manifest = {version:1,items:[entry]};
    expect(resolveResource(manifest,'source',{token:'file-token'})).toEqual(entry);
    for (const tag of ['img','figure','whiteboard']) expect(resolveResource(manifest,tag,{token:'file-token'})).toBeUndefined();
    for (const attrs of [{src:'file-token'},{name:'file-token'},{id:'file-token'}]) expect(resolveResource(manifest,'source',attrs)).toBeUndefined();
    for (const invalid of [{...entry,attribute:'src'},{...entry,representation:'preview'},{...entry,path:'../file.pdf'}]) {
      expect(resolveResource({version:1,items:[invalid]},'source',{src:'file-token',token:'file-token'})).toBeUndefined();
    }
    const attachment={...entry,path:'resources/file.pdf'};
    expect(resolveResource({version:1,items:[attachment]},'source',{token:'file-token'})).toEqual(attachment);
    const {editor,paths}=open('<figure view-type="Preview"><source token="file-token" name="document.pdf"/></figure>',{version:1,items:[attachment as ResourceMapping]});
    expect(paths).toEqual([]);
    expect(editor.view.dom.querySelector('img,iframe,object,embed')).toBeNull();
  });

  it('renders inline file chips, cards and cached previews while preserving attachment XML and the following text', () => {
    const xml = '<p>前文<source token="file-token" name="行内.png" size="1532" mime="image/png"/> 后文</p><figure view-type="Card"><source token="file-token" name="卡片.png" size="1532" mime="image/png"/></figure><figure view-type="Preview"><source token="file-token" name="预览.png" size="1532" mime="image/png"/></figure><p>尾文</p>';
    const manifest: ResourceManifest = {version:1,items:[{tag:'source',attribute:'token',value:'file-token',path:'resources/file.png',representation:'original'}]};
    const {editor,adapter,paths} = open(xml,manifest);
    const dom = editor.view.dom;
    expect(dom.querySelector('[data-attachment-view="inline"]')?.textContent).toBe('PNG行内.png');
    expect(dom.querySelector('[data-attachment-view="card"]')?.textContent).toContain('卡片.pngPNG 文件 · 1.5 KB');
    expect(dom.querySelector('[data-attachment-view="card"] img')).toBeNull();
    expect(dom.querySelector('[data-attachment-view="preview"] img')?.getAttribute('alt')).toBe('附件预览：预览.png');
    expect(dom.querySelectorAll('img')).toHaveLength(1);
    expect(paths).toEqual(['resources/file.png']);
    expect(dom.querySelector('p')?.textContent).toBe('前文PNG行内.png 后文');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    editor.commands.insertContentAt(editor.state.doc.content.size-1,'修改');
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('尾文','尾文修改'));
    editor.commands.undo();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('previews a standalone local raster source and leaves unsupported figure structures protected', () => {
    const xml = '<source path="@./assets/file.png" name="原始.png"/><figure view-type="Future"><source path="@./assets/file.png"/></figure><figure view-type="Preview"><source path="@./assets/file.png"/><source path="@./assets/other.png"/></figure><figure view-type="Preview">正文<source path="@./assets/file.png"/></figure><source path="@./assets/file.png"><future/></source>';
    const {editor,adapter,paths} = open(xml);
    expect(paths).toEqual(['./assets/file.png']);
    expect(editor.view.dom.querySelectorAll('.lr-attachment')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('.protected-block')).toHaveLength(5);
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('does not load remote, unsafe or non-raster attachments and treats file names as plain text', () => {
    const xml = '<figure view-type="Preview"><source token="file-token" name="&lt;img src=x onerror=alert(1)&gt;.pdf" mime="application/pdf" size="-1"/></figure><source path="@../outside.png"/><source path="@https://example.com/file.png"/><source path="@./file.html" mime="text/html"/>';
    const manifest: ResourceManifest = {version:1,items:[{tag:'source',attribute:'token',value:'file-token',path:'resources/file.png',representation:'original'}]};
    const {editor,adapter,paths} = open(xml,manifest);
    expect(paths).toEqual([]);
    expect(editor.view.dom.querySelector('img,iframe,object,embed,a,script')).toBeNull();
    expect(editor.view.dom.textContent).toContain('<img src=x onerror=alert(1)>.pdf');
    expect(editor.view.dom.textContent).toContain('此附件暂不支持本地预览');
    expect(editor.view.dom.textContent).not.toContain('-1');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });

  it('refreshes attachment caches without moving the selected atom or its comment and reports cache errors locally', () => {
    const xml = '<figure view-type="Preview"><source token="file-token" name="附件.png" size="1532"/></figure><p>尾文</p>';
    const {editor,adapter,refresh} = open(xml);
    editor.commands.setNodeSelection(0);
    const anchor = captureAnchor(editor.state.doc,0,1)!;
    expect(anchor.quote).toBe('【附件：附件.png】');
    const doc = editor.state.doc;
    const selection = editor.state.selection;
    refresh({version:1,items:[{tag:'source',attribute:'token',value:'file-token',path:'resources/file.png',representation:'original'}]});
    expect(editor.state.doc).toBe(doc);
    expect(editor.state.selection).toBe(selection);
    expect(captureAnchor(editor.state.doc,0,1)).toEqual(anchor);
    const tr = editor.state.tr.insertText('改',editor.state.doc.content.size-1);
    expect(mapAnchor(anchor,tr)).toEqual(anchor);
    editor.view.dispatch(tr);
    editor.view.dom.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(editor.view.dom.querySelector('img')).toBeNull();
    expect(editor.view.dom.textContent).toContain('附件.pngPNG 文件 · 1.5 KB附件预览缓存不可用');
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('尾文','尾文改'));
    editor.commands.undo();
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
  });
});
