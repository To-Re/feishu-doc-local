// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/ui/App';
import type { Snapshot } from '../src/core/types';

vi.mock('../src/ui/Reader',()=>({FormulaEditor:()=>null,Reader:(props:any)=><div><textarea aria-label="模拟正文" value={props.xml} onChange={e=>props.onEdit(e.target.value,props.getReview().comments,props.getDraft())}/><button onClick={()=>props.onSelection({from:1,to:3,quote:'原文',state:'attached'})}>选择正文</button></div>}));

const handle={id:'doc-1',name:'sample.xml',path:'/tmp/sample.xml',reviewPath:'/tmp/sample.review.json'};
const initial=()=>({xml:'<p>原文</p>',review:null,revision:'r1'} satisfies Snapshot);
const response=(value:unknown,status=200)=>Promise.resolve({ok:status>=200&&status<300,status,json:async()=>value} as Response);
let disk:Snapshot;
let writes:any[];
let put:((value:any)=>Promise<Response>)|null;
beforeEach(()=>{
  disk=initial();writes=[];put=null;
  vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit={})=>{
    if(url==='/api/session')return response({csrf:'csrf',document:handle,nativePicker:true});
    if(url==='/api/pick')return response(null);
    if(url.startsWith('/api/document')){
      if(options.method==='PUT'){
        const value=JSON.parse(String(options.body));writes.push(value);
        if(put)return put(value);
        disk={xml:value.xml,review:value.review,revision:'r'+(writes.length+1)};
        return response(disk);
      }
      return response(disk);
    }
    throw new Error('Unexpected request: '+url);
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
const ready=async()=>{render(<App/>);await screen.findByLabelText('模拟正文');};
const edit=(xml:string)=>fireEvent.change(screen.getByLabelText('模拟正文'),{target:{value:xml}});

describe('本地编辑与反馈交接',()=>{
  it('正文编辑自动保存真实写入载荷，不需要导出',async()=>{
    await ready();edit('<p>修改后的内容</p>');
    await waitFor(()=>expect(writes).toHaveLength(1),{timeout:2000});
    expect(writes[0].xml).toBe('<p>修改后的内容</p>');
    expect(writes[0].review.document.baselineXML).toBe('<p>原文</p>');
    expect(writes[0].review.document.xml).toBe(writes[0].xml);
    expect(writes[0].revision).toBe('r1');
    await screen.findByText('已保存到本地');
  });
  it.each(['编辑','只读'])('%s模式都可以选择正文并添加旁置评论',async(mode)=>{
    await ready();fireEvent.click(screen.getByRole('button',{name:mode}));
    fireEvent.click(screen.getByText('选择正文'));fireEvent.click(screen.getByText('评论选中内容'));
    fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'这里补一个具体例子'}});
    fireEvent.click(screen.getByRole('button',{name:'添加评论'}));
    await waitFor(()=>expect(writes).toHaveLength(1),{timeout:2000});
    expect(writes[0].xml).toBe('<p>原文</p>');
    expect(writes[0].review.comments[0].body).toBe('这里补一个具体例子');
    expect(writes[0].review.comments[0].anchor.quote).toBe('原文');
  });
  it('旧保存响应不能覆盖请求期间的新输入，新稿继续按新revision保存',async()=>{
    let resolveFirst!:(r:Response)=>void;
    put=async value=>{
      if(writes.length===1)return new Promise(resolve=>{resolveFirst=resolve;});
      disk={xml:value.xml,review:value.review,revision:'r3'};return response(disk);
    };
    await ready();edit('<p>第一版</p>');
    await waitFor(()=>expect(writes).toHaveLength(1),{timeout:2000});
    edit('<p>保存期间的新一版</p>');
    disk={xml:writes[0].xml,review:writes[0].review,revision:'r2'};resolveFirst(await response(disk));
    await waitFor(()=>expect(writes).toHaveLength(2),{timeout:2000});
    expect(writes[1].revision).toBe('r2');
    expect(writes[1].xml).toBe('<p>保存期间的新一版</p>');
    expect((screen.getByLabelText('模拟正文') as HTMLTextAreaElement).value).toBe(writes[1].xml);
  });
  it('保存已落盘但响应丢失时，回读确认成功，不重复覆盖',async()=>{
    put=async value=>{disk={xml:value.xml,review:value.review,revision:'r2'};throw new Error('连接中断');};
    await ready();edit('<p>已经落盘</p>');
    await waitFor(()=>expect(writes).toHaveLength(1),{timeout:2000});
    await screen.findByText('已保存到本地');
    expect(screen.queryByRole('alert')).toBeNull();expect(writes).toHaveLength(1);
  });
  it('另一浏览器改了评论时不覆盖，保留当前未保存输入',async()=>{
    put=async()=>{disk={...initial(),revision:'other'};return response({error:'正文或评论已在另一处修改'},409);};
    await ready();edit('<p>我还没保存的改动</p>');
    await screen.findByRole('alert',{}, {timeout:2500});
    expect((screen.getByLabelText('模拟正文') as HTMLTextAreaElement).value).toBe('<p>我还没保存的改动</p>');
    expect(screen.getByText('保存有冲突')).toBeTruthy();expect(writes).toHaveLength(1);
  });
  it('取消文件选择保留当前文档，不展示报错',async()=>{
    await ready();fireEvent.click(screen.getByRole('button',{name:'切换文档'}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'切换文档'}) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('模拟正文') as HTMLTextAreaElement).value).toBe('<p>原文</p>');
  });
});
