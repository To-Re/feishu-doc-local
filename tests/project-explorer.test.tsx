// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undoNoScroll } from '@tiptap/pm/history';
import { createReview, type Snapshot } from '../src/core/types';
import { App } from '../src/ui/App';
import { ResourcePreview } from '../src/ui/ProjectExplorer';

const captured=vi.hoisted(()=>({editor:null as Editor|null}));
vi.mock('../src/ui/Reader',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/ui/Reader')>();
  return {...actual,Reader:(props:React.ComponentProps<typeof actual.Reader>)=><actual.Reader {...props} onReady={editor=>{captured.editor=editor;props.onReady(editor);}}/>};
});
const handle={id:'doc',name:'article.xml',path:'/project/article.xml',reviewPath:'/project/article.review.json'};
const xml='<p>原文内容</p><source path="@assets/note.txt" name="note.txt"/><img path="@assets/image.png"/>';
const response=(value:unknown,status=200)=>Promise.resolve({ok:status>=200&&status<300,status,json:async()=>value} as Response);
let disk:Snapshot;
beforeEach(()=>{
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
  captured.editor=null;disk={xml,review:null,revision:'r1'};
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{
    if(url==='/api/session')return response({csrf:'test',document:handle,nativePicker:true});
    if(url.startsWith('/api/document')){
      if(options.method==='PUT'){const value=JSON.parse(String(options.body));disk={xml:value.xml,review:value.review,revision:'r2'};}
      return response(disk);
    }
    if(url.startsWith('/api/resource'))return response({path:'assets/note.txt',text:'<script>只读文本</script>\n中文😀'});
    throw new Error('unexpected '+url);
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('project resource navigation',()=>{
  it.each(['编辑','只读'])('%s restores the article reading position and opens comment quotations back in the visible article',async mode=>{
    let pageY=0;
    vi.spyOn(window,'scrollY','get').mockImplementation(()=>pageY);
    vi.mocked(window.scrollTo).mockImplementation((options:any)=>{pageY=options.top;});
    const review=createReview('article.xml',xml);
    review.comments.push({id:'quote',author:'我',body:'导航测试',createdAt:new Date().toISOString(),status:'open',replies:[],anchor:{from:1,to:3,quote:'原文',state:'attached'}});
    disk={...disk,review};
    render(<App/>);await waitFor(()=>expect(captured.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    const editor=captured.editor!;
    fireEvent.click(screen.getByRole('button',{name:mode}));
    // jsdom has no layout; let the real editor set its selection without asking
    // jsdom to physically scroll it. Browser verification covers its screen position.
    editor.view.setProps({handleScrollToSelection:()=>true});
    const tree=within(screen.getByRole('complementary',{name:'项目资源'}));
    pageY=3400;
    fireEvent.click(tree.getByRole('button',{name:'note.txt'}));
    await waitFor(()=>expect(screen.getByRole('region',{name:'资源预览'}).textContent).toContain('只读文本'));
    expect(pageY).toBe(0);
    fireEvent.click(tree.getByRole('button',{name:'article.xml'}));
    expect(pageY).toBe(3400);
    fireEvent.click(tree.getByRole('button',{name:'note.txt'}));
    fireEvent.click(screen.getByRole('button',{name:'原文'}));
    expect(screen.queryByRole('region',{name:'资源预览'})).toBeNull();
    expect(editor.view.dom.closest('[hidden]')).toBeNull();
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe('/project/article.xml');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(3);
    if(mode==='只读')expect(document.getSelection()?.toString()).toBe('原文');
  });
  it('keeps the real editor, undo and comment draft while switching XML, current JSON and resource previews',async()=>{
    render(<App/>);await waitFor(()=>expect(captured.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    const editor=captured.editor!, dom=editor.view.dom;
    const tree=within(screen.getByRole('complementary',{name:'项目资源'}));
    expect(tree.getByRole('button',{name:'article.xml'}).getAttribute('aria-current')).toBe('page');
    act(()=>{editor.view.dispatch(editor.state.tr.insertText('已改',1));editor.commands.setTextSelection({from:1,to:3});});
    fireEvent.click(screen.getByRole('button',{name:'评论选中内容'}));
    fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'保留未发送的意见'}});
    const beforePreview=editor.state.doc;
    fireEvent.click(tree.getByRole('button',{name:/article.review.json/}));
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe('/project/article.review.json');
    expect(screen.getByRole('region',{name:'资源预览'}).textContent).toContain('已改原文内容');
    expect(screen.getByText('以下评论仍属于正文 article.xml。点击 XML 可返回编辑。')).toBeDefined();
    expect(dom.isConnected).toBe(true);expect(captured.editor).toBe(editor);expect(editor.state.doc).toBe(beforePreview);
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('保留未发送的意见');
    fireEvent.click(tree.getByRole('button',{name:'note.txt'}));
    await waitFor(()=>expect(screen.getByRole('region',{name:'资源预览'}).textContent).toContain('<script>只读文本</script>'));
    expect(screen.getByRole('region',{name:'资源预览'}).querySelector('script')).toBeNull();
    fireEvent.click(tree.getByRole('button',{name:'image.png'}));
    expect(screen.getByRole('img',{name:'image.png'}).getAttribute('src')).toContain('/api/asset?');
    fireEvent.click(tree.getByRole('button',{name:'article.xml'}));
    expect(screen.queryByRole('region',{name:'资源预览'})).toBeNull();
    expect(editor.view.dom).toBe(dom);expect(editor.state.doc).toBe(beforePreview);
    act(()=>{expect(undoNoScroll(editor.state,transaction=>editor.view.dispatch(transaction))).toBe(true);});
    expect(editor.state.doc.firstChild!.textContent).toBe('原文内容');
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('保留未发送的意见');
    expect(screen.getAllByRole('button',{name:'收起文档导航'})).toHaveLength(1);
    expect(screen.queryByRole('button',{name:'展开文档导航'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'收起文档导航'}));
    expect(screen.queryByRole('complementary',{name:'项目资源'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'展开文档导航'}));
    expect(screen.getByRole('complementary',{name:'项目资源'})).toBeDefined();
  });
  it('keeps folder expansion, both scroll positions and the selected resource when collapsing the file panel',async()=>{
    render(<App/>);await waitFor(()=>expect(captured.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    const editor=captured.editor!;
    const panel=screen.getByRole('complementary',{name:'项目资源'});
    const tree=within(panel);
    fireEvent.click(tree.getByRole('button',{name:'note.txt'}));
    const preview=await screen.findByRole('region',{name:'资源预览'});
    await waitFor(()=>expect(preview.textContent).toContain('只读文本'));
    const pre=preview.querySelector('pre')!;
    pre.scrollTop=120;pre.scrollLeft=48;fireEvent.scroll(pre);
    fireEvent.click(tree.getByRole('button',{name:'assets'}));
    panel.scrollTop=180;fireEvent.scroll(panel);
    const toggle=screen.getByRole('button',{name:'收起文档导航'});
    expect(toggle.closest('header[aria-label="文档工作区"]')).not.toBeNull();
    expect(tree.queryByRole('button',{name:'收起文档导航'})).toBeNull();
    fireEvent.click(toggle);
    const reopen=screen.getByRole('button',{name:'展开文档导航'});
    expect(reopen).toBe(toggle);
    expect(document.activeElement).toBe(reopen);
    expect(reopen.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button',{name:'收起文档导航'})).toBeNull();
    expect(screen.getByRole('region',{name:'资源预览'})).toBe(preview);
    expect(pre.scrollTop).toBe(120);expect(pre.scrollLeft).toBe(48);
    fireEvent.click(reopen);
    expect(screen.getByRole('complementary',{name:'项目资源'})).toBe(panel);
    expect(panel.scrollTop).toBe(180);
    expect(tree.getByRole('button',{name:'assets'}).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button',{name:'收起文档导航'})).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button',{name:'展开文档导航'})).toBeNull();
    fireEvent.click(tree.getByRole('button',{name:'assets'}));
    expect(tree.getByRole('button',{name:'note.txt'}).getAttribute('aria-current')).toBe('page');
    expect(captured.editor).toBe(editor);
    expect(pre.scrollTop).toBe(120);expect(pre.scrollLeft).toBe(48);
  });
  it('shows document modes only for the article and restores its previous mode after a resource preview',async()=>{
    render(<App/>);await waitFor(()=>expect(captured.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    fireEvent.click(screen.getByRole('button',{name:'只读'}));
    expect(captured.editor!.isEditable).toBe(false);
    fireEvent.click(within(screen.getByRole('complementary',{name:'项目资源'})).getByRole('button',{name:'image.png'}));
    expect(screen.queryByRole('button',{name:'编辑'})).toBeNull();
    expect(screen.queryByRole('button',{name:'只读'})).toBeNull();
    expect(screen.getByText('资源 · 只读')).toBeDefined();
    fireEvent.click(screen.getByRole('button',{name:'返回正文'}));
    expect(screen.getByRole('button',{name:'只读'}).classList.contains('selected')).toBe(true);
    expect(captured.editor!.isEditable).toBe(false);
    expect(screen.queryByText('LOCAL DOCUMENT')).toBeNull();
  });
  it('does not show a late response from a previously selected resource and displays server errors verbatim',async()=>{
    let finish!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('first.txt')?new Promise<Response>(resolve=>{finish=resolve;}):response({error:'文本资源需小于 2 MB。'},413)));
    const review=createReview('article.xml',xml);
    const mounted=render(<ResourcePreview file={{kind:'resource',path:'first.txt',name:'first.txt'}} handle={handle} xml={xml} review={review}/>);
    mounted.rerender(<ResourcePreview file={{kind:'resource',path:'second.txt',name:'second.txt'}} handle={handle} xml={xml} review={review}/>);
    await screen.findByText('文本资源需小于 2 MB。');
    await act(async()=>{finish(await response({text:'old resource'}));});
    expect(screen.queryByText('old resource')).toBeNull();
    expect(screen.getByText('文本资源需小于 2 MB。')).toBeDefined();
  });
});
