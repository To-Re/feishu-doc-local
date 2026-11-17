// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { makeSnapshot } from '../src/snapshot';
afterEach(()=>vi.restoreAllMocks());
it('renders the actual webview read-only, normalizes paths, refreshes and exposes explicit source controls',async()=>{
 document.body.innerHTML='<button id="reader-refresh">刷新</button><button id="reader-source">查看源码</button><div id="reader-status"></div><article id="reader-document"></article><nav id="reader-outline"></nav><div id="reader-notices"></div><section id="reader-comments"></section>';
 const bridge={postMessage:vi.fn()};vi.stubGlobal('acquireVsCodeApi',()=>bridge);vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
 await import('../src/webview');expect(bridge.postMessage).toHaveBeenCalledWith({type:'ready'});
 const source='<title>公开阅读样稿</title><h1>正文</h1><p><b>粗体</b><latex>E=mc^2</latex></p><table><tr><th colspan="2"><p>合并表头</p></th></tr><tr><td><p>A</p></td><td><p>B</p></td></tr></table><img path="@./assets/a.png"/><whiteboard type="svg" path="@./assets/board.svg"/>';
 const sidecar=JSON.stringify({format:'lark-review',version:1,comments:[{author:'演示读者',body:'<img src=x onerror=alert(1)>',replies:[]}]});
 const snapshot=await makeSnapshot(source,sidecar,async path=>path.endsWith('svg')?new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><script>alert(1)</script><rect width="40" height="40"/></svg>'):new Uint8Array([137,80,78,71,13,10,26,10]));
 window.dispatchEvent(new MessageEvent('message',{data:{type:'document',name:'demo.feishu.xml',snapshot}}));
 const article=document.querySelector('article')!;
 expect(article.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false');
 expect(article.querySelector('th')?.getAttribute('colspan')).toBe('2');expect(article.querySelector('.katex')).not.toBeNull();
 expect(article.querySelector('img[src]')?.getAttribute('src')).toMatch(/^data:image\/png/);
 await waitFor(()=>expect(article.querySelector('svg rect')).not.toBeNull());expect(article.querySelector('script')).toBeNull();
 expect(document.querySelector('#reader-comments img')).toBeNull();expect(document.querySelector('#reader-comments')?.textContent).toContain('<img src=x');
 expect(document.querySelectorAll('.outline-link').length).toBeGreaterThanOrEqual(2);
 document.getElementById('reader-refresh')!.click();document.getElementById('reader-source')!.click();expect(bridge.postMessage.mock.calls.slice(-2)).toEqual([[{type:'refresh'}],[{type:'source'}]]);
 window.dispatchEvent(new MessageEvent('message',{data:{type:'document',name:'demo.feishu.xml',snapshot:{...snapshot,xml:'<p>外部更新</p>'}}}));
 expect(article.textContent).toContain('外部更新');expect(article.textContent).not.toContain('公开阅读样稿');
 window.dispatchEvent(new MessageEvent('message',{data:{type:'error',message:'无效 XML'}}));expect(article.textContent).toBe('');expect(document.getElementById('reader-notices')!.textContent).toContain('无效 XML');
 await new Promise(resolve=>setTimeout(resolve,30));vi.unstubAllGlobals();
});
