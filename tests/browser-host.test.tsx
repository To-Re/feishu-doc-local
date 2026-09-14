// @vitest-environment jsdom
import React from 'react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserApp } from '../src/browser/BrowserApp';
import { createReview, type Review, type Snapshot } from '../src/core/types';
import type { BrowserDocument, BrowserDocumentStore } from '../src/browser/files';
import type { EditorController, EditorHost, EditorRecovery } from '../src/browser/host';

const mocks=vi.hoisted(()=>({editor:null as Editor|null,choose:vi.fn()}));
vi.mock('../src/browser/files',()=>({chooseBrowserDirectory:mocks.choose}));
vi.mock('../src/ui/Reader',async original=>{
  const actual=await original<typeof import('../src/ui/Reader')>();
  return{...actual,Reader:(props:React.ComponentProps<typeof actual.Reader>)=><actual.Reader {...props} onReady={editor=>{mocks.editor=editor;props.onReady(editor);}}/>};
});
const original='<title>文章标题</title><h1>章节一</h1><p>第一段正文</p><h2>章节二</h2><p>第二段正文</p>';
const copy=<T,>(value:T):T=>structuredClone(value);
const geometry=['getClientRects','getBoundingClientRect'].map(name=>({name,descriptor:Object.getOwnPropertyDescriptor(Range.prototype,name)}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
let disk:Snapshot,documentFile:BrowserDocument,store:BrowserDocumentStore,host:EditorHost,controller:EditorController;
let writes:Array<{xml:string;review:Review;revision:string}>,recoveries:Array<EditorRecovery|null>;
let saveOverride:((xml:string,review:Review,revision:string)=>Promise<Snapshot>)|undefined;
function fixture(xml=original,recovery?:EditorRecovery){
  disk={xml,review:createReview('draft.xml',xml),revision:'r0'};writes=[];recoveries=[];
  documentFile={handle:{id:'draft',name:'draft.xml',path:'Articles/draft.xml',reviewPath:'Articles/draft.review.json'},resourceRevision:'resources:0',
    read:vi.fn(async()=>copy(disk)),save:vi.fn(async(xml,review,revision)=>{
      writes.push({xml,review:copy(review),revision});if(saveOverride)return saveOverride(xml,review,revision);
      if(revision!==disk.revision)throw Object.assign(new Error('磁盘版本冲突'),{status:409});
      disk={xml,review:copy(review),revision:revision+'+'};return copy(disk);
    }),requestPermission:vi.fn(async()=>{}),assetURL:()=> 'data:,',readResource:async path=>({path,text:'<svg/>'}),dispose:vi.fn()};
  store={directoryName:'Articles',listDocuments:vi.fn(async()=>['draft.xml']),open:vi.fn(async()=>documentFile),create:vi.fn(async()=>documentFile),dispose:vi.fn()};
  host={label:'Obsidian',initial:{store,document:documentFile,snapshot:copy(disk),recovery},openDocument:vi.fn(),createDocument:vi.fn(),
    onReady:vi.fn(value=>{controller=value;}),persistRecovery:vi.fn(async value=>{recoveries.push(copy(value));})};
  return host;
}
function recovery(xml=original,extras:Partial<EditorRecovery>={}):EditorRecovery{
  return{format:'feishu-editor-draft',version:1,path:'Articles/draft.xml',xml,review:createReview('draft.xml',xml),revision:'r0',dirty:false,
    pending:null,comment:'',replies:{},invalidSource:null,formula:[],whiteboard:[],...extras};
}
async function open(xml=original,recovered?:EditorRecovery){fixture(xml,recovered);const result=render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());return result;}
function edit(text:string){act(()=>{mocks.editor!.commands.setTextSelection(3);mocks.editor!.commands.insertContent(text);});}
function select(){act(()=>mocks.editor!.commands.setTextSelection({from:1,to:4}));}
async function compose(text:string){select();fireEvent.click(await screen.findByRole('button',{name:'评论选中内容'}));fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:text}});}
beforeEach(()=>{
  mocks.editor=null;mocks.choose.mockReset();saveOverride=undefined;
  vi.stubGlobal('showDirectoryPicker',undefined);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Local host must not call HTTP');}));
  if(!Range.prototype.getClientRects)Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
  if(!Range.prototype.getBoundingClientRect)Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();for(const{name,descriptor}of geometry){if(descriptor)Object.defineProperty(Range.prototype,name,descriptor);else Reflect.deleteProperty(Range.prototype,name);}});

describe('Obsidian host shared editor',()=>{
  it('edits the supplied document without duplicating native document navigation',async()=>{
    await open();expect(mocks.editor!.isEditable).toBe(true);expect(screen.getByText('Articles/draft.xml')).toBeTruthy();
    expect(screen.queryByText(/此浏览器不支持/)).toBeNull();expect(screen.queryByRole('button',{name:'选择本地目录'})).toBeNull();
    expect(screen.queryByLabelText('目录文档')).toBeNull();expect(store.listDocuments).not.toHaveBeenCalled();
    for(const name of ['切换文档','新建文档','项目管理','飞书同步'])expect(screen.queryByRole('button',{name})).toBeNull();
    expect(host.openDocument).not.toHaveBeenCalled();expect(host.createDocument).not.toHaveBeenCalled();expect(mocks.choose).not.toHaveBeenCalled();
    edit('本地修订');await act(async()=>expect(await controller.flush()).toBe(true));
    expect(disk.xml).toContain('本地修订');expect(fetch).not.toHaveBeenCalled();
  });
  it('shows the shared outline, updates headings after source edits and keeps its toggle in place',async()=>{
    await open();expect(await screen.findByRole('button',{name:'1 级标题：章节一'})).toBeTruthy();
    const toggle=screen.getByRole('button',{name:'收起文档导航'});fireEvent.click(toggle);
    expect(screen.getByRole('button',{name:'展开文档导航'})).toBe(toggle);fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button',{name:'源码'}));fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:'<title>标题</title><h1>新章节</h1><p>正文</p>'}});
    fireEvent.click(screen.getByRole('button',{name:'编辑'}));expect(await screen.findByRole('button',{name:'1 级标题：新章节'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'1 级标题：章节一'})).toBeNull();
  });
  it('collapses the file tab from the shared header and restores tree state without losing comment drafts',async()=>{
    await open(original+'<source path="@assets/notes.txt"/>');await compose('保留评论草稿');
    const editor=mocks.editor;
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    const tree=screen.getByRole('complementary',{name:'项目资源'});
    const folder=within(tree).getByRole('button',{name:'assets'});fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    const toggle=screen.getByRole('button',{name:'收起文档导航'}),header=toggle.parentElement;
    expect(header?.contains(screen.getByRole('group',{name:'导航内容'}))).toBe(true);
    fireEvent.click(toggle);
    expect(screen.getByRole('button',{name:'展开文档导航'})).toBe(toggle);
    expect(toggle.parentElement).toBe(header);expect(document.activeElement).toBe(toggle);
    expect(screen.queryByRole('complementary',{name:'项目资源'})).toBeNull();
    expect(screen.queryByRole('group',{name:'导航内容'})).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('complementary',{name:'项目资源'})).toBe(tree);
    expect(within(tree).getByRole('button',{name:'assets'}).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button',{name:'文件'}).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'目录'}));fireEvent.click(screen.getByRole('button',{name:'文件'}));
    expect(within(tree).getByRole('button',{name:'assets'}).getAttribute('aria-expanded')).toBe('false');
    expect(mocks.editor).toBe(editor);expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('保留评论草稿');
    expect(screen.queryByRole('button',{name:'收起文档目录'})).toBeNull();expect(writes).toHaveLength(0);
  });
  it('captures and persists unsent selection comments and replies, clearing recovery after they are saved',async()=>{
    await open();await compose('尚未提交的评论');
    await waitFor(()=>expect(recoveries.at(-1)?.comment).toBe('尚未提交的评论'));
    expect(controller.capture()).toMatchObject({pending:{state:'attached'},dirty:false,comment:'尚未提交的评论'});
    fireEvent.click(screen.getByRole('button',{name:'添加评论'}));await act(async()=>expect(await controller.flush()).toBe(true));
    expect(disk.review!.comments[0].body).toBe('尚未提交的评论');await waitFor(()=>expect(recoveries.at(-1)).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'回复'}));
    fireEvent.change(screen.getByLabelText('回复评论：尚未提交的评论'),{target:{value:'回复草稿'}});
    expect(Object.values(controller.capture()!.replies)).toEqual(['回复草稿']);
    await act(async()=>controller.prepareClose());expect(Object.values(recoveries.at(-1)!.replies)).toEqual(['回复草稿']);
  });
  it('flush waits for an ongoing save and writes newer typing against the returned revision',async()=>{
    await open();const first=deferred<Snapshot>();saveOverride=()=>first.promise;
    edit('先输入');await waitFor(()=>expect(writes).toHaveLength(1));edit('后输入');
    let complete=false;let flushing!:Promise<boolean>;act(()=>{flushing=controller.flush().then(value=>{complete=true;return value;});});
    expect(complete).toBe(false);const saved={xml:writes[0].xml,review:writes[0].review,revision:'r1'};disk=copy(saved);saveOverride=undefined;
    await act(async()=>{first.resolve(saved);expect(await flushing).toBe(true);});
    expect(writes).toHaveLength(2);expect(writes[1].revision).toBe('r1');expect(disk.xml).toContain('后输入');expect(controller.capture()).toBeNull();
  });
  it('prepares close by preserving failed saves instead of dropping edits',async()=>{
    await open();saveOverride=async()=>{throw new Error('磁盘暂不可写');};edit('不能丢失的正文');
    await act(async()=>controller.prepareClose());
    expect(disk.xml).toBe(original);expect(recoveries.at(-1)).toMatchObject({dirty:true,xml:expect.stringContaining('不能丢失的正文')});
    expect(mocks.editor!.isEditable).toBe(false);
  });
  it('refuses closure when recovery persistence fails and leaves the editor available',async()=>{
    await open();host.persistRecovery=vi.fn(async()=>{throw new Error('恢复记录无法保存');});edit('保留');
    saveOverride=async()=>{throw new Error('正文无法保存');};
    await act(async()=>expect(controller.prepareClose()).rejects.toThrow('恢复记录无法保存'));
    expect(mocks.editor!.isEditable).toBe(true);expect(controller.capture()!.xml).toContain('保留');
  });
  it('restores invalid source and unsent comments without writing malformed XML',async()=>{
    const draft=recovery(original,{invalidSource:{value:'<p>未闭合',error:'格式不正确'},pending:{from:1,to:4,quote:'文章标',state:'attached'},comment:'恢复的评论'});
    await open(original,draft);
    expect((screen.getByLabelText('文档源码')as HTMLTextAreaElement).value).toBe('<p>未闭合');
    expect((screen.getByLabelText('评论内容')as HTMLTextAreaElement).value).toBe('恢复的评论');
    await act(async()=>controller.prepareClose());expect(writes).toHaveLength(0);expect(recoveries.at(-1)?.invalidSource?.value).toBe('<p>未闭合');
  });
  it('preserves recovered edits and reports a conflict when their baseline differs from disk',async()=>{
    const draft=recovery('<p>恢复的本地草稿</p>',{dirty:true,revision:'older'});
    await open(original,draft);expect(mocks.editor!.getText()).toContain('恢复的本地草稿');
    expect(screen.getByText(/本地文件已发生修改/)).toBeTruthy();
    await act(async()=>expect(await controller.flush()).toBe(false));expect(disk.xml).toBe(original);expect(writes).toHaveLength(0);
    expect(controller.capture()).toMatchObject({revision:'older',dirty:true});
  });
  it('locks source and comments before sync, flushes, then reloads the actual file on release',async()=>{
    await open();edit('发布前修改');let sync!:Awaited<ReturnType<EditorController['acquireSync']>>;
    await act(async()=>{sync=await controller.acquireSync();});expect(disk.xml).toContain('发布前修改');expect(mocks.editor!.isEditable).toBe(false);
    expect((screen.getByRole('button',{name:'源码'})as HTMLButtonElement).disabled).toBe(true);
    await expect(controller.acquireSync()).rejects.toThrow('正在处理');
    disk={xml:'<p>同步回读内容</p>',review:createReview('draft.xml','<p>同步回读内容</p>'),revision:'synced'};
    await act(async()=>sync.release());expect(mocks.editor!.getText()).toBe('同步回读内容');expect(mocks.editor!.isEditable).toBe(true);
    await act(async()=>sync.release());expect(writes).toHaveLength(1);
  });
  it('rejects sync with unsent drafts or a save failure and releases its input lock',async()=>{
    await open();await compose('未提交');await expect(controller.acquireSync()).rejects.toThrow('完成草稿');
    fireEvent.click(screen.getByRole('button',{name:'取消评论'}));edit('待保存');saveOverride=async()=>{throw new Error('保存失败');};
    await act(async()=>expect(controller.acquireSync()).rejects.toThrow('尚未保存'));expect(mocks.editor!.isEditable).toBe(true);expect(disk.xml).toBe(original);
  });
  it('waits for durable recovery cleanup before granting the sync lease',async()=>{
    await open();await waitFor(()=>expect(recoveries.at(-1)).toBeNull());
    const durable=deferred<void>();let clearing=false,granted=false;
    host.persistRecovery=vi.fn(async value=>{if(value===null){clearing=true;await durable.promise;}recoveries.push(copy(value));});
    edit('同步前落盘');let acquiring!:ReturnType<EditorController['acquireSync']>;
    act(()=>{acquiring=controller.acquireSync().then(value=>{granted=true;return value;});});
    await waitFor(()=>expect(clearing).toBe(true));
    expect(disk.xml).toContain('同步前落盘');expect(granted).toBe(false);expect(mocks.editor!.isEditable).toBe(false);
    let lease!:Awaited<typeof acquiring>;
    await act(async()=>{durable.resolve();lease=await acquiring;});
    expect(granted).toBe(true);expect(recoveries.at(-1)).toBeNull();await act(async()=>lease.release());
  });
  it('rejects sync when recovery cleanup fails, then retries without repeating the successful file save',async()=>{
    await open();await waitFor(()=>expect(recoveries.at(-1)).toBeNull());
    host.persistRecovery=vi.fn(async value=>{if(value===null)throw new Error('草稿清理不能落盘');recoveries.push(copy(value));});
    edit('已保存仍需清理');
    await act(async()=>expect(controller.acquireSync()).rejects.toThrow('草稿清理不能落盘'));
    expect(disk.xml).toContain('已保存仍需清理');expect(mocks.editor!.isEditable).toBe(true);expect(writes).toHaveLength(1);
    host.persistRecovery=vi.fn(async value=>{recoveries.push(copy(value));});
    let lease!:Awaited<ReturnType<EditorController['acquireSync']>>;
    await act(async()=>{lease=await controller.acquireSync();});expect(recoveries.at(-1)).toBeNull();expect(writes).toHaveLength(1);
    await act(async()=>lease.release());expect(mocks.editor!.isEditable).toBe(true);
  });
  it('navigates from valid source into the visible heading without changing the document',async()=>{
    await open();fireEvent.click(screen.getByRole('button',{name:'源码'}));
    const xml='<h3>跳级标题</h3><p>正文</p><h9>最深标题</h9>';
    fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:xml}});
    const target=await screen.findByRole('button',{name:'9 级标题：最深标题'});
    let position=0;mocks.editor!.state.doc.descendants((node,pos)=>{if(node.type.name==='heading'&&node.attrs.level===9)position=pos;});
    const element=mocks.editor!.view.nodeDOM(position)as HTMLElement;const scroll=vi.fn();element.scrollIntoView=scroll;
    vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{queueMicrotask(()=>callback(0));return 1;});
    fireEvent.click(target);
    await waitFor(()=>expect(scroll).toHaveBeenCalledOnce());expect(screen.queryByLabelText('文档源码')).toBeNull();
    expect(screen.getByRole('button',{name:'只读'}).getAttribute('aria-pressed')).toBe('true');
    await act(async()=>controller.flush());expect(disk.xml).toBe(xml);expect(writes).toHaveLength(1);
  });
  it('keeps invalid source and pending visual comments intact when outline navigation is requested',async()=>{
    await open();await compose('目录跳转保留评论');const before=copy(controller.capture());
    const selection=mocks.editor!.state.selection.toJSON();fireEvent.click(screen.getByRole('button',{name:'2 级标题：章节二'}));
    expect(controller.capture()).toEqual(before);expect(mocks.editor!.state.selection.toJSON()).toEqual(selection);
    fireEvent.click(screen.getByRole('button',{name:'取消评论'}));fireEvent.click(screen.getByRole('button',{name:'源码'}));
    fireEvent.change(screen.getByLabelText('文档源码'),{target:{value:'<h1>未闭合'}});
    fireEvent.click(screen.getByRole('button',{name:'2 级标题：章节二'}));
    expect(screen.getByText('请先修正或还原无效源码，再定位正文标题。')).toBeTruthy();
    expect((screen.getByLabelText('文档源码')as HTMLTextAreaElement).value).toBe('<h1>未闭合');
    await act(async()=>controller.prepareClose());expect(recoveries.at(-1)?.invalidSource?.value).toBe('<h1>未闭合');expect(writes).toHaveLength(0);
  });
  it('persists unapplied formula and board sources and restores them without a render loop',async()=>{
    const xml='<p>公式<latex>x^2</latex></p><whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"/></svg></whiteboard>';
    const mounted=await open(xml);let formula=0,board=0;
    mocks.editor!.state.doc.descendants((node,position)=>{if(node.type.name==='xmlInlineLatex')formula=position;if(node.attrs.lrTag==='whiteboard')board=position;});
    act(()=>mocks.editor!.commands.setNodeSelection(formula));fireEvent.change(screen.getByLabelText('公式表达式'),{target:{value:'x^3'}});
    act(()=>mocks.editor!.commands.setNodeSelection(board));const boardSource=screen.getByLabelText('SVG 图源')as HTMLTextAreaElement;
    fireEvent.change(boardSource,{target:{value:boardSource.value.replace('red','blue')}});
    const retained=controller.capture()!;expect(retained.formula).toHaveLength(1);expect(retained.whiteboard).toHaveLength(1);
    await act(async()=>controller.prepareClose());expect(disk.xml).toBe(xml);expect(recoveries.at(-1)?.whiteboard).toEqual(retained.whiteboard);
    mounted.unmount();await open(xml,retained);
    expect(controller.capture()?.formula).toEqual(retained.formula);expect(controller.capture()?.whiteboard).toEqual(retained.whiteboard);
    act(()=>mocks.editor!.commands.setNodeSelection(formula));expect((screen.getByLabelText('公式表达式')as HTMLTextAreaElement).value).toBe('x^3');
    expect(recoveries.length).toBeLessThan(10);expect(writes).toHaveLength(0);
  });
  it('offers formatting controls that edit the real XML and are disabled by a sync lease',async()=>{
    await open('<p>需要格式的正文</p>');
    for(const name of ['加粗','斜体','列表','行内代码','引用'])expect(screen.getByRole('button',{name})).toBeTruthy();
    act(()=>mocks.editor!.commands.setTextSelection({from:1,to:5}));
    fireEvent.click(screen.getByRole('button',{name:'加粗'}));
    await act(async()=>controller.flush());expect(disk.xml).toContain('<b>需要格式</b>');
    let lease!:Awaited<ReturnType<EditorController['acquireSync']>>;
    await act(async()=>{lease=await controller.acquireSync();});
    expect((screen.getByRole('button',{name:'斜体'})as HTMLButtonElement).disabled).toBe(true);
    const prior=disk.xml;fireEvent.click(screen.getByRole('button',{name:'斜体'}));expect(disk.xml).toBe(prior);
    await act(async()=>lease.release());
  });
  it('opens current JSON and referenced resources through the host without HTTP or losing editor drafts',async()=>{
    fixture('<p>带附件的正文</p><source path="@notes.txt"/><img path="@image.png"/>');
    documentFile.readResource=vi.fn(async path=>({path,text:'<script>must remain text</script>'}));
    documentFile.assetURL=vi.fn(()=> 'blob:host-image');
    render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());
    await compose('保留未发送意见');const originalEditor=mocks.editor;
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    const tree=screen.getByRole('complementary',{name:'项目资源'});
    fireEvent.click(within(tree).getByRole('button',{name:'draft.review.json评论'}));
    expect(screen.getByRole('region',{name:'资源预览'}).textContent).toContain('lark-review');
    fireEvent.click(within(tree).getByRole('button',{name:'notes.txt'}));
    const preview=screen.getByRole('region',{name:'资源预览'});
    expect(await within(preview).findByText('<script>must remain text</script>')).toBeTruthy();
    expect(preview.querySelector('script')).toBeNull();expect(documentFile.readResource).toHaveBeenCalledWith('notes.txt',expect.any(AbortSignal));
    fireEvent.click(within(tree).getByRole('button',{name:'image.png'}));
    expect(screen.getByRole('img',{name:'image.png'}).getAttribute('src')).toBe('blob:host-image');
    fireEvent.click(screen.getByRole('button',{name:'返回正文'}));
    expect(mocks.editor).toBe(originalEditor);expect((screen.getByLabelText('评论内容')as HTMLTextAreaElement).value).toBe('保留未发送意见');
    expect(fetch).not.toHaveBeenCalled();expect(writes).toHaveLength(0);
  });
  it('collapses replies and resolved comments, retains reply drafts, and displays AI receipts',async()=>{
    fixture();disk.review!.result={author:'Codex',summary:'补充了验收说明',appliedAt:'2026-09-13T00:00:00Z'};host.initial.snapshot=copy(disk);
    render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());
    expect(screen.getByText('补充了验收说明')).toBeTruthy();await compose('请补例子');
    fireEvent.click(screen.getByRole('button',{name:'添加评论'}));await act(async()=>controller.flush());
    expect(screen.queryByLabelText('回复评论：请补例子')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'回复'}));fireEvent.change(screen.getByLabelText('回复评论：请补例子'),{target:{value:'未发送回复'}});
    fireEvent.click(screen.getByRole('button',{name:'收起评论面板'}));expect(screen.queryByRole('complementary',{name:'评论与内容编辑'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'展开评论面板'}));expect((screen.getByLabelText('回复评论：请补例子')as HTMLTextAreaElement).value).toBe('未发送回复');
    fireEvent.click(screen.getByRole('button',{name:'发送回复'}));await act(async()=>controller.flush());expect(disk.review!.comments[0].replies[0].body).toBe('未发送回复');
    fireEvent.click(screen.getByRole('button',{name:'解决'}));await act(async()=>controller.flush());
    expect(screen.queryByText('请补例子')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'查看已解决评论'}));
    fireEvent.click(screen.getByRole('button',{name:'重新打开'}));await act(async()=>controller.flush());expect(disk.review!.comments[0].status).toBe('open');
  });
  it('scrolls the quote from read-only and source modes without changing selection or creating a draft',async()=>{
    await open('<p>文本评论定位</p>');await compose('准确定位');fireEvent.click(screen.getByRole('button',{name:'添加评论'}));await act(async()=>controller.flush());
    act(()=>mocks.editor!.commands.setTextSelection(1));
    const previousSelection=mocks.editor!.state.selection;
    const nativeSelection=document.getSelection()?.toString();
    const ranges:string[]=[];
    vi.spyOn(Range.prototype,'getClientRects').mockImplementation(function(this:Range){ranges.push(this.toString());return [new DOMRect(20,1600,60,20)] as unknown as DOMRectList;});
    fireEvent.click(screen.getByRole('button',{name:'只读'}));fireEvent.click(screen.getByRole('button',{name:'文本评'}));
    expect(ranges).toContain('文本评');expect(mocks.editor!.state.selection).toBe(previousSelection);
    expect(document.getSelection()?.toString()).toBe(nativeSelection);expect(screen.queryByRole('button',{name:'评论选中内容'})).toBeNull();
    ranges.length=0;
    fireEvent.click(screen.getByRole('button',{name:'源码'}));fireEvent.click(screen.getByRole('button',{name:'文本评'}));
    await waitFor(()=>expect(ranges).toContain('文本评'));expect(screen.queryByLabelText('文档源码')).toBeNull();
    expect(mocks.editor!.state.selection).toBe(previousSelection);expect(document.getSelection()?.toString()).toBe(nativeSelection);
    expect(controller.capture()).toBeNull();
    expect(writes).toHaveLength(1);
  });
  it.each(['编辑','只读'])('%s locates full open and resolved quotes in the host scroll pane and toggles their original marks',async mode=>{
    const prefix='前面的长段落。'.repeat(80),quote='完整引用😀é。'.repeat(65),suffix='其余正文';
    fixture('<p>'+prefix+quote+suffix+'</p><source path="@notes.txt"/>');
    const anchor={from:prefix.length+1,to:prefix.length+1+quote.length,quote,state:'attached' as const};
    disk.review!.comments=[{id:'resolved-range',author:'协作者',body:'已处理的长引用',createdAt:'2026-09-14T00:00:00Z',status:'resolved',anchor,replies:[]},
      {id:'open-range',author:'协作者',body:'待处理的引用',createdAt:'2026-09-14T00:00:00Z',status:'open',anchor:{from:1,to:5,quote:prefix.slice(0,4),state:'attached'},replies:[]}];
    host.initial.snapshot=copy(disk);render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:mode}));
    const body=screen.getByLabelText('文章正文'),pane=screen.getByRole('region',{name:'文档编辑区'}),sidebar=screen.getByRole('complementary',{name:'评论与内容编辑'});
    pane.style.overflowY='auto';Object.defineProperties(pane,{clientHeight:{value:500},scrollHeight:{value:4000}});
    vi.spyOn(pane,'getBoundingClientRect').mockReturnValue(new DOMRect(0,100,800,500));
    pane.scrollTop=100;sidebar.scrollTop=75;
    const ranges:string[]=[];
    vi.spyOn(Range.prototype,'getClientRects').mockImplementation(function(this:Range){ranges.push(this.toString());return [new DOMRect(20,2100,100,20)] as unknown as DOMRectList;});
    const beforeSelection=mocks.editor!.state.selection,beforeXML=disk.xml;
    expect(body.querySelector('[data-comment-id="resolved-range"]')).toBeNull();
    expect(body.querySelector('[data-comment-id="open-range"]')?.textContent).toBe(prefix.slice(0,4));
    fireEvent.click(screen.getByRole('button',{name:'查看已解决评论'}));
    expect(body.querySelector('[data-comment-id="resolved-range"]')?.textContent).toBe(quote);
    const button=screen.getByRole('button',{name:quote});expect(button.textContent).toBe(quote);
    fireEvent.click(button);
    expect(ranges).toContain(quote);expect(pane.scrollTop).toBe(1860);expect(sidebar.scrollTop).toBe(75);
    expect(mocks.editor!.state.selection).toBe(beforeSelection);expect(screen.queryByRole('button',{name:'评论选中内容'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'隐藏已解决评论'}));
    expect(body.querySelector('[data-comment-id="resolved-range"]')).toBeNull();expect(body.querySelector('[data-comment-id="open-range"]')).not.toBeNull();
    // Navigating from an explicitly listed resource returns to the same Reader.
    fireEvent.click(screen.getByRole('button',{name:'文件'}));
    fireEvent.click(within(screen.getByRole('complementary',{name:'项目资源'})).getByRole('button',{name:'notes.txt'}));
    expect(body.closest('article')?.hidden).toBe(true);
    ranges.length=0;fireEvent.click(screen.getByRole('button',{name:prefix.slice(0,4)}));
    await waitFor(()=>expect(ranges).toContain(prefix.slice(0,4)));expect(body.closest('article')?.hidden).toBe(false);
    expect(mocks.editor!.state.selection).toBe(beforeSelection);expect(controller.capture()).toBeNull();
    expect(writes).toHaveLength(0);expect(disk.xml).toBe(beforeXML);expect(fetch).not.toHaveBeenCalled();
  });
  it('locates the exact whiteboard component rather than a same-named component on another board',async()=>{
    fixture('<whiteboard token="board-one"/><whiteboard token="board-two"/>');
    disk.review!.resources={version:1,items:[{tag:'whiteboard',attribute:'token',value:'board-one',path:'one.svg',representation:'preview'},{tag:'whiteboard',attribute:'token',value:'board-two',path:'two.svg',representation:'preview'}]};host.initial.snapshot=copy(disk);
    documentFile.readResource=async path=>({path,text:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><g id="t1:2"><g id="o1:1"><rect width="80" height="40"/><text>同名节点</text></g></g></svg>'});
    render(<BrowserApp host={host}/>);
    const components=await screen.findAllByRole('button',{name:'白板组件：同名节点'});expect(components).toHaveLength(2);
    fireEvent.click(components[0]);fireEvent.click(await screen.findByRole('button',{name:'评论选中组件'}));
    fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'只改第一块节点'}});fireEvent.click(screen.getByRole('button',{name:'添加评论'}));await act(async()=>controller.flush());
    fireEvent.click(screen.getByRole('button',{name:'只读'}));fireEvent.click(screen.getByRole('button',{name:'【白板节点：同名节点】'}));
    expect(components[0].classList.contains('lr-whiteboard-component-selected')).toBe(true);expect(components[1].classList.contains('lr-whiteboard-component-selected')).toBe(false);
    expect(disk.review!.comments[0].anchor.target?.board).toBe('token:board-one');expect(fetch).not.toHaveBeenCalled();
  });
  it('locates a resolved formula atom without selecting it or opening its source editor',async()=>{
    fixture('<p>正文</p><latex>x^2</latex>');
    disk.review!.comments=[{id:'formula-comment',author:'协作者',body:'已检查公式',createdAt:'2026-09-14T00:00:00Z',status:'resolved',
      anchor:{from:4,to:5,quote:'公式：x^2',state:'attached'},replies:[]}];
    host.initial.snapshot=copy(disk);render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());
    const before=mocks.editor!.state.selection,atom=document.querySelector('.lr-latex-block')!,scroll=vi.fn();
    Object.defineProperty(atom,'scrollIntoView',{configurable:true,value:scroll});
    expect(atom.classList.contains('comment-highlight')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'查看已解决评论'}));
    expect(atom.classList.contains('comment-highlight')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'公式：x^2'}));
    expect(scroll).toHaveBeenCalledWith({block:'center',inline:'nearest'});expect(mocks.editor!.state.selection).toBe(before);
    expect(screen.queryByLabelText('公式表达式')).toBeNull();expect(screen.queryByRole('button',{name:'评论选中内容'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'隐藏已解决评论'}));expect(atom.classList.contains('comment-highlight')).toBe(false);
    expect(writes).toHaveLength(0);expect(controller.capture()).toBeNull();
  });
  it('mounts optional cloud actions once, disables them during sync and disposes on close',async()=>{
    fixture();const clipboard=vi.fn(async()=>{}),click=vi.fn(),dispose=vi.fn();
    host.mountToolbar=vi.fn(container=>{const button=document.createElement('button');button.textContent='从飞书导入';button.onclick=click;container.append(button);return dispose;});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:clipboard}});
    const view=render(<BrowserApp host={host}/>);await waitFor(()=>expect(mocks.editor).not.toBeNull());
    fireEvent.click(screen.getByRole('button',{name:'复制文件路径'}));await waitFor(()=>expect(clipboard).toHaveBeenCalledWith('Articles/draft.xml'));
    const button=screen.getByRole('button',{name:'从飞书导入'});fireEvent.click(button);expect(click).toHaveBeenCalledOnce();
    edit('编辑仍然保留');let lease!:Awaited<ReturnType<EditorController['acquireSync']>>;
    await act(async()=>{lease=await controller.acquireSync();});expect(button.matches(':disabled')).toBe(true);
    await act(async()=>lease.release());expect(button.matches(':disabled')).toBe(false);
    expect(host.mountToolbar).toHaveBeenCalledOnce();expect(dispose).not.toHaveBeenCalled();
    view.unmount();expect(dispose).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
  });

});
