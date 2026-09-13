// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';

const mermaid = vi.hoisted(() => ({initialize:vi.fn(),render:vi.fn()}));
vi.mock('mermaid',() => ({default:mermaid}));
import { attachWhiteboardPreview } from '../src/ui/whiteboard-preview';

const cleanups: (() => void)[] = [];
beforeEach(() => { mermaid.initialize.mockReset(); mermaid.render.mockReset(); });
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function preview(xml: string) {
  const container = document.createElement('div'); document.body.append(container);
  const cleanup = attachWhiteboardPreview(container,xml); cleanups.push(cleanup);
  return {container,cleanup};
}
const mermaidXML = '<whiteboard type="mermaid"><![CDATA[flowchart LR\nA[原稿] --> B[改稿]]]></whiteboard>';

describe('local whiteboard preview',() => {
  it('shows an empty canvas and explicit uncached references without invoking a renderer or network',() => {
    const fetch = vi.spyOn(globalThis,'fetch');
    const blank = preview('<whiteboard type="blank"/>');
    expect(blank.container.querySelector('[aria-label="空白画板"]')?.textContent).toBe('空白画板');
    expect(blank.container.querySelector('img,iframe,svg')).toBeNull();
    expect(blank.container.querySelector<HTMLElement>('.whiteboard-preview-blank')?.style.backgroundImage).toBe('');
    for (const reference of ['token="board_token"','src="https://example.com/board"','type="svg" path="@./local.svg"']) {
      const item = preview(`<whiteboard ${reference}/>`);
      expect(item.container.textContent).toContain('尚未缓存到本地');
      expect(item.container.querySelector('img,iframe,svg')).toBeNull();
    }
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks the self-contained blank canvas ready and removes it on cleanup',() => {
    const container = document.createElement('div');
    const onState = vi.fn();
    const xml = '<whiteboard type="blank"/>';
    const cleanup = attachWhiteboardPreview(container,xml,onState);
    expect(onState.mock.calls).toEqual([['loading'],['ready']]);
    expect(container.textContent).toBe('空白画板');
    cleanup();
    expect(container.childElementCount).toBe(0);
  });

  it('removes active SVG content, external resources and link behavior while retaining safe drawing',async () => {
    const xml = `<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" onload="alert(1)">
      <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>
      <image href="https://example.com/image.png"/><animate attributeName="href" to="https://example.com/"/>
      <a href="javascript:alert(1)"><text>安全的标题</text></a>
      <rect width="30" height="30" fill="url(https://example.com/fill.svg)" style="stroke:blue;fill:url(https://example.com/evil);font-size:16px"/>
      <use href="https://example.com/remote.svg#shape"/>
    </svg></whiteboard>`;
    const {container} = preview(xml);
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const svg = container.querySelector('svg')!;
    expect(svg.querySelector('script,foreignObject,image,animate,a')).toBeNull();
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(svg.textContent).toContain('安全的标题');
    expect(svg.querySelector('rect')!.hasAttribute('fill')).toBe(false);
    expect(svg.querySelector('rect')!.getAttribute('style')).toContain('stroke:blue');
    expect(svg.querySelector('rect')!.getAttribute('style')).not.toContain('url(');
    expect(svg.querySelector('use')!.hasAttribute('href')).toBe(false);
    expect(xml).toContain('onload="alert(1)"'); // caller's source remains independent
  });

  it('namespaces internal SVG ids, preserves local references and scopes safe styles to the preview',async () => {
    const {container} = preview(`<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg"><style>body{color:red} #shape{fill:blue;stroke:url(https://example.com/x)} rect{opacity:0.8}</style><defs><linearGradient id="gradient"><stop stop-color="red"/></linearGradient></defs><rect id="shape" fill="url(#gradient)" width="20" height="20"/><use href="#shape"/></svg></whiteboard>`);
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const scope = container.firstElementChild!.id;
    const gradient = container.querySelector('linearGradient')!.id;
    const shape = container.querySelector('rect')!.id;
    expect(gradient).toMatch(/^lr-whiteboard-\d+-id-/);
    expect(shape).not.toBe('shape');
    expect(container.querySelector('rect')!.getAttribute('fill')).toBe(`url(#${gradient})`);
    expect(container.querySelector('use')!.getAttribute('href')).toBe('#'+shape);
    const css = container.querySelector('style')!.textContent!;
    expect(css).toContain(`#${scope} body{color:red}`);
    expect(css).toContain(`#${scope} #${shape}{fill:blue}`);
    expect(css).not.toContain('https://');
  });

  it('rejects CSS imports, escaped resource values and references outside this SVG',async () => {
    const {container} = preview(`<whiteboard type="svg"><![CDATA[<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/style.css);rect{fill:red}</style><rect fill="url(#host-page-id)" style="filter:u\\72l(https://example.com/x);mask:image-set('https://example.com/mask.png' 1x);stroke:green"/></svg>]]></whiteboard>`);
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(container.querySelector('style')!.textContent).toMatch(/rect\{fill:red\}/);
    expect(container.querySelector('style')!.textContent).not.toMatch(/@import|https:\/\//);
    const rect = container.querySelector('rect')!;
    expect(rect.hasAttribute('fill')).toBe(false);
    expect(rect.getAttribute('style')).toBe('stroke:green');
  });

  it('keeps safe rules around at-rules without promoting nested rules or escaping the preview scope',async () => {
    const {container} = preview(`<whiteboard type="svg"><![CDATA[<svg xmlns="http://www.w3.org/2000/svg"><style>
      rect{fill:#eef;stroke:blue}
      @keyframes fade{from{fill:magenta}to{fill:yellow}}
      @font-face{font-family:remote;src:url(https://example.com/font.woff)}
      @media all{rect{fill:orange}}
      .escaped\\:selector{fill:red}
      + .outside{fill:red} ~ .outside{stroke:red}
      text{font-family:"}";fill:#333}
      path{stroke:green;fill:none;filter:url(https://example.com/filter.svg)}
    </style><rect/><text>可读文字</text><path d="M0 0 L10 10"/></svg>]]></whiteboard>`);
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    const css = container.querySelector('style')!.textContent!;
    expect(css).toContain('rect{fill:#eef;stroke:blue}');
    expect(css).toContain('text{font-family:"}";fill:#333}');
    expect(css).toContain('path{stroke:green;fill:none}');
    expect(css).not.toMatch(/@|https:|magenta|yellow|orange|escaped|outside/);
    expect(css.split('\n')).toHaveLength(3);
  });

  it('renders Mermaid in strict non-HTML mode, sanitizes its result and never binds clicks',async () => {
    const bindFunctions = vi.fn();
    mermaid.render.mockResolvedValue({svg:'<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com/"><text>原稿到改稿</text></a><image href="https://example.com/image.png"/></svg>',bindFunctions});
    const {container} = preview(mermaidXML);
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({securityLevel:'strict',htmlLabels:false,flowchart:expect.objectContaining({htmlLabels:false}),startOnLoad:false,suppressErrorRendering:true}));
    expect(mermaid.render.mock.calls[0][1]).toBe('flowchart LR\nA[原稿] --> B[改稿]');
    expect(container.querySelector('a,image')).toBeNull();
    expect(container.textContent).toContain('原稿到改稿');
    expect(bindFunctions).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('retains readable fills, text and edge strokes from the installed real Mermaid renderer',async () => {
    const actual = (await vi.importActual<typeof import('mermaid')>('mermaid')).default;
    const descriptor = Object.getOwnPropertyDescriptor(SVGElement.prototype,'getBBox');
    const textDescriptor = Object.getOwnPropertyDescriptor(SVGElement.prototype,'getComputedTextLength');
    // JSDOM has no SVG geometry; only measurement is supplied. Mermaid itself
    // produces every SVG node and the complete version-specific theme stylesheet.
    Object.defineProperty(SVGElement.prototype,'getBBox',{configurable:true,value() { return {x:0,y:0,width:Math.max(40,(this.textContent || '').length*8),height:20}; }});
    Object.defineProperty(SVGElement.prototype,'getComputedTextLength',{configurable:true,value() { return Math.max(40,(this.textContent || '').length*8); }});
    let rawSVG = '';
    mermaid.initialize.mockImplementation(actual.initialize);
    mermaid.render.mockImplementation(async (id:string,source:string,container:HTMLElement) => {
      const result = await actual.render(id,source,container);
      rawSVG = result.svg;
      return result;
    });
    try {
      const {container} = preview('<whiteboard type="mermaid"><![CDATA[flowchart LR\nA[原稿] --> B[评论] --> C[改稿]]]></whiteboard>');
      await waitFor(() => expect(container.querySelector('svg')).not.toBeNull(),{timeout:10000});
      expect(rawSVG).toContain('@keyframes');
      const style = container.querySelector('svg style');
      expect(style).not.toBeNull();
      expect(style!.textContent).not.toContain('@keyframes');
      const drawing = container.querySelector('svg')!;
      expect(drawing.querySelectorAll('.node')).toHaveLength(3);
      // Apply the sanitized rules through JSDOM's HTML stylesheet implementation;
      // browsers natively apply the same style element inside its SVG.
      const css = document.createElement('style'); css.textContent = style!.textContent;
      const original = new DOMParser().parseFromString(rawSVG,'image/svg+xml').documentElement;
      const originalCSS = document.createElement('style'); originalCSS.textContent = original.querySelector('style')!.textContent;
      document.head.append(css,originalCSS);
      document.body.append(original);
      try {
        const rect = drawing.querySelector('.node rect')!;
        const edge = drawing.querySelector('.flowchart-link')!;
        const text = drawing.querySelector('.node text')!;
        const originalRect = original.querySelector('.node rect')!;
        const originalEdge = original.querySelector('.flowchart-link')!;
        const originalText = original.querySelector('.node text')!;
        expect(getComputedStyle(originalRect).fill).not.toMatch(/^(?:|black|#0{3}|#0{6})$/i);
        expect(getComputedStyle(rect).fill).toBe(getComputedStyle(originalRect).fill);
        expect(getComputedStyle(rect).stroke).toBe(getComputedStyle(originalRect).stroke);
        expect(getComputedStyle(originalEdge).stroke).not.toBe('');
        expect(getComputedStyle(edge).stroke).toBe(getComputedStyle(originalEdge).stroke);
        expect(getComputedStyle(edge).fill).toBe('none');
        expect(getComputedStyle(originalText).fill).not.toBe('');
        expect(getComputedStyle(text).fill).toBe(getComputedStyle(originalText).fill);
        expect(getComputedStyle(text).fill).not.toBe(getComputedStyle(rect).fill);
      } finally { css.remove(); originalCSS.remove(); original.remove(); }
    } finally {
      if (descriptor) Object.defineProperty(SVGElement.prototype,'getBBox',descriptor); else delete (SVGElement.prototype as unknown as Record<string,unknown>).getBBox;
      if (textDescriptor) Object.defineProperty(SVGElement.prototype,'getComputedTextLength',textDescriptor); else delete (SVGElement.prototype as unknown as Record<string,unknown>).getComputedTextLength;
    }
  },15000);

  it('does not append an asynchronous result or leave scratch nodes after destruction',async () => {
    let complete!: (value:{svg:string}) => void;
    mermaid.render.mockReturnValue(new Promise(resolve => {complete=resolve;}));
    const {container,cleanup} = preview(mermaidXML);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull();
    cleanup();
    complete({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>迟到的结果</text></svg>'});
    await new Promise(resolve => setTimeout(resolve,0));
    expect(container.childNodes).toHaveLength(0);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('skips a queued Mermaid preview if its node is destroyed before rendering begins',async () => {
    let complete!: (value:{svg:string}) => void;
    mermaid.render.mockReturnValueOnce(new Promise(resolve => {complete=resolve;}));
    const first = preview(mermaidXML);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const second = preview(mermaidXML); second.cleanup(); first.cleanup();
    complete({svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
    await new Promise(resolve => setTimeout(resolve,0));
    expect(mermaid.render).toHaveBeenCalledOnce();
  });

  it('shows readable errors as text and keeps invalid diagrams independent from the original XML',async () => {
    mermaid.render.mockRejectedValue(new Error('图语法错误 <img src="https://example.com/">'));
    const {container} = preview(mermaidXML);
    await waitFor(() => expect(container.textContent).toContain('图语法错误'));
    expect(container.textContent).toContain('原文已保留');
    expect(container.querySelector('img')).toBeNull();
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('blocks resource-producing Mermaid syntax and configuration before invoking Mermaid',() => {
    for (const text of ['%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B','flowchart LR\nA@{ img:"https://example.com/image.png" }','flowchart LR\nA@{ "img":"https://example.com/image.png" }','flowchart LR\nA-->B\nstyle A fill:u\\72l(https://example.com/paint.svg)','---\nconfig:\n themeCSS: bad\n---\nflowchart LR\nA-->B']) {
      const {container} = preview(`<whiteboard type="mermaid"><![CDATA[${text}]]></whiteboard>`);
      expect(container.textContent).toContain('暂不支持');
    }
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('rejects XML declarations and malformed whiteboard XML without inserting markup',() => {
    for (const xml of ['<!DOCTYPE whiteboard [<!ENTITY x SYSTEM "file:///private/file">]><whiteboard>&x;</whiteboard>','<whiteboard type="svg"><svg></whiteboard>']) {
      const {container} = preview(xml);
      expect(container.textContent).toContain('预览失败');
      expect(container.querySelector('svg')).toBeNull();
    }
  });
});
