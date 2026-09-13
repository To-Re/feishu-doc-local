// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { attachSVGPreview, attachWhiteboardPreview, whiteboardIdentity } from '../src/ui/whiteboard-preview';

const mermaid=vi.hoisted(()=>({initialize:vi.fn(),render:vi.fn(),mermaidAPI:{getDiagramFromText:vi.fn()}}));
vi.mock('mermaid',()=>({default:mermaid}));
const disposers:Array<()=>void>=[];
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);mermaid.initialize.mockReset();mermaid.render.mockReset();mermaid.mermaidAPI.getDiagramFromText.mockReset();});
afterEach(()=>{disposers.splice(0).forEach(dispose=>dispose());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});
const mount=()=>{const element=document.createElement('div');document.body.append(element);return element;};
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g id="draft"><rect width="90" height="50"/><text>本地文件</text></g><path id="arrow" d="M90 25 L120 25"/></svg>';

describe('whiteboard component comments',()=>{
  it('uses stable board selectors and hashes only inline boards without an identity',async()=>{
    expect(await whiteboardIdentity('<whiteboard token="cloud" src="url" id="block"/>')).toBe('token:cloud');
    expect(await whiteboardIdentity('<whiteboard src="url" id="block"/>')).toBe('src:url');
    expect(await whiteboardIdentity('<whiteboard id="block" path="@./board.svg"/>')).toBe('id:block');
    expect(await whiteboardIdentity('<whiteboard path="@./board.svg"/>')).toBe('path:@./board.svg');
    const raw='<whiteboard type="svg">'+svg+'</whiteboard>';
    const identity=await whiteboardIdentity(raw);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await whiteboardIdentity(raw)).toBe(identity);
    expect(await whiteboardIdentity(raw.replace('本地文件','更改名称'))).not.toBe(identity);
  });

  it('selects explicit SVG components through a trusted map, preserves ordinary board clicks and removes events on disposal',async()=>{
    const container=mount(),select=vi.fn(),bubble=vi.fn();container.addEventListener('click',bubble);
    const xml='<whiteboard id="local-demo" type="svg">'+svg+'</whiteboard>';
    const dispose=attachWhiteboardPreview(container,xml,undefined,{onComponentSelect:select});disposers.push(dispose);
    await waitFor(()=>expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(2));
    expect(container.querySelector('[data-review-board]')!.getAttribute('data-review-board')).toBe('id:local-demo');
    const component=container.querySelector('[data-review-component-id="draft"]')!;
    expect(component.id).not.toBe('draft');expect(component.getAttribute('aria-label')).toBe('白板组件：本地文件');
    expect(component.getAttribute('tabindex')).toBe('0');
    fireEvent.mouseDown(component.querySelector('rect')!);
    fireEvent.click(component.querySelector('text')!);
    expect(select).toHaveBeenLastCalledWith({kind:'whiteboard-component',board:'id:local-demo',id:'draft',label:'本地文件'});
    expect(component.classList.contains('lr-whiteboard-component-selected')).toBe(true);expect(bubble).not.toHaveBeenCalled();
    fireEvent.keyDown(component,{key:'Enter'});expect(select).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(component,{key:' '});expect(select).toHaveBeenCalledTimes(3);
    fireEvent.click(container.querySelector('svg')!);expect(bubble).toHaveBeenCalledOnce();
    dispose();fireEvent.click(component);expect(select).toHaveBeenCalledTimes(3);
    expect(container.childElementCount).toBe(0);expect(xml).not.toContain('data-review');
  });

  it('excludes duplicate ids, rendering definitions, generic groups and forged source metadata',async()=>{
    const source='<svg xmlns="http://www.w3.org/2000/svg" id="root" data-review-board="forged"><defs><marker id="marker"><path id="marker-path" d="M0 0 L1 1"/></marker></defs><g id="wrapper"><g id="node-a"><rect width="10" height="10"/></g><g id="node-b"><text>第二个节点</text></g></g><rect id="duplicate"/><circle id="duplicate"/><rect data-review-component-id="forged" class="lr-whiteboard-component-selected"/></svg>';
    const container=mount(),select=vi.fn();
    disposers.push(attachWhiteboardPreview(container,'<whiteboard id="board" type="svg">'+source+'</whiteboard>',undefined,{onComponentSelect:select}));
    await waitFor(()=>expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(2));
    expect([...container.querySelectorAll('[data-review-component-id]')].map(node=>node.getAttribute('data-review-component-id'))).toEqual(['node-a','node-b']);
    expect(container.querySelector('[data-review-board="forged"],[data-review-component-id="forged"],.lr-whiteboard-component-selected')).toBeNull();
    fireEvent.click(container.querySelector('circle')!);expect(select).not.toHaveBeenCalled();
  });

  it('selects cached native SVG groups by their original node IDs, including connector and text nodes',async()=>{
    const source='<svg xmlns="http://www.w3.org/2000/svg"><g id="t1:2"><g id="o1:1"><rect/><text>修订稿</text></g><g id="c1:1"><path d="M0 0 L20 20"/></g><g id="a1:1"><text>节点注释</text></g></g><rect id="not-a-native-group"/></svg>';
    const container=mount(),select=vi.fn();
    disposers.push(attachSVGPreview(container,async()=>source,undefined,{board:'token:known-board',onComponentSelect:select}));
    await waitFor(()=>expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(3));
    expect([...container.querySelectorAll('[data-review-component-id]')].map(node=>node.getAttribute('data-review-component-id'))).toEqual(['o1:1','c1:1','a1:1']);
    fireEvent.click(container.querySelector('[data-review-component-id="c1:1"] path')!);
    expect(select).toHaveBeenCalledWith({kind:'whiteboard-component',board:'token:known-board',id:'c1:1'});
  });

  it('maps Mermaid flowchart nodes using parser identities rather than parsing render counters or text labels',async()=>{
    mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue({type:'flowchart-v2',db:{getVertices:()=>new Map([['A_with-hyphen',{id:'A_with-hyphen',domId:'flowchart-A_with-hyphen-71'}]])}});
    mermaid.render.mockImplementation(async(renderID:string)=>({svg:`<svg xmlns="http://www.w3.org/2000/svg"><g id="${renderID}-flowchart-A_with-hyphen-71" class="node"><text>同名标签</text></g><g id="flowchart-invented-9" class="node"><text>同名标签</text></g></svg>`}));
    const container=mount(),select=vi.fn();
    disposers.push(attachWhiteboardPreview(container,'<whiteboard id="flow" type="mermaid">flowchart LR\nA_with-hyphen[同名标签]</whiteboard>',undefined,{onComponentSelect:select}));
    await waitFor(()=>expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(1));
    fireEvent.click(container.querySelector('[data-review-component-id]')!);
    expect(select).toHaveBeenCalledWith({kind:'whiteboard-component',board:'id:flow',id:'A_with-hyphen',label:'同名标签'});
  });

  it('extracts selectable nodes from the installed real Mermaid parser and renderer',async()=>{
    const actual=(await vi.importActual<typeof import('mermaid')>('mermaid')).default;
    mermaid.initialize.mockImplementation(actual.initialize);mermaid.render.mockImplementation(actual.render);
    mermaid.mermaidAPI.getDiagramFromText.mockImplementation(actual.mermaidAPI.getDiagramFromText);
    const box=Object.getOwnPropertyDescriptor(SVGElement.prototype,'getBBox');
    const length=Object.getOwnPropertyDescriptor(SVGElement.prototype,'getComputedTextLength');
    Object.defineProperty(SVGElement.prototype,'getBBox',{configurable:true,value(){return {x:0,y:0,width:Math.max(40,(this.textContent||'').length*8),height:20};}});
    Object.defineProperty(SVGElement.prototype,'getComputedTextLength',{configurable:true,value(){return Math.max(40,(this.textContent||'').length*8);}});
    try {
      const container=mount(),select=vi.fn();
      disposers.push(attachWhiteboardPreview(container,'<whiteboard id="flow" type="mermaid"><![CDATA[flowchart LR\nA[本地稿] --> B[人类评审] --> C[修订稿]]]></whiteboard>',undefined,{onComponentSelect:select}));
      await waitFor(()=>expect(container.querySelectorAll('[data-review-component-id]')).toHaveLength(3),{timeout:10000});
      expect([...container.querySelectorAll('[data-review-component-id]')].map(node=>node.getAttribute('data-review-component-id')).sort()).toEqual(['A','B','C']);
      fireEvent.click(container.querySelector('[data-review-component-id="B"]')!);
      expect(select).toHaveBeenLastCalledWith(expect.objectContaining({id:'B',board:'id:flow',label:'人类评审'}));
    } finally {
      if(box)Object.defineProperty(SVGElement.prototype,'getBBox',box);else delete (SVGElement.prototype as unknown as Record<string,unknown>).getBBox;
      if(length)Object.defineProperty(SVGElement.prototype,'getComputedTextLength',length);else delete (SVGElement.prototype as unknown as Record<string,unknown>).getComputedTextLength;
    }
  },15000);
});
