// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { App } from '../src/ui/App';
import type { Snapshot } from '../src/core/types';

const captured=vi.hoisted(()=>({editor:null as Editor|null}));
vi.mock('../src/ui/Reader',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/ui/Reader')>();
  return {...actual,Reader:(props:React.ComponentProps<typeof actual.Reader>)=><actual.Reader {...props} onReady={editor=>{captured.editor=editor;props.onReady(editor);}}/>};
});
const handle={id:'outline',name:'article.xml',path:'/outline/article.xml',reviewPath:'/outline/article.review.json'};
const xml='<h3>开始三级</h3><p>可选中评论正文</p><h9>最后一级</h9><source path="@assets/note.txt" name="note.txt"/>';
const response=(value:unknown)=>Promise.resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}));
let disk:Snapshot;
beforeEach(()=>{
  localStorage.clear();captured.editor=null;disk={xml,review:null,revision:'r1'};
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{
    if(url==='/api/session')return response({csrf:'test',document:handle,nativePicker:false});
    if(url==='/api/projects')return response({projects:[],cloudAvailable:false});
    if(url==='/api/project-settings')return response({shared:false,path:'/outline/projects.json',defaultSharedPath:'/outline/shared.json'});
    if(url.startsWith('/api/document')){if(options.method==='PUT'){const value=JSON.parse(String(options.body));disk={xml:value.xml,review:value.review,revision:'r2'};}return response(disk);}
    if(url.startsWith('/api/resource'))return response({path:'assets/note.txt',text:'资源预览'});
    throw new Error('Unexpected request '+url);
  }));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function open(){
  // The HTTP fixture resolves immediately. Flush its React work directly rather
  // than starting a one-second DOM poll that includes unrelated build CPU time.
  await act(async()=>{render(<App/>);});
  expect(screen.getByRole('button',{name:'3 级标题：开始三级'})).toBeTruthy();return captured.editor!;
}
const mode=(name:string)=>screen.getByRole('button',{name});

describe('Node editor outline integration',()=>{
  it('shows the outline by default and preserves file tree state when switching navigation tabs',async()=>{
    await open();expect(screen.getByRole('button',{name:'目录'}).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('complementary',{name:'项目资源'})).toBeNull();
    fireEvent.click(mode('文件'));
    const panel=screen.getByRole('complementary',{name:'项目资源'});
    fireEvent.click(within(panel).getByRole('button',{name:'assets'}));
    fireEvent.click(mode('目录'));expect(panel.isConnected).toBe(true);expect(panel.hidden).toBe(true);
    fireEvent.click(mode('文件'));expect(within(panel).getByRole('button',{name:'assets'}).getAttribute('aria-expanded')).toBe('false');
  });
  it('uses one fixed header toggle through collapse and expansion',async()=>{
    await open();const close=mode('收起文档导航');
    expect(close.closest('header[aria-label="文档工作区"]')).not.toBeNull();
    expect(screen.queryByRole('button',{name:'收起文档目录'})).toBeNull();
    fireEvent.click(close);expect(mode('展开文档导航')).toBe(close);expect(screen.queryByRole('navigation',{name:'文档目录'})).toBeNull();
    fireEvent.click(close);expect(mode('收起文档导航')).toBe(close);expect(screen.getByRole('button',{name:'9 级标题：最后一级'})).toBeTruthy();
  });
  it.each(['编辑','只读'])('navigates in %s without losing selection or an unsent comment',async(name)=>{
    const editor=await open();fireEvent.click(mode(name));
    act(()=>{editor.commands.setTextSelection({from:9,to:12});});
    fireEvent.click(screen.getByRole('button',{name:'评论选中内容'}));fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'保留意见'} });
    const before=editor.state.selection,doc=editor.state.doc,heading=editor.view.dom.querySelector('h9')!;
    heading.scrollIntoView=vi.fn();
    fireEvent.mouseDown(screen.getByRole('button',{name:'9 级标题：最后一级'}));fireEvent.click(screen.getByRole('button',{name:'9 级标题：最后一级'}));
    expect(heading.scrollIntoView).toHaveBeenCalled();expect(editor.state.selection).toBe(before);expect(editor.state.doc).toBe(doc);
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('保留意见');
  });
  it('returns from valid source to the last visual mode, but keeps invalid source and explains why navigation is blocked',async()=>{
    const editor=await open();fireEvent.click(mode('只读'));fireEvent.click(mode('源码'));
    const heading=editor.view.dom.querySelector('h9')!;heading.scrollIntoView=vi.fn();
    fireEvent.click(screen.getByRole('button',{name:'9 级标题：最后一级'}));
    expect(mode('只读').getAttribute('aria-pressed')).toBe('true');expect(heading.scrollIntoView).toHaveBeenCalled();
    fireEvent.click(mode('源码'));const source=screen.getByLabelText('文档源码') as HTMLTextAreaElement;
    fireEvent.change(source,{target:{value:'<h2>尚未闭合'}});fireEvent.click(screen.getByRole('button',{name:'9 级标题：最后一级'}));
    expect(source.value).toBe('<h2>尚未闭合');expect(mode('源码').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('源码尚未通过校验，请先修正或还原源码，再通过目录返回正文。输入已保留。')).toBeTruthy();
  });
  it('returns from a resource preview to the requested heading without recreating the editor',async()=>{
    const editor=await open(),dom=editor.view.dom;
    fireEvent.click(mode('文件'));fireEvent.click(within(screen.getByRole('complementary',{name:'项目资源'})).getByRole('button',{name:'note.txt'}));
    await screen.findByRole('region',{name:'资源预览'});fireEvent.click(mode('目录'));
    const heading=dom.querySelector('h9')!;heading.scrollIntoView=vi.fn();fireEvent.click(screen.getByRole('button',{name:'9 级标题：最后一级'}));
    expect(screen.queryByRole('region',{name:'资源预览'})).toBeNull();expect(dom.closest('[hidden]')).toBeNull();expect(captured.editor).toBe(editor);expect(heading.scrollIntoView).toHaveBeenCalled();
  });
  it('updates outline after source replacements using the real Reader external-state path',async()=>{
    await open();fireEvent.click(mode('源码'));fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:'<h8>最新八级标题</h8><p>新正文</p>'}});
    await screen.findByRole('button',{name:'8 级标题：最新八级标题'});expect(screen.queryByRole('button',{name:'3 级标题：开始三级'})).toBeNull();
  });
});
