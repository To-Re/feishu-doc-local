import type { WhiteboardComponentTarget } from '../core/types';
import { mermaidPreviewConfig } from './mermaid-preview-config';
export type { WhiteboardComponentTarget } from '../core/types';

let sequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
const limit = 50_000;
export type WhiteboardPreviewOptions = {onComponentSelect?:(target:WhiteboardComponentTarget)=>void};
export type SVGPreviewOptions = WhiteboardPreviewOptions & {board:string};
type ComponentSource = {kind:'cloud'|'svg'|'mermaid';mermaidIDs?:Map<string,string>};
type Component = {id:string;label?:string};
const validComponentID = (id:string) => !!id && id.length<=512 && !/[\s\u0000-\u001f\u007f]/.test(id);

/** The source identity is independent of render counters and document offsets. */
export async function whiteboardIdentity(rawXML:string):Promise<string> {
  const parsed=new DOMParser().parseFromString(rawXML,'application/xml');
  if(parsed.querySelector('parsererror')||parsed.documentElement.localName!=='whiteboard')throw new Error('白板 XML 格式不正确。');
  for(const attribute of ['token','src','id','path']) {
    const value=parsed.documentElement.getAttribute(attribute);
    if(value?.trim()&&value.length<=4000)return `${attribute}:${value}`;
  }
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rawXML));
  return 'sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Only this trusted event map can produce targets. Source data-* attributes cannot. */
function bindComponents(container:HTMLElement,svg:Element,components:Map<Element,Component>,board:string,options:WhiteboardPreviewOptions):()=>void {
  container.setAttribute('data-review-board',board);
  if(components.size)svg.setAttribute('role','group');
  for(const [element,component] of components) {
    element.setAttribute('data-review-component-id',component.id);
    element.setAttribute('role','button');element.setAttribute('tabindex','0');
    element.setAttribute('aria-label',`白板组件：${component.label||component.id}`);
    element.classList.add('lr-whiteboard-component');
  }
  function find(event:Event) {
    let element=event.target instanceof Element?event.target:null;
    while(element&&element!==svg) {const component=components.get(element);if(component)return {element,component};element=element.parentElement;}
    return null;
  }
  const pointer=(event:Event)=>{if(find(event)){event.preventDefault();event.stopPropagation();}};
  const select=(event:Event)=>{
    if(event instanceof KeyboardEvent && !['Enter',' ','Spacebar'].includes(event.key))return;
    const match=find(event);if(!match)return;
    event.preventDefault();event.stopPropagation();
    // A real user selection takes ownership from quote navigation. Hiding a
    // resolved comment must not subsequently clear this selected component.
    match.element.removeAttribute('data-comment-navigation');
    for(const element of components.keys())element.classList.toggle('lr-whiteboard-component-selected',element===match.element);
    options.onComponentSelect?.({kind:'whiteboard-component',board,...match.component});
  };
  svg.addEventListener('pointerdown',pointer);svg.addEventListener('mousedown',pointer);
  svg.addEventListener('click',select);svg.addEventListener('keydown',select);
  return()=>{svg.removeEventListener('pointerdown',pointer);svg.removeEventListener('mousedown',pointer);svg.removeEventListener('click',select);svg.removeEventListener('keydown',select);container.removeAttribute('data-review-board');};
}

const safePaint = new Set(['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','opacity','color','font-family','font-size','font-weight','font-style','text-anchor','dominant-baseline','alignment-baseline','letter-spacing','word-spacing','text-decoration','display','visibility','white-space','vector-effect','paint-order','shape-rendering','marker-start','marker-mid','marker-end','filter','clip-path','mask','stop-color','stop-opacity']);

function localReference(value: string, ids: Map<string,string>) {
  const match = /^url\(\s*(['"]?)#([\w:.-]+)\1\s*\)$/i.exec(value.trim());
  return match && ids.has(match[2]) ? `url(#${ids.get(match[2])})` : null;
}
function paintValue(value: string, ids: Map<string,string>) {
  const clean = value.replace(/\/\*[\s\S]*?\*\//g,'').trim();
  if (/[\\@<>]/.test(clean) || /(?:expression|var)\s*\(/i.test(clean)) return null;
  if (/url\s*\(/i.test(clean)) return localReference(clean,ids);
  if (/[a-z][a-z\d+.-]*:|\/\/|(?:image-set|cross-fade|image|paint|element|src)\s*\(/i.test(clean)) return null;
  return clean;
}
function declarations(source: string, ids: Map<string,string>) {
  const result: string[] = [];
  for (const declaration of source.replace(/\/\*[\s\S]*?\*\//g,'').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    const key = declaration.slice(0,colon).trim().toLowerCase();
    if (!safePaint.has(key)) continue;
    const value = paintValue(declaration.slice(colon+1),ids);
    if (value) result.push(`${key}:${value}`);
  }
  return result.join(';');
}
function stylesheet(source: string, scope: string, ids: Map<string,string>) {
  // Mermaid includes animation at-rules alongside its ordinary theme rules.
  // Scan balanced blocks so dropping an at-rule never drops unrelated colors,
  // and nested rules are never mistaken for top-level presentation selectors.
  const text = source.replace(/\/\*[\s\S]*?\*\//g,'');
  const flat: [string,string][] = [];
  let start = 0, open = -1, depth = 0, nested = false, quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') { index += 1; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') {
      if (!depth) open = index; else nested = true;
      depth += 1;
    } else if (character === '}' && depth) {
      depth -= 1;
      if (!depth) {
        if (!nested) flat.push([text.slice(start,open).trim(),text.slice(open+1,index)]);
        start = index+1; nested = false;
      }
    } else if (!depth && (character === ';' || character === '}')) start = index+1;
  }
  const rules: string[] = [];
  for (const [selector,body] of flat) {
    // No at-rules, escaped selectors or leading sibling combinators that could
    // escape the preview container. Resource values remain filtered separately.
    if (!/^[\w\s#.:[\]="'|^$*>,+~-]+$/.test(selector)) continue;
    const parts = selector.split(',').map(item => item.trim());
    if (parts.some(item => !item || /^[>+~]/.test(item))) continue;
    const styles = declarations(body,ids);
    if (!styles) continue;
    const selectors = parts.map(item => `#${scope} ${item.replace(/#([\w-]+)/g,(all,id:string) => ids.has(id) ? '#'+ids.get(id) : all)}`).join(',');
    rules.push(`${selectors}{${styles}}`);
  }
  return rules.join('\n');
}

async function sanitizedSVG(source: string, scope: string, componentSource?:ComponentSource) {
  if (source.length > 2_000_000 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('SVG 内容过大或包含不支持的声明。');
  const {default:purifier} = await import('dompurify');
  const fragment = purifier.sanitize(source,{
    USE_PROFILES:{svg:true,svgFilters:true},
    ADD_TAGS:['use'],
    RETURN_DOM_FRAGMENT:true,
    FORBID_TAGS:['script','foreignObject','image','feImage','iframe','object','embed','audio','video','animate','animateMotion','animateTransform','set','discard'],
    FORBID_ATTR:['src','srcset'],
  });
  const svg = fragment.firstElementChild;
  if (!svg || svg.localName !== 'svg' || fragment.children.length !== 1) throw new Error('需要完整的 SVG 图形。');
  const ids = new Map<string,string>();
  const nodes = [svg,...svg.querySelectorAll('*')];
  const originalIDs=new Map<Element,string>();
  const idCounts=new Map<string,number>();
  for(const node of nodes) {
    const id=node.getAttribute('id');if(id){originalIDs.set(node,id);idCounts.set(id,(idCounts.get(id)||0)+1);}
    for(const attribute of [...node.attributes])if(attribute.name.startsWith('data-review-'))node.removeAttributeNode(attribute);
    node.classList.remove('lr-whiteboard-component','lr-whiteboard-component-selected');
  }
  for (const node of nodes) {
    const id = node.getAttribute('id');
    if (!id) continue;
    if (ids.has(id)) node.removeAttribute('id');
    else { const renamed = `${scope}-id-${ids.size}`; ids.set(id,renamed); node.setAttribute('id',renamed); }
  }
  for (const node of nodes) {
    if (node.localName === 'style') {
      node.textContent = stylesheet(node.textContent || '',scope,ids);
      if (!node.textContent) node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || ['src','srcset','target','tabindex','autofocus','base'].includes(name)) { node.removeAttributeNode(attribute); continue; }
      if (name === 'href') {
        if (value.startsWith('#') && ids.has(value.slice(1))) attribute.value = '#'+ids.get(value.slice(1));
        else node.removeAttributeNode(attribute);
      } else if (name === 'style') {
        const clean = declarations(value,ids);
        if (clean) attribute.value = clean; else node.removeAttributeNode(attribute);
      } else if (safePaint.has(name)) {
        const clean = paintValue(value,ids);
        if (clean) attribute.value = clean; else node.removeAttributeNode(attribute);
      } else if (/url\s*\(|(?:https?|javascript|data):|[\\]/i.test(value) && name !== 'xmlns') {
        node.removeAttributeNode(attribute);
      }
    }
    // Mermaid callbacks are never bound; remove link behavior even for local anchors.
    if (node.localName === 'a') node.replaceWith(...node.childNodes);
  }
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','白板本地预览');
  (svg as SVGSVGElement).style.maxWidth = '100%';
  (svg as SVGSVGElement).style.height = 'auto';
  (svg as SVGSVGElement).style.display = 'block';
  const components=new Map<Element,Component>();
  if(componentSource)for(const node of nodes) {
    const original=originalIDs.get(node);
    if(!original||idCounts.get(original)!==1||node===svg||!svg.contains(node)||node.closest('defs,marker,clipPath,mask,pattern,symbol,linearGradient,radialGradient'))continue;
    let id:string|undefined;
    if(componentSource.kind==='mermaid') {
      if(node.localName==='g'&&node.classList.contains('node'))id=componentSource.mermaidIDs?.get(original);
    } else {
      if(componentSource.kind==='cloud' ? node.localName!=='g' : !['g','rect','circle','ellipse','path','polygon','polyline','line','text'].includes(node.localName))continue;
      // Container groups are not diagram components; their descendant objects are.
      if(node.localName==='g'&&[...node.querySelectorAll('g')].some(child=>originalIDs.has(child)))continue;
      id=original;
    }
    if(!id||!validComponentID(id))continue;
    const label=(node.localName==='text'?node.textContent:[...node.querySelectorAll('text,title')].map(text=>text.textContent).join(' '))?.replace(/\s+/g,' ').trim().slice(0,500);
    components.set(node,{id,...(label?{label}:{})});
  }
  return {svg,components};
}

function readBoard(rawXML: string) {
  if (rawXML.length > 2_000_000 || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(rawXML)) throw new Error('白板内容过大或包含不支持的声明。');
  const document = new DOMParser().parseFromString(rawXML,'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'whiteboard') throw new Error('白板 XML 格式不正确。');
  const board = document.documentElement;
  const type = (board.getAttribute('type') || '').trim().toLowerCase();
  let content = (board.textContent || '').trim();
  if (type === 'svg' && board.children.length === 1 && board.firstElementChild?.localName === 'svg') content = new XMLSerializer().serializeToString(board.firstElementChild);
  else if (board.children.length) throw new Error('白板代码需要使用文本或 CDATA 保存。');
  return {type,content,referenced:board.hasAttribute('src') || board.hasAttribute('token') || board.hasAttribute('path')};
}
function validateMermaid(source: string) {
  if (source.length > limit) throw new Error('Mermaid 图超过 50,000 字符，暂不预览。');
  // Strict mode disables callbacks, but image shapes and configuration directives
  // can create resources during Mermaid's measurement pass, before SVG sanitizing.
  const scan = source.replace(/\/\*[\s\S]*?\*\//g,'')
    .replace(/\\([0-9a-f]{1,6})\s?/gi,(_all,hex:string) => String.fromCodePoint(Math.min(parseInt(hex,16),0x10ffff)))
    .replace(/\\([^\r\n])/g,'$1');
  if (/%%\s*\{|^\s*---(?:\r?\n|$)|(?:(?:url|image-set|cross-fade|image|paint|element|src)\s*\(|@import|@font-face)|\b(?:img|image|icon)["']?\s*:|<\s*(?:img|image|iframe|style|script)\b|!\[/im.test(scan))
    throw new Error('本地预览暂不支持图内图片、外部资源或自定义初始化配置。');
}

export type WhiteboardPreviewState = 'loading' | 'ready' | 'error';

/** A cached cloud export is text until it has passed the same SVG sanitizer as
 * local diagrams. Keep the server's viewBox; never infer a raster crop. */
export function attachSVGPreview(container: HTMLElement, load: (signal: AbortSignal) => Promise<string>, onState?: (state: WhiteboardPreviewState) => void, options?:SVGPreviewOptions): () => void {
  const controller = new AbortController();
  const scope = `lr-whiteboard-${++sequence}`;
  const content = document.createElement('div');
  content.id = scope; content.className = 'whiteboard-preview-content';
  container.append(content);
  let disposed = false;
  let detachComponents:(()=>void)|undefined;
  content.textContent = '正在读取白板预览…'; onState?.('loading');
  void Promise.resolve().then(() => disposed ? '' : load(controller.signal)).then(async source => {
    if (disposed) return;
    const {svg:safe,components} = await sanitizedSVG(source,scope,options?.onComponentSelect?{kind:'cloud'}:undefined);
    if (!disposed) {
      safe.setAttribute('aria-label','白板云端预览（本地缓存）');
      if(options?.onComponentSelect)detachComponents=bindComponents(content,safe,components,options.board,options);
      content.replaceChildren(safe); onState?.('ready');
    }
  }).catch(error => {
    if (disposed) return;
    const message = document.createElement('p'); message.className = 'whiteboard-preview-message'; message.setAttribute('role','status');
    message.textContent = `白板预览缓存不可用：${String(error instanceof Error ? error.message : error).slice(0,500)} 原始引用已保留。`;
    content.replaceChildren(message); onState?.('error');
  });
  return () => { disposed = true; controller.abort(); detachComponents?.(); content.remove(); };
}

/** Preview only. The caller retains rawXML for editing/export independently. */
export function attachWhiteboardPreview(container: HTMLElement, rawXML: string, onState?: (state: WhiteboardPreviewState) => void, options?:WhiteboardPreviewOptions): () => void {
  let disposed = false;
  let scratch: HTMLElement | null = null;
  let detachComponents:(()=>void)|undefined;
  const scope = `lr-whiteboard-${++sequence}`;
  const content = document.createElement('div');
  content.id = scope; content.className = 'whiteboard-preview-content';
  container.append(content);
  function message(text: string, error = false) {
    if (disposed) return;
    const node = document.createElement('p'); node.className = 'whiteboard-preview-message';
    node.setAttribute('role',error ? 'status' : 'note'); node.textContent = text;
    content.replaceChildren(node);
    if (error) onState?.('error');
  }
  const cleanup = () => { disposed = true; detachComponents?.(); scratch?.remove(); scratch = null; content.remove(); };
  try {
    onState?.('loading');
    const board = readBoard(rawXML);
    if (board.type === 'blank' && !board.content) {
      const canvas = document.createElement('div'); canvas.className = 'whiteboard-preview-blank';
      canvas.setAttribute('role','img'); canvas.setAttribute('aria-label','空白画板');
      canvas.textContent = '空白画板';
      Object.assign(canvas.style,{minHeight:'180px',border:'1px solid #e2e8f0',borderRadius:'8px',backgroundColor:'#fff',color:'#646a73',display:'grid',placeItems:'center'});
      content.append(canvas); onState?.('ready'); return cleanup;
    }
    if (!board.content && board.referenced) { message('白板尚未缓存到本地，原始引用已保留。'); return cleanup; }
    if (board.type !== 'svg' && board.type !== 'mermaid') { message(board.type ? `暂不支持 ${board.type} 白板的本地预览，原文已保留。` : '白板尚无可预览的本地内容，原文已保留。'); return cleanup; }
    if (!board.content) throw new Error('白板内容为空。');
    if (board.type === 'mermaid') validateMermaid(board.content);
    message('正在生成本地白板预览…');
    const render = async () => {
      if (disposed) return;
      let svg = board.content;
      const mermaidIDs=new Map<string,string>();
      if (board.type === 'mermaid') {
        const {default:mermaid} = await import('mermaid');
        if (disposed) return;
        mermaid.initialize(mermaidPreviewConfig(limit));
        if(options?.onComponentSelect) {
          const diagram=await mermaid.mermaidAPI.getDiagramFromText(board.content);
          const db=diagram.db as {getVertices?:()=>Map<string,{id?:string;domId?:string}>};
          if(/^flowchart(?:-v2)?$/.test(diagram.type)&&typeof db.getVertices==='function') {
            const vertices=db.getVertices();
            if(vertices instanceof Map)for(const [id,vertex] of vertices)if(validComponentID(id)&&vertex.id===id&&typeof vertex.domId==='string') {
              mermaidIDs.set(vertex.domId,id);mermaidIDs.set(`${scope}-diagram-${vertex.domId}`,id);
            }
          }
        }
        scratch = document.createElement('div'); scratch.setAttribute('aria-hidden','true');
        Object.assign(scratch.style,{position:'fixed',left:'-100000px',top:'0',visibility:'hidden',width:'1200px'});
        document.body.append(scratch);
        try { svg = (await mermaid.render(`${scope}-diagram`,board.content,scratch)).svg; }
        finally { scratch?.remove(); scratch = null; }
      }
      if (disposed) return;
      const {svg:safe,components} = await sanitizedSVG(svg,scope,options?.onComponentSelect?{kind:board.type==='mermaid'?'mermaid':'svg',mermaidIDs}:undefined);
      if (board.type === 'mermaid') {
        // Mermaid's width="100%" relies on a generated max-width declaration.
        // The sanitizer intentionally drops layout CSS. Restore the measured
        // width, so small diagrams do not enlarge to fill the article column;
        // max-width:100% still lets large diagrams shrink to the available space.
        const viewBox=(safe.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
        if(viewBox.length===4&&viewBox.every(Number.isFinite)&&viewBox[2]>0&&viewBox[3]>0)safe.setAttribute('width',String(viewBox[2]));
        (safe as SVGSVGElement).style.marginInline='auto';
      }
      const identity=options?.onComponentSelect?await whiteboardIdentity(rawXML):'';
      if (!disposed) { if(options?.onComponentSelect)detachComponents=bindComponents(content,safe,components,identity,options);content.replaceChildren(safe); onState?.('ready'); }
    };
    // Mermaid owns global renderer configuration. Serialize initialization/rendering.
    const pending = board.type === 'mermaid' ? renderQueue.then(render,render) : render();
    if (board.type === 'mermaid') renderQueue = pending.catch(() => undefined);
    void pending.catch(error => message(`白板预览失败：${String(error instanceof Error ? error.message : error).slice(0,500)} 原文已保留。`,true));
  } catch (error) { message(`白板预览失败：${String(error instanceof Error ? error.message : error).slice(0,500)} 原文已保留。`,true); }
  return cleanup;
}
