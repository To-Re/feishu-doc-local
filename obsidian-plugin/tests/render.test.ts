import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { parseDocxXML } from '../../src/core/docxml';
import { renderDocument } from '../src/render';
import { readReview, resolvePreview, resourcePath, reviewPath } from '../src/document';

const editors:ReturnType<typeof renderDocument>[]=[];
const geometry=['getBBox','getComputedTextLength'].map(name=>({name,descriptor:Object.getOwnPropertyDescriptor(SVGElement.prototype,name)}));
beforeEach(()=>{
  vi.stubGlobal('crypto',webcrypto);
  Object.defineProperty(SVGElement.prototype,'getBBox',{configurable:true,value(){return{x:0,y:0,width:Math.max(40,(this.textContent||'').length*8),height:20};}});
  Object.defineProperty(SVGElement.prototype,'getComputedTextLength',{configurable:true,value(){return Math.max(40,(this.textContent||'').length*8);}});
});
afterEach(()=>{
  editors.splice(0).forEach(editor=>editor.destroy());document.body.replaceChildren();
  for(const {name,descriptor}of geometry){if(descriptor)Object.defineProperty(SVGElement.prototype,name,descriptor);else Reflect.deleteProperty(SVGElement.prototype,name);}
  vi.restoreAllMocks();vi.unstubAllGlobals();
});
function render(xml:string,extra:Partial<Parameters<typeof renderDocument>[1]>={}){
  const host=document.createElement('article');document.body.append(host);
  const result=renderDocument(host,{xml,review:{comments:[]},imageURL:path=>'app://vault/articles/'+path,readSVG:async()=>{throw new Error('missing');},...extra});editors.push(result);
  return{host,...result};
}

describe('Obsidian DocxXML rendering with the shared schema',()=>{
  it('renders text, images, merged tables, code and formulas and rejects editing without changing source',()=>{
    const xml='<title>飞书本地文章</title><p>前文 <b>粗体</b> <latex>E=mc^2</latex> 后文</p>'+
      '<table><tr><th colspan="2"><p>合并表头</p></th></tr><tr><td><p>A</p></td><td><p>B</p></td></tr></table>'+
      '<pre lang="go"><code><![CDATA[fmt.Println("hello")]]></code></pre><img path="@./assets/demo.png" width="200" caption="配图"/>'+
      '<future-block keep="yes"><custom/></future-block>';
    const imageURL=vi.fn(path=>'app://vault/'+path),{host,editor,warnings}=render(xml,{imageURL});
    expect(host.querySelector('h1')?.textContent).toBe('飞书本地文章');expect(host.querySelector('strong')?.textContent).toBe('粗体');
    expect(host.querySelector('th')?.getAttribute('colspan')).toBe('2');expect(host.querySelectorAll('td')).toHaveLength(2);
    expect(host.querySelector('.katex')).not.toBeNull();expect(host.querySelector('.lr-code-block')?.textContent).toContain('fmt.Println');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('app://vault/./assets/demo.png');expect(imageURL).toHaveBeenCalledTimes(1);
    expect(editor.isEditable).toBe(false);expect(editor.view.dom.getAttribute('contenteditable')).toBe('false');
    const before=editor.getJSON();editor.commands.insertContent('不能编辑');expect(editor.getJSON()).toEqual(before);
    expect(parseDocxXML(xml).serialize(editor.getJSON())).toBe(xml);expect(warnings.length).toBeGreaterThan(0);
    expect(host.querySelector('future-block,custom,iframe')).toBeNull();
  });

  it('uses the installed Mermaid parser and layout to render an actual graph without a local server',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    const{host}=render('<whiteboard type="mermaid"><![CDATA[flowchart LR\nA[本地文章] --> B{人类评审}\nB --> C[继续修订]\n]]></whiteboard>');
    await waitFor(()=>expect(host.querySelectorAll('[data-review-component-id]')).toHaveLength(3),{timeout:10000});
    expect(host.querySelectorAll('.flowchart-link')).toHaveLength(2);expect(host.textContent).toContain('人类评审');
    expect(host.querySelector('iframe')).toBeNull();expect(fetch).not.toHaveBeenCalled();
  });

  it('loads local SVG whiteboards through the injected vault reader and sanitizes their active content',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch'),readSVG=vi.fn(async(_path:string,_signal:AbortSignal)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><script>alert(1)</script><image href="https://example.com/private"/><rect id="rect" width="80" height="40" fill="blue"/><text>本地 SVG</text></svg>');
    const {host}=render('<whiteboard type="svg" path="@./assets/board.svg"/>',{readSVG});
    await waitFor(()=>expect(host.querySelector('svg')).not.toBeNull());
    expect(readSVG.mock.calls[0][0]).toBe('./assets/board.svg');expect(host.textContent).toContain('本地 SVG');
    expect(host.querySelector('script,image,iframe')).toBeNull();expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves downloaded cloud images by the exact sidecar token and keeps unavailable remote resources as placeholders',()=>{
    const resources={version:1,items:[{tag:'img',attribute:'token',value:'fixture-image',path:'assets/cache.png',representation:'original'}]};
    const {host}=render('<img token="fixture-image"/><img src="https://example.com/remote.png"/>',{review:{comments:[],resources}});
    expect(host.querySelectorAll('img')).toHaveLength(1);expect(host.querySelector('img')?.getAttribute('src')).toBe('app://vault/articles/assets/cache.png');
    expect(host.querySelector('[src^="https:"]')).toBeNull();
  });
});

describe('vault document and sidecar boundaries',()=>{
  it('keeps relative assets beside the opened XML and rejects escaping or remote paths',()=>{
    expect(reviewPath('articles/文章.XML')).toBe('articles/文章.review.json');
    expect(resourcePath('articles/文章.xml','@bad.png')).toBe('articles/@bad.png');
    expect(resourcePath('articles/文章.xml','./assets/图.png')).toBe('articles/assets/图.png');
    for(const path of ['../secret.png','/secret.png','https://example.com/a.png','file:///tmp/a.png','assets/../secret.svg','assets\\secret.png'])
      expect(()=>resourcePath('articles/文章.xml',path)).toThrow('资源必须位于');
    expect(resolvePreview(undefined,'whiteboard',{path:'@../secret.svg'})).toBeUndefined();
  });

  it('reads existing comments and resources without dropping or rewriting unknown metadata in the source',()=>{
    const value={format:'lark-review',version:1,comments:[{author:'作者',body:'请补充说明',status:'resolved',anchor:{quote:'某段原文'},replies:[{author:'AI',body:'已补充'}]}],resources:{version:1,items:[]},future:{keep:true}};
    const source=JSON.stringify(value),review=readReview(source);
    expect(review.comments).toEqual([{author:'作者',body:'请补充说明',resolved:true,quote:'某段原文',replies:[{author:'AI',body:'已补充'}]}]);
    expect(review.resources).toEqual(value.resources);expect(JSON.stringify(value)).toBe(source);
    expect(()=>readReview('{invalid')).toThrow();expect(()=>readReview('{"format":"other","version":2,"comments":[]}')).toThrow('格式不受支持');
  });
});
