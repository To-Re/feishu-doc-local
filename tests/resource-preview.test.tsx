// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createReview } from '../src/core/types';
import { ResourcePreview } from '../src/ui/ProjectExplorer';

const handle={id:'doc',name:'article.xml',path:'/project/article.xml',reviewPath:'/project/article.review.json'};
const xml='<p>正文</p>';
const review=createReview(handle.name,xml);
const file={kind:'resource' as const,path:'notes.txt',name:'notes.txt'};
const response=(value:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value} as Response);
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('resource preview refresh and reading position',()=>{
  it('recovers a failed read with a user refresh and aborts an older in-flight refresh',async()=>{
    const requests:Array<{signal:AbortSignal;finish:(value:Response)=>void}>=[];
    vi.stubGlobal('fetch',vi.fn((_url:string,options:RequestInit)=>new Promise<Response>(finish=>requests.push({signal:options.signal as AbortSignal,finish}))));
    render(<ResourcePreview file={file} handle={handle} review={review} xml={xml}/>);
    await act(async()=>requests[0].finish(response({error:'资源已被另一处移走'},404)));
    expect(screen.getByRole('status').textContent).toBe('资源已被另一处移走');
    fireEvent.click(screen.getByRole('button',{name:'刷新资源'}));
    expect(screen.getByRole('region',{name:'资源预览'}).getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'刷新资源'}));
    expect(requests[1].signal.aborted).toBe(true);
    await act(async()=>requests[2].finish(response({text:'文件恢复后的最新内容'})));
    expect(screen.getByText('文件恢复后的最新内容')).toBeDefined();
    await act(async()=>requests[1].finish(response({text:'迟到的旧内容'})));
    expect(screen.queryByText('迟到的旧内容')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('region',{name:'资源预览'}).getAttribute('aria-busy')).toBeNull();
  });

  it('keeps the current text and reading position across refresh and reports stale content when refresh fails',async()=>{
    const pending:Array<(value:Response)=>void>=[];
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(finish=>pending.push(finish))));
    const onScrollChange=vi.fn();
    const mounted=render(<ResourcePreview file={file} handle={handle} review={review} xml={xml} initialScroll={{top:240,left:32}} onScrollChange={onScrollChange}/>);
    await act(async()=>pending[0](response({text:'第一份长文本\n'.repeat(100)})));
    const pre=mounted.container.querySelector('pre')!;
    expect(pre.scrollTop).toBe(240);expect(pre.scrollLeft).toBe(32);
    fireEvent.scroll(pre,{target:{scrollTop:510,scrollLeft:60}});
    expect(onScrollChange).toHaveBeenLastCalledWith({top:510,left:60});
    fireEvent.click(screen.getByRole('button',{name:'刷新资源'}));
    expect(mounted.container.querySelector('pre')).toBe(pre);
    expect(pre.scrollTop).toBe(510);
    await act(async()=>pending[1](response({text:'第二份长文本\n'.repeat(100)})));
    expect(mounted.container.querySelector('pre')).toBe(pre);
    expect(pre.scrollTop).toBe(510);expect(pre.scrollLeft).toBe(60);
    expect(pre.textContent).toContain('第二份长文本');
    fireEvent.click(screen.getByRole('button',{name:'刷新资源'}));
    await act(async()=>pending[2](response({error:'读取权限被撤销'},403)));
    expect(screen.getByRole('status').textContent).toBe('读取权限被撤销 当前显示为上次读取的内容。');
    expect(pre.textContent).toContain('第二份长文本');expect(pre.scrollTop).toBe(510);
  });

  it('updates live feedback JSON without resetting its own scroll or adding a redundant refresh action',()=>{
    const mounted=render(<ResourcePreview file={{kind:'review',path:'article.review.json',name:'article.review.json'}} handle={handle} review={review} xml={xml} initialScroll={{top:200,left:10}}/>);
    const pre=mounted.container.querySelector('pre')!;
    expect(pre.scrollTop).toBe(200);
    fireEvent.scroll(pre,{target:{scrollTop:425,left:0}});
    const updated={...review,result:{author:'AI',summary:'新处理结果',appliedAt:'2026-09-12T09:00:00Z'}};
    mounted.rerender(<ResourcePreview file={{kind:'review',path:'article.review.json',name:'article.review.json'}} handle={handle} review={updated} xml={xml} initialScroll={{top:200,left:10}}/>);
    expect(pre.textContent).toContain('新处理结果');expect(pre.scrollTop).toBe(425);
    expect(screen.queryByRole('button',{name:'刷新资源'})).toBeNull();
  });

  it('restores each selected text resource only after its asynchronous content is available',async()=>{
    const pending:Array<(value:Response)=>void>=[];
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(finish=>pending.push(finish))));
    const mounted=render(<ResourcePreview file={file} handle={handle} review={review} xml={xml} initialScroll={{top:320,left:40}}/>);
    await act(async()=>pending[0](response({text:'第一份文本'})));
    expect(mounted.container.querySelector('pre')!.scrollTop).toBe(320);
    mounted.rerender(<ResourcePreview file={{...file,path:'second.txt',name:'second.txt'}} handle={handle} review={review} xml={xml} initialScroll={{top:160,left:12}}/>);
    expect(mounted.container.querySelector('pre')).toBeNull();
    await act(async()=>pending[1](response({text:'第二份文本'})));
    const pre=mounted.container.querySelector('pre')!;
    expect(pre.scrollTop).toBe(160);expect(pre.scrollLeft).toBe(12);
  });

  it('can reload an image after a load failure using a fresh resource URL',async()=>{
    render(<ResourcePreview file={{kind:'resource',path:'image.png',name:'image.png'}} handle={handle} review={review} xml={xml}/>);
    const first=screen.getByRole('img',{name:'image.png'});
    const firstURL=first.getAttribute('src');
    fireEvent.error(first);
    expect(screen.getByRole('status').textContent).toContain('图片不可读取');
    fireEvent.click(screen.getByRole('button',{name:'刷新资源'}));
    const second=screen.getByRole('img',{name:'image.png'});
    expect(second.getAttribute('src')).not.toBe(firstURL);
    fireEvent.load(second);
    await waitFor(()=>expect(screen.getByRole('region',{name:'资源预览'}).getAttribute('aria-busy')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
