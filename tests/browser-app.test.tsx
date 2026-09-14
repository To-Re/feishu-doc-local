// @vitest-environment jsdom
import React from 'react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserApp } from '../src/browser/BrowserApp';
import { createReview, type Review, type Snapshot } from '../src/core/types';
import type { BrowserDocument, BrowserDocumentStore } from '../src/browser/files';
import { RESOURCE_REFRESH } from '../src/core/resources';

// Keep the real editor, serialization, selection mapping and sidebar controls.
// Only the browser's directory capability boundary is replaced here; actual
// two-file writes and recovery are covered separately in browser-files tests.
const mocks=vi.hoisted(()=>({choose:vi.fn(),editor:null as Editor|null}));
vi.mock('../src/browser/files',()=>({chooseBrowserDirectory:mocks.choose}));
vi.mock('../src/ui/Reader',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/ui/Reader')>();
  return{...actual,Reader:(props:React.ComponentProps<typeof actual.Reader>)=><actual.Reader {...props} onReady={editor=>{mocks.editor=editor;props.onReady(editor);}}/>};
});
const original='<p id="p-one">第一篇正文</p><unknown data-preserve="yes">完整保留</unknown>';
const snapshot=(xml:string,revision='r0'):Snapshot=>({xml,revision,review:createReview('a.xml',xml)});
const copy=<T,>(value:T):T=>structuredClone(value);
const geometry=['getClientRects','getBoundingClientRect'].map(name=>({name,descriptor:Object.getOwnPropertyDescriptor(Range.prototype,name)}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
let disk:Map<string,Snapshot>,docs:Map<string,BrowserDocument>,store:BrowserDocumentStore;
let writes:Array<{name:string;xml:string;review:Review;revision:string}>;
let saveOverride:((name:string,xml:string,review:Review,revision:string)=>Promise<Snapshot>)|undefined;
let permissionFailure:boolean,resourceVersion:string;

function documentFor(name:string):BrowserDocument{
  const document:BrowserDocument={
    handle:{id:name,name,path:'资料/'+name,reviewPath:'资料/'+name.replace(/\.xml$/,'.review.json')},
    read:vi.fn(async()=>{if(permissionFailure)throw Object.assign(new Error('需要重新授权目录'),{status:403});return copy(disk.get(name)!);}),
    save:vi.fn(async(xml,review,revision)=>{
      writes.push({name,xml,review:copy(review),revision});
      if(permissionFailure)throw Object.assign(new Error('需要重新授权目录'),{status:403});
      if(saveOverride)return saveOverride(name,xml,review,revision);
      if(revision!==disk.get(name)!.revision)throw Object.assign(new Error('本地文件发生冲突'),{status:409});
      const saved={xml,review:copy(review),revision:revision+'+'};disk.set(name,saved);return copy(saved);
    }),
    requestPermission:vi.fn(async()=>{permissionFailure=false;}),
    get resourceRevision(){return resourceVersion;},
    assetURL:vi.fn(()=> 'data:,'),
    readResource:vi.fn(async path=>({path,text:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><text x="1" y="15">本地 SVG</text></svg>'})),
    dispose:vi.fn(),
  };docs.set(name,document);return document;
}
beforeEach(()=>{
  mocks.choose.mockReset();mocks.editor=null;permissionFailure=false;resourceVersion='resources:0';saveOverride=undefined;writes=[];
  disk=new Map([['a.xml',snapshot(original)],['b.xml',snapshot('<p>另一篇本地文档</p>')]]);docs=new Map();
  store={directoryName:'资料',listDocuments:vi.fn(async()=>[...disk.keys()]),open:vi.fn(async name=>documentFor(name)),
    create:vi.fn(async(name,title)=>{if(disk.has(name))throw new Error('已有同名文件，不会覆盖');if(!name.endsWith('.xml'))throw new Error('文件名须以 .xml 结尾');disk.set(name,snapshot('<title>'+(title||name)+'</title><p></p>'));return documentFor(name);}),dispose:vi.fn()};
  mocks.choose.mockResolvedValue(store);vi.stubGlobal('showDirectoryPicker',vi.fn());
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('BrowserApp must not call the local HTTP service');}));
  if(!Range.prototype.getClientRects)Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
  if(!Range.prototype.getBoundingClientRect)Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
});
afterEach(()=>{
  cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
  for(const{name,descriptor}of geometry){if(descriptor)Object.defineProperty(Range.prototype,name,descriptor);else delete (Range.prototype as unknown as Record<string,unknown>)[name];}
});
async function open(){render(<BrowserApp/>);fireEvent.click(screen.getByRole('button',{name:'选择本地目录'}));await waitFor(()=>expect(mocks.editor?.getText()).toContain('第一篇正文'));}
function edit(text:string){act(()=>{const editor=mocks.editor!;editor.commands.setTextSelection(3);editor.commands.insertContent(text);});}
function select(){act(()=>{mocks.editor!.commands.setTextSelection({from:1,to:4});});}
async function addComment(body='请补充例子'){
  select();fireEvent.click(await screen.findByRole('button',{name:'评论选中内容'}));fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:body}});fireEvent.click(screen.getByRole('button',{name:'添加评论'}));
  await waitFor(()=>expect(disk.get('a.xml')!.review!.comments).toHaveLength(1));
}

describe('standalone browser document workflow',()=>{
  it.each(['open','resolved'] as const)('reopens a legacy %s cloud import at the precise quote and preserves the disk revision until a normal save',async status=>{
    const prefix='第一篇正文前文。',quote='已保存的完整引用😀。'.repeat(60),suffix='不属于引用的后文';
    const xml='<p id="paragraph">'+prefix+quote+suffix+'</p>',loaded=snapshot(xml),review=loaded.review!;
    const cloud={id:'remote',author:'协作者',body:'云端留下的意见',createdAt:'2026-09-14T00:00:00Z',status,quote,blockId:'paragraph',replies:[]};
    const id='cloud:test-document:remote';
    review.comments=[{id,author:cloud.author,body:cloud.body,createdAt:cloud.createdAt,status,
      anchor:{from:1,to:prefix.length+quote.length+suffix.length+1,quote,state:'attached'},replies:[]}];
    review.cloudSync={version:1,documentId:'test-document',url:'https://example.feishu.cn/docx/test-document',
      links:[{localId:id,cloudId:cloud.id,body:cloud.body,cloudBody:cloud.body,status,replies:{},remote:cloud}]};
    const originalReview=copy(review);disk.set('a.xml',loaded);await open();
    if(status==='resolved')fireEvent.click(screen.getByRole('button',{name:'查看已解决评论'}));
    const mark=screen.getByLabelText('文章正文').querySelector('.comment-highlight');
    expect(mark?.textContent).toBe(quote);expect(screen.getByRole('button',{name:quote}).textContent).toBe(quote);
    const ranges:string[]=[];
    vi.spyOn(Range.prototype,'getClientRects').mockImplementation(function(this:Range){ranges.push(this.toString());return [new DOMRect(0,900,100,20)] as unknown as DOMRectList;});
    fireEvent.click(screen.getByRole('button',{name:quote}));expect(ranges).toContain(quote);
    expect(writes).toHaveLength(0);expect(disk.get('a.xml')!.review).toEqual(originalReview);
    fireEvent.click(screen.getByRole('button',{name:status==='open'?'解决':'重新打开'}));
    await waitFor(()=>expect(writes).toHaveLength(1));
    expect(writes[0].revision).toBe('r0');expect(writes[0].review.comments[0].anchor).toEqual({from:prefix.length+1,to:prefix.length+quote.length+1,quote,state:'attached'});
    expect(writes[0].xml).toBe(xml);expect(writes[0].review.cloudSync).toEqual(originalReview.cloudSync);expect(fetch).not.toHaveBeenCalled();
  });
  it('renders cloud author ids as labels with a separate resolved status while preserving quotes and stored identities',async()=>{
    const review=disk.get('a.xml')!.review!;
    const base={author:'ou_sample_account',body:'导入的意见',createdAt:'2026-09-14T00:00:00Z',status:'open' as const,
      anchor:{from:1,to:7,quote:'第一篇正文',state:'attached' as const},replies:[]};
    review.comments.push({...base,id:'cloud:doc:open',replies:[
      {id:'cloud-reply:opaque',author:'on_sample_account',body:'导入的回复',createdAt:base.createdAt},
      {id:'local-reply',author:'cli_本地署名',body:'本地回复',createdAt:base.createdAt},
    ]},{...base,id:'cloud:doc:resolved',status:'resolved',body:'已处理的意见'},
    {...base,id:'cloud:doc:named',author:'文档协作者',body:'具名意见'},
    {...base,id:'local-comment',author:'ou_local_author',body:'本地意见'});
    const before=JSON.stringify(review);await open();
    fireEvent.click(screen.getByRole('button',{name:'查看已解决评论'}));
    expect(screen.getAllByText('飞书用户')).toHaveLength(3);
    expect(screen.getByTitle('on_sample_account').textContent).toBe('飞书用户');
    expect(screen.getByText('文档协作者')).toBeTruthy();expect(screen.getByText('ou_local_author')).toBeTruthy();
    expect(screen.getByText('cli_本地署名')).toBeTruthy();
    const resolved=screen.getByText('已处理的意见').closest('article')!;
    expect(within(resolved).getByText('已解决').className).toBe('browser-comment-status');
    expect(within(resolved).getByRole('button',{name:'第一篇正文'}).textContent).toBe(base.anchor.quote);
    expect(within(resolved).getByRole('button',{name:'重新打开'})).toBeTruthy();
    expect(JSON.stringify(disk.get('a.xml')!.review)).toBe(before);expect(writes).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps directory files available while offering a collapsible article outline',async()=>{
    disk.set('a.xml',snapshot('<h1>测试章节</h1><p>第一篇正文</p>'));await open();
    expect(screen.getByRole('button',{name:'b.xml'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'目录'}));
    expect(await screen.findByRole('button',{name:'1 级标题：测试章节'})).toBeTruthy();
    const toggle=screen.getByRole('button',{name:'收起文档导航'});fireEvent.click(toggle);
    expect(screen.getByRole('button',{name:'展开文档导航'})).toBe(toggle);
    expect(screen.queryByRole('button',{name:'文件'})).toBeNull();
    expect(screen.queryByRole('navigation',{name:'文档目录'})).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button',{name:'文件'}));expect(screen.getByRole('button',{name:'b.xml'})).toBeTruthy();
    fireEvent.click(toggle);expect(screen.queryByRole('button',{name:'b.xml'})).toBeNull();
    fireEvent.click(toggle);expect(screen.getByRole('button',{name:'b.xml'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'文件'}).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button',{name:'收起文档目录'})).toBeNull();
    expect(writes).toHaveLength(0);
  });
  it('shows an honest read-only example when the directory API is unavailable',async()=>{
    vi.stubGlobal('showDirectoryPicker',undefined);render(<BrowserApp/>);
    expect(screen.getByText(/此浏览器不支持直接读写本地目录/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'选择本地目录'})as HTMLButtonElement).disabled).toBe(true);
    await waitFor(()=>expect(mocks.editor?.isEditable).toBe(false));expect(mocks.choose).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('calls the picker from the click, preserves cancellation, switches root files and creates without overwriting',async()=>{
    await open();expect(mocks.choose).toHaveBeenCalledTimes(1);expect(screen.getByText('资料/a.xml')).toBeTruthy();
    mocks.choose.mockResolvedValueOnce(null);fireEvent.click(screen.getByRole('button',{name:'切换目录'}));
    expect(mocks.choose).toHaveBeenCalledTimes(2);await waitFor(()=>expect((screen.getByRole('button',{name:'切换目录'})as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.editor!.getText()).toContain('第一篇正文');expect(store.dispose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));await waitFor(()=>expect(mocks.editor!.getText()).toContain('另一篇本地文档'));
    expect(docs.get('a.xml')!.dispose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button',{name:'新建文档'}));const dialog=screen.getByRole('dialog');
    expect(document.activeElement).toBe(screen.getByLabelText('新文档文件名'));
    fireEvent.change(screen.getByLabelText('新文档文件名'),{target:{value:'a.xml'}});fireEvent.click(within(dialog).getByRole('button',{name:'创建文档'}));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent','已有同名文件，不会覆盖');expect(disk.get('a.xml')!.xml).toBe(original);
    fireEvent.change(screen.getByLabelText('新文档文件名'),{target:{value:'新稿.xml'}});fireEvent.change(screen.getByLabelText('新文档标题'),{target:{value:'新文章'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'创建文档'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('资料/新稿.xml')).toBeTruthy();expect(mocks.editor!.getText()).toContain('新文章');expect(fetch).not.toHaveBeenCalled();
  });
  it('auto-saves real editor changes while preserving unknown XML and saves selection comments separately',async()=>{
    await open();edit('新增');await waitFor(()=>expect(disk.get('a.xml')!.xml).toContain('新增'));
    expect(disk.get('a.xml')!.xml).toContain('<unknown data-preserve="yes">完整保留</unknown>');
    await addComment();const saved=disk.get('a.xml')!;
    expect(saved.review!.comments[0]).toMatchObject({body:'请补充例子',anchor:{state:'attached',quote:'第一新'}});
    expect(saved.xml).not.toContain('请补充例子');expect(saved.review!.operations.some(operation=>operation.type==='comment.add')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'只读'}));expect(mocks.editor!.isEditable).toBe(false);
    select();expect(await screen.findByRole('button',{name:'评论选中内容'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'解决'}));await waitFor(()=>expect(disk.get('a.xml')!.review!.comments[0].status).toBe('resolved'));
  });
  it('retains later typing when an earlier save completes and uses its new revision for the next write',async()=>{
    await open();const saving=deferred<Snapshot>();saveOverride=()=>saving.promise;
    edit('先');await waitFor(()=>expect(writes).toHaveLength(1));edit('后');
    const first=writes[0];disk.set('a.xml',{xml:first.xml,review:first.review,revision:'r1'});saveOverride=undefined;
    await act(async()=>saving.resolve(copy(disk.get('a.xml')!)));
    expect(mocks.editor!.getText()).toContain('后');await waitFor(()=>expect(writes).toHaveLength(2));
    expect(writes[1].revision).toBe('r1');expect(disk.get('a.xml')!.xml).toContain('后');
  });
  it('keeps invalid source on screen, blocks visual mode and switching, and saves only after correction',async()=>{
    await open();fireEvent.click(screen.getByRole('button',{name:'源码'}));fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:'<p>尚未闭合'}});
    expect((screen.getByRole('button',{name:'编辑'})as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'只读'})as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));fireEvent.click(screen.getByRole('button',{name:'切换目录'}));
    expect(mocks.choose).toHaveBeenCalledTimes(1);expect(store.open).toHaveBeenCalledTimes(1);expect(writes).toHaveLength(0);
    expect((screen.getByLabelText('文档源码')as HTMLTextAreaElement).value).toBe('<p>尚未闭合');expect(disk.get('a.xml')!.xml).toBe(original);
    fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:'<p>修改后的源码</p>'}});await waitFor(()=>expect(disk.get('a.xml')!.xml).toBe('<p>修改后的源码</p>'));
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));expect(mocks.editor!.getText()).toBe('修改后的源码');
  });
  it('blocks switching for unsent comments and replies and only releases their explicit completion',async()=>{
    await open();select();fireEvent.click(screen.getByRole('button',{name:'评论选中内容'}));fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'未发出的评论'}});
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));expect(store.open).toHaveBeenCalledTimes(1);expect((screen.getByLabelText('评论内容')as HTMLTextAreaElement).value).toBe('未发出的评论');
    fireEvent.click(screen.getByRole('button',{name:'取消评论'}));await addComment();
    fireEvent.click(screen.getByRole('button',{name:'回复'}));
    fireEvent.change(screen.getByLabelText('回复评论：请补充例子'),{target:{value:'还没提交的回复'}});fireEvent.click(screen.getByRole('button',{name:'源码'}));
    expect(screen.queryByLabelText('文档源码')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'b.xml'}));expect(store.open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'发送回复'}));await waitFor(()=>expect(disk.get('a.xml')!.review!.comments[0].replies).toHaveLength(1));
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));await waitFor(()=>expect(mocks.editor!.getText()).toContain('另一篇本地文档'));
  });
  it('loads a clean external revision but preserves an unsent comment during later external changes',async()=>{
    await open();disk.set('a.xml',snapshot('<p>来自 AI 的修改</p>','r1'));fireEvent(window,new Event('focus'));
    await waitFor(()=>expect(mocks.editor!.getText()).toContain('来自 AI 的修改'));
    select();fireEvent.click(screen.getByRole('button',{name:'评论选中内容'}));fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'评论草稿不能丢'}});
    disk.set('a.xml',snapshot('<p>第二次 AI 修改</p>','r2'));fireEvent(window,new Event('focus'));
    await waitFor(()=>expect(screen.getByText(/本页输入已保留/)).toBeTruthy());expect(mocks.editor!.getText()).toContain('来自 AI 的修改');expect(writes).toHaveLength(0);
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'重新读取本地文件'}));
    expect(confirm).toHaveBeenCalledOnce();expect((screen.getByLabelText('评论内容')as HTMLTextAreaElement).value).toBe('评论草稿不能丢');
    confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'重新读取本地文件'}));
    await waitFor(()=>expect(mocks.editor!.getText()).toContain('第二次 AI 修改'));expect(screen.queryByLabelText('评论内容')).toBeNull();
  });
  it('rejects a stale save, keeps local typing, and prevents switching until conflict is resolved',async()=>{
    await open();edit('我的未保存内容');disk.set('a.xml',snapshot('<p>并发的磁盘内容</p>','external'));
    await waitFor(()=>expect(screen.getByText('本地文件发生冲突')).toBeTruthy());
    expect(mocks.editor!.getText()).toContain('我的未保存内容');expect(disk.get('a.xml')!.xml).toBe('<p>并发的磁盘内容</p>');
    edit('继续保留');fireEvent.click(screen.getByRole('button',{name:'b.xml'}));expect(store.open).toHaveBeenCalledTimes(1);
    expect(screen.getByText('保存有冲突')).toBeTruthy();expect(writes).toHaveLength(1);
  });
  it('reauthorizes the same directory without abandoning unsaved typing or picking a different document',async()=>{
    await open();permissionFailure=true;edit('权限恢复后保存');
    fireEvent.click(await screen.findByRole('button',{name:'重新授权并重试'}));
    expect(docs.get('a.xml')!.requestPermission).toHaveBeenCalledOnce();expect(mocks.choose).toHaveBeenCalledTimes(1);
    await waitFor(()=>expect(disk.get('a.xml')!.xml).toContain('权限恢复后保存'));
    expect(screen.getByText('已保存到本地')).toBeTruthy();expect(screen.getByText('资料/a.xml')).toBeTruthy();
  });
  it('keeps the chosen directory accessible when its first XML is invalid',async()=>{
    disk.set('a.xml',snapshot('<p>broken'));render(<BrowserApp/>);fireEvent.click(screen.getByRole('button',{name:'选择本地目录'}));
    await waitFor(()=>expect(screen.getByText(/无法打开 a.xml/)).toBeTruthy());expect(store.dispose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));await waitFor(()=>expect(mocks.editor?.getText()).toContain('另一篇本地文档'));
    expect(disk.get('a.xml')!.xml).toBe('<p>broken');expect(writes).toHaveLength(0);
  });
  it('reads SVG previews through the selected directory capability without an HTTP service',async()=>{
    const document=snapshot('<p>第一篇正文</p><whiteboard token="local-board"/>');
    document.review!.resources={version:1,items:[{tag:'whiteboard',attribute:'token',value:'local-board',path:'resources/board.svg',representation:'preview'}]};disk.set('a.xml',document);
    await open();await waitFor(()=>expect(mocks.editor!.view.dom.querySelector('svg')?.textContent).toContain('本地 SVG'));
    expect(docs.get('a.xml')!.readResource).toHaveBeenCalledWith('resources/board.svg',expect.any(AbortSignal));expect(fetch).not.toHaveBeenCalled();
    expect(disk.get('a.xml')!.xml).toBe(document.xml);expect(writes).toHaveLength(0);
  });
  it('does not rebuild resources while idle and refreshes once when the directory resource signature changes',async()=>{
    await open();const transactions:unknown[]=[];mocks.editor!.on('transaction',({transaction})=>{if(transaction.getMeta(RESOURCE_REFRESH))transactions.push(transaction);});
    for(let i=0;i<3;i++)await act(async()=>{fireEvent(window,new Event('focus'));});
    expect(transactions).toHaveLength(0);
    resourceVersion='resources:1';await act(async()=>{fireEvent(window,new Event('focus'));});expect(transactions).toHaveLength(1);
    await act(async()=>{fireEvent(window,new Event('focus'));});expect(transactions).toHaveLength(1);expect(writes).toHaveLength(0);
  });
  it('keeps the conflict action after permission expires during reload and is restored',async()=>{
    await open();edit('待保留正文');disk.set('a.xml',snapshot('<p>外部正文</p>','r1'));await screen.findByText('本地文件发生冲突');
    permissionFailure=true;vi.spyOn(window,'confirm').mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'重新读取本地文件'}));
    fireEvent.click(await screen.findByRole('button',{name:'重新授权并重试'}));
    await screen.findByText(/文件冲突仍待处理/);expect(mocks.editor!.getText()).toContain('待保留正文');expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'重新读取本地文件'}));await waitFor(()=>expect(mocks.editor!.getText()).toBe('外部正文'));
  });
  it('preserves unapplied formula and whiteboard sources when navigating modes and files',async()=>{
    disk.set('a.xml',snapshot('<p>第一篇正文<latex>x^2</latex></p><whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg></whiteboard>'));
    await open();let formula=0,board=0;
    mocks.editor!.state.doc.descendants((node,position)=>{if(node.type.name==='xmlInlineLatex')formula=position;if(node.attrs.lrTag==='whiteboard')board=position;});
    act(()=>{mocks.editor!.commands.setNodeSelection(formula);});fireEvent.change(screen.getByLabelText('公式表达式'),{target:{value:'x^3'}});
    fireEvent.click(screen.getByRole('button',{name:'b.xml'}));expect(store.open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'只读'}));expect(screen.getByText(/有未应用的公式修改/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));expect((screen.getByLabelText('公式表达式')as HTMLTextAreaElement).value).toBe('x^3');
    fireEvent.click(screen.getByRole('button',{name:'应用公式'}));await waitFor(()=>expect(disk.get('a.xml')!.xml).toContain('x^3'));
    act(()=>{mocks.editor!.commands.setNodeSelection(board);});const source=screen.getByLabelText('SVG 图源')as HTMLTextAreaElement;
    fireEvent.change(source,{target:{value:source.value.replace('red','blue')}});fireEvent.click(screen.getByRole('button',{name:'b.xml'}));fireEvent.click(screen.getByRole('button',{name:'源码'}));
    expect(store.open).toHaveBeenCalledTimes(1);expect(screen.queryByLabelText('文档源码')).toBeNull();expect(source.value).toContain('blue');expect(disk.get('a.xml')!.xml).toContain('red');
    fireEvent.click(screen.getByRole('button',{name:'还原'}));fireEvent.click(screen.getByRole('button',{name:'b.xml'}));await waitFor(()=>expect(mocks.editor!.getText()).toContain('另一篇本地文档'));
  });
});
