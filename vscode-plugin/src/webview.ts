import { renderDocument } from '../../obsidian-plugin/src/render';
import type { PreviewSnapshot } from './snapshot';
import { localResourcePath } from '../../src/core/project-files';
import '../../src/ui/styles.css';
import 'katex/dist/katex.min.css';
import './webview.css';
declare function acquireVsCodeApi():{postMessage(message:unknown):void};
const vscode=acquireVsCodeApi();
const el=(id:string)=>document.getElementById(id)!;
const status=el('reader-status'),article=el('reader-document'),outline=el('reader-outline'),comments=el('reader-comments'),notices=el('reader-notices');
let rendered:ReturnType<typeof renderDocument>|undefined;
function text<K extends keyof HTMLElementTagNameMap>(tag:K,value:string,parent:HTMLElement){const node=document.createElement(tag);node.textContent=value;parent.append(node);return node;}
el('reader-refresh').addEventListener('click',()=>{status.textContent='正在刷新…';vscode.postMessage({type:'refresh'});});
el('reader-source').addEventListener('click',()=>vscode.postMessage({type:'source'}));
// Document links are inert. Neither markup nor sidecars can request commands,
// file access, network navigation or execution through the host bridge.
article.addEventListener('click',event=>{if((event.target as Element).closest('a')){event.preventDefault();status.textContent='只读预览不自动打开文档外链；可在源码中查看地址。';}});
window.addEventListener('message',event=>{
 const message=event.data;
 if(!message||!['document','error'].includes(message.type))return;
 const scroll=window.scrollY;rendered?.destroy();rendered=undefined;article.replaceChildren();outline.replaceChildren();comments.replaceChildren();notices.replaceChildren();
 if(message.type==='error'){status.textContent='无法预览';text('p',message.message,notices);text('p','可点击“查看源码”用原来的文本编辑器打开。',notices);return;}
 try{
  const data:PreviewSnapshot=message.snapshot;
  rendered=renderDocument(article,{xml:data.xml,review:data.review,imageURL:path=>{const key=localResourcePath(path);return key&&Object.hasOwn(data.assets,key)?data.assets[key]:'';},readSVG:async path=>{const key=localResourcePath(path);if(!key||!Object.hasOwn(data.texts,key))throw Error('本地资源不可用');return data.texts[key];}});
  const warnings=[...data.warnings,...rendered.warnings];
  if(warnings.length){const details=document.createElement('details');notices.append(details);text('summary',`${warnings.length} 项阅读提示`,details);const list=document.createElement('ul');details.append(list);for(const warning of warnings)text('li',warning,list);}
  const details=document.createElement('details');details.open=true;outline.append(details);text('summary','文章目录',details);
  article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[data-xml-title]').forEach(heading=>{
   const button=text('button',heading.textContent||'未命名章节',details);button.title=heading.textContent||'跳转到章节';button.className='outline-link';button.style.paddingLeft=heading.hasAttribute('data-xml-title')?'0':`${Math.max(0,Number(heading.tagName.slice(1))-1)*10}px`;
   button.addEventListener('click',()=>{heading.scrollIntoView({behavior:'smooth',block:'start'});heading.tabIndex=-1;heading.focus({preventScroll:true});});
  });
  if(details.childElementCount===1)text('p','暂无标题',details);
  if(data.review.comments.length){text('h2',`已有评论 · ${data.review.comments.length}`,comments);for(const comment of data.review.comments){const card=document.createElement('section');card.className='reader-comment';comments.append(card);text('strong',`${comment.author} · ${comment.resolved?'已解决':'待处理'}`,card);if(comment.quote)text('blockquote',comment.quote,card);text('p',comment.body,card);for(const reply of comment.replies)text('p',`${reply.author}：${reply.body}`,card);}}
  article.querySelectorAll<HTMLInputElement>('input').forEach(input=>{input.disabled=true;});
  status.textContent=message.name+' · 文件变化后自动刷新';
  requestAnimationFrame(()=>window.scrollTo(0,scroll));
 }catch(error){article.replaceChildren();status.textContent='无法渲染';text('p',error instanceof Error?error.message:'文档格式不受支持',notices);}
});
vscode.postMessage({type:'ready'});
