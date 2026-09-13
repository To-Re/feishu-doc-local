// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenDocumentDialog } from '../src/ui/OpenDocumentDialog';
import { App } from '../src/ui/App';
import type { DocumentHandle, Session, Snapshot } from '../src/core/types';

afterEach(()=>{cleanup();document.querySelectorAll('[data-open-dialog-test]').forEach(node=>node.remove());vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
type Props=React.ComponentProps<typeof OpenDocumentDialog>;
const form=()=>screen.getByRole('dialog',{name:'切换本地文档'});
const input=()=>screen.getByLabelText('文档路径') as HTMLInputElement;
const button=(name:string)=>screen.getByRole('button',{name}) as HTMLButtonElement;
const response=(value:unknown,status=200)=>Promise.resolve({ok:status>=200&&status<300,status,json:async()=>structuredClone(value)} as Response);
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

function setupApp(nativePicker=false) {
  const original:DocumentHandle={id:'old',name:'original.xml',path:'/articles/original.xml',reviewPath:'/articles/original.review.json'};
  const next:DocumentHandle={id:'next',name:'next.xml',path:'/articles/next.xml',reviewPath:'/articles/next.review.json'};
  const docs:Record<string,Snapshot>={old:{xml:'<p>原来这篇文章</p>',review:null,revision:'r1'},next:{xml:'<p>下一篇文章</p>',review:null,revision:'r2'}};
  const session:Session={csrf:'test-csrf',nativePicker,document:original};
  const requests:Array<{url:string;method:string;body?:unknown}>=[];
  let open:(path:string)=>Promise<Response>=async()=>response({error:'找不到指定 XML，请检查路径'},404);
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{
    const body=options.body?JSON.parse(String(options.body)):undefined;
    requests.push({url,method:options.method||'GET',body});
    if(url==='/api/session')return response(session);
    if(url==='/api/open'||url==='/api/pick')return open(body?.path||'');
    if(url.startsWith('/api/document'))return response(docs[new URL(url,'http://localhost').searchParams.get('id')!]);
    throw new Error('Unexpected request '+url);
  }));
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  render(<App/>);
  return {original,next,requests,setOpen:(handler:typeof open)=>{open=handler;}};
}

describe('manual local document switching dialog',()=>{
  it('uses the project dialog, traps focus, closes with Escape, and restores the opener',async()=>{
    const user=userEvent.setup();
    const opener=document.createElement('button');opener.dataset.openDialogTest='true';opener.textContent='切换入口';document.body.append(opener);opener.focus();
    const props:Props={path:'/articles/next.xml',busy:false,error:'',onPathChange:vi.fn(),onOpen:vi.fn(),onClose:vi.fn()};
    const mounted=render(<OpenDocumentDialog {...props}/>);
    expect(form().classList.contains('project-dialog')).toBe(true);
    expect(form().parentElement?.classList.contains('project-modal')).toBe(true);
    expect(form().parentElement?.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(input());
    act(()=>button('切换').focus());await user.tab();expect(document.activeElement).toBe(button('关闭切换本地文档'));
    await user.tab({shift:true});expect(document.activeElement).toBe(button('切换'));
    await user.keyboard('{Escape}');expect(props.onClose).toHaveBeenCalledTimes(1);expect(props.onOpen).not.toHaveBeenCalled();
    mounted.unmount();expect(document.activeElement).toBe(opener);
  });

  it('blocks submissions and dismissal while busy and keeps keyboard focus within the pending dialog',async()=>{
    const user=userEvent.setup();
    const props:Props={path:'/articles/next.xml',busy:true,error:'',onPathChange:vi.fn(),onOpen:vi.fn(),onClose:vi.fn()};
    const mounted=render(<OpenDocumentDialog {...props}/>);
    expect(form().getAttribute('aria-busy')).toBe('true');expect(input().matches(':disabled')).toBe(true);
    expect(button('取消').disabled).toBe(true);expect(button('关闭切换本地文档').disabled).toBe(true);
    fireEvent.submit(form());await user.keyboard('{Escape}{Tab}');
    expect(document.activeElement).toBe(form());expect(props.onOpen).not.toHaveBeenCalled();expect(props.onClose).not.toHaveBeenCalled();
    mounted.rerender(<OpenDocumentDialog {...props} busy={false} error="文件暂时不可读"/>);
    expect(document.activeElement).toBe(input());expect(within(form()).getByRole('alert').textContent).toBe('文件暂时不可读');
    expect(input().getAttribute('aria-describedby')).toBe(within(form()).getByRole('alert').id);
    mounted.rerender(<OpenDocumentDialog {...props} busy={false} path="  "/>);
    fireEvent.submit(form());expect(props.onOpen).not.toHaveBeenCalled();expect(button('切换').disabled).toBe(true);
  });

  it('shows HTTP failures inside the dialog, retains the original document, and permits a corrected retry',async()=>{
    const user=userEvent.setup(),app=setupApp();
    await screen.findByText('原来这篇文章');const opener=button('切换文档');
    await user.click(opener);await user.type(input(),'/articles/missing.xml');await user.click(button('切换'));
    const alert=await within(form()).findByRole('alert');
    expect(alert.textContent).toBe('找不到指定 XML，请检查路径');expect(document.querySelector('.error-banner')).toBeNull();
    expect(input().value).toBe('/articles/missing.xml');expect(screen.getByText('原来这篇文章')).toBeDefined();
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(app.original.path);
    app.setOpen(async()=>response(app.next));
    await user.clear(input());expect(within(form()).queryByRole('alert')).toBeNull();
    await user.type(input(),app.next.path);await user.click(button('切换'));
    await screen.findByText('下一篇文章');expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(app.next.path);
    expect(app.requests.filter(request=>request.url==='/api/open').map(request=>request.body)).toEqual([{path:'/articles/missing.xml'},{path:app.next.path}]);
    expect(app.requests.some(request=>request.method==='PUT'||request.url.includes('/sync'))).toBe(false);
  });

  it('does not repeat a pending open or close its dialog with Escape and recovers focus after failure',async()=>{
    const user=userEvent.setup(),app=setupApp(),pending=deferred<Response>();app.setOpen(()=>pending.promise);
    await screen.findByText('原来这篇文章');await user.click(button('切换文档'));
    await user.type(input(),app.next.path);await user.click(button('切换'));
    expect(form().getAttribute('aria-busy')).toBe('true');expect(document.activeElement).toBe(form());
    fireEvent.submit(form());await user.keyboard('{Escape}{Tab}');
    expect(screen.getByRole('dialog')).toBe(form());expect(app.requests.filter(request=>request.url==='/api/open')).toHaveLength(1);
    await act(async()=>pending.resolve(await response({error:'读取失败，请重试'},500)));
    expect(within(form()).getByRole('alert').textContent).toBe('读取失败，请重试');expect(document.activeElement).toBe(input());
    await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(button('切换文档'));
  });

  it('keeps native picker errors visible in the existing page banner without creating a manual dialog',async()=>{
    const user=userEvent.setup(),app=setupApp(true);app.setOpen(async()=>response({error:'本机文件选择暂时不可用'},500));
    await screen.findByText('原来这篇文章');await user.click(button('切换文档'));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('本机文件选择暂时不可用'));
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByText('原来这篇文章')).toBeDefined();
  });
});
