// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { DocumentOutline, documentHeadings } from '../src/ui/DocumentOutline';

const editors:Editor[]=[];
function editor(xml:string) {
  const instance=new Editor({element:document.createElement('div'),extensions:xmlExtensions(path=>path),content:parseDocxXML(xml).content});
  editors.push(instance);return instance;
}
afterEach(()=>{cleanup();for(const item of editors.splice(0))if(!item.isDestroyed)item.destroy();vi.restoreAllMocks();});

describe('document outline',()=>{
  it('includes all actual heading levels, even when a document starts at h3',()=>{
    const instance=editor('<title>文档标题</title><p>正文</p>'+Array.from({length:7},(_,i)=>`<h${i+3}>标题${i+3}</h${i+3}>`).join(''));
    render(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}}/>);
    expect(documentHeadings(instance).map(item=>item.level)).toEqual([3,4,5,6,7,8,9]);
    for(let i=3;i<=9;i++)expect(screen.getByRole('button',{name:`${i} 级标题：标题${i}`})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/文档标题/})).toBeNull();
  });
  it('updates headings immediately after text, level, insertion and removal changes',()=>{
    const instance=editor('<h2>旧标题</h2><p>正文</p>');
    render(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}}/>);
    act(()=>{instance.commands.setContent(parseDocxXML('<h4>新标题</h4><h9>末级</h9>').content);});
    expect(screen.queryByRole('button',{name:'2 级标题：旧标题'})).toBeNull();
    expect(screen.getByRole('button',{name:'4 级标题：新标题'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'9 级标题：末级'})).toBeTruthy();
    act(()=>{instance.commands.setContent(parseDocxXML('<p>只有正文</p>').content);});
    expect(screen.getByText('添加标题后，目录会显示在这里。')).toBeTruthy();
  });
  it('locates duplicate headings by position without changing selection, content or history',()=>{
    const instance=editor('<h2>重复标题</h2><p>选中评论正文</p><h2>重复标题</h2>');
    instance.commands.setTextSelection({from:9,to:11});
    const selection=instance.state.selection,doc=instance.state.doc,transactions=vi.fn();
    instance.on('transaction',transactions);
    const second=instance.view.nodeDOM(documentHeadings(instance)[1].position) as HTMLElement;
    second.scrollIntoView=vi.fn();
    render(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}}/>);
    fireEvent.mouseDown(screen.getAllByRole('button',{name:'2 级标题：重复标题'})[1]);
    fireEvent.click(screen.getAllByRole('button',{name:'2 级标题：重复标题'})[1]);
    expect(second.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({block:'center'}));
    expect(instance.state.selection).toBe(selection);expect(instance.state.doc).toBe(doc);expect(transactions).not.toHaveBeenCalled();
  });
  it('refreshes after an external document replacement that bypasses editor update events',()=>{
    const instance=editor('<h1>旧稿</h1>');
    const view=render(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}} revision="before"/>);
    act(()=>{instance.view.updateState(EditorState.create({schema:instance.schema,doc:instance.schema.nodeFromJSON(parseDocxXML('<h8>AI 新稿</h8>').content),plugins:instance.state.plugins}));});
    view.rerender(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}} revision="after"/>);
    expect(screen.queryByRole('button',{name:'1 级标题：旧稿'})).toBeNull();
    expect(screen.getByRole('button',{name:'8 级标题：AI 新稿'})).toBeTruthy();
  });
  it('preserves the toggle in the same header position while collapsed',()=>{
    const instance=editor('<h1>标题</h1>');
    function Controlled(){const [collapsed,setCollapsed]=useState(false);return <DocumentOutline editor={instance} collapsed={collapsed} onToggle={()=>setCollapsed(value=>!value)}/>;}
    render(<Controlled/>);
    const button=screen.getByRole('button',{name:'收起文档目录'}),parent=button.parentElement;
    fireEvent.click(button);
    const expand=screen.getByRole('button',{name:'展开文档目录'});
    expect(expand).toBe(button);expect(expand.parentElement).toBe(parent);expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button',{name:'1 级标题：标题'})).toBeNull();
    fireEvent.click(expand);expect(screen.getByRole('button',{name:'1 级标题：标题'})).toBeTruthy();
  });
  it('cleans old editor subscriptions when replacing the document or unmounting',()=>{
    const first=editor('<h1>第一篇</h1>'),second=editor('<h1>第二篇</h1>');
    const off=vi.spyOn(first,'off');
    const view=render(<DocumentOutline editor={first} collapsed={false} onToggle={()=>{}}/>);
    view.rerender(<DocumentOutline editor={second} collapsed={false} onToggle={()=>{}}/>);
    expect(off).toHaveBeenCalledWith('update',expect.any(Function));expect(off).toHaveBeenCalledWith('destroy',expect.any(Function));
    act(()=>{first.commands.setContent(parseDocxXML('<h1>不应出现</h1>').content);});
    expect(screen.getByRole('button',{name:'1 级标题：第二篇'})).toBeTruthy();expect(screen.queryByText('不应出现')).toBeNull();
    const offSecond=vi.spyOn(second,'off');view.unmount();expect(offSecond).toHaveBeenCalledWith('update',expect.any(Function));
  });
  it('shows safe text labels and complete titles for rich or empty headings',()=>{
    const long='很长的标题'.repeat(40),instance=editor(`<h1><b>粗体</b>与<i>斜体</i></h1><h2></h2><h3>${long}</h3>`);
    render(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}}/>);
    expect(screen.getByRole('button',{name:'1 级标题：粗体与斜体'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'2 级标题：未命名标题'})).toBeTruthy();
    expect(screen.getByRole('button',{name:`3 级标题：${long}`}).getAttribute('title')).toBe(long);
  });
  it('works without an editor and clears headings after editor destruction',()=>{
    const view=render(<DocumentOutline editor={null} collapsed={false} onToggle={()=>{}}/>);
    expect(screen.getByText('打开正文后显示目录。')).toBeTruthy();
    const instance=editor('<h1>标题</h1>');view.rerender(<DocumentOutline editor={instance} collapsed={false} onToggle={()=>{}}/>);
    act(()=>{instance.destroy();});expect(documentHeadings(instance)).toEqual([]);
    expect(screen.queryByRole('button',{name:'1 级标题：标题'})).toBeNull();
  });
});
