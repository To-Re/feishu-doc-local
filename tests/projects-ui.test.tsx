// @vitest-environment jsdom
import React from 'react';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createReview, type DocumentHandle, type Session, type Snapshot } from '../src/core/types';
import type { ContentPreview, CreateProjectInput, ProjectList, ProjectOpenResult, ReviewProject } from '../src/core/projects';
import { App } from '../src/ui/App';

// Real Reader and editors; only the HTTP boundary is replaced. Capture permits
// a late extension transaction even when the browser's contenteditable is locked.
const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('../src/ui/Reader', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/Reader')>();
  return { ...actual, Reader: (props: React.ComponentProps<typeof actual.Reader>) =>
    <actual.Reader {...props} onReady={editor => { captured.editor = editor; props.onReady(editor); }}/> };
});
const a: ReviewProject = { id: 'project-a', name: '已有飞书项目', localPath: '/project/a.xml', defaultDirection: 'pull', createdAt: '2026-09-12T00:00:00Z',
  cloud: { documentId: 'cloud-a', url: 'https://example.feishu.cn/docx/cloud-a' } };
const b: ReviewProject = { id: 'project-b', name: '本地资料', localPath: '/project/b.xml', defaultDirection: 'push', createdAt: a.createdAt };
const ha: DocumentHandle = { id: 'a', name: 'a.xml', path: a.localPath, reviewPath: '/project/a.review.json' };
const hb: DocumentHandle = { id: 'b', name: 'b.xml', path: b.localPath, reviewPath: '/project/b.review.json' };
const original = '<p>第一篇正文</p>';
const remote = '<p>飞书中的修订</p>';
const rangeGeometry = ['getClientRects', 'getBoundingClientRect'].map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name) }));
const response = (value: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) } as Response);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let currentSession: Session;
let list: ProjectList;
let files: Map<string, Snapshot>;
let handles: Map<string, DocumentHandle>;
let requests: Array<{ url: string; method: string; value?: any; headers?: HeadersInit }>;
let route: (url: string, options: RequestInit) => Promise<Response> | undefined;
let previewStatus: ContentPreview['status'];
let previewWarnings: string[];
let creationWarning: string | undefined;
let projectSettingsState: {shared:boolean;path:string;sharedPath?:string;hasSharedPath?:boolean;defaultSharedPath?:string};
const requestsTo = (path: string) => requests.filter(request => request.url === path);
const snapshot = (xml: string, revision = 'r0') => ({ xml, revision, review: createReview('article.xml', xml) });
function sessionFor(project: ReviewProject, handle: DocumentHandle): Session {
  return { csrf: 'project-csrf', nativePicker: true, homeDirectory:'/Users/test', document: handle, project,
    ...(project.cloud ? { cloud: { ...project.cloud, localPath: project.localPath } } : {}) };
}
function result(project: ReviewProject, handle: DocumentHandle): ProjectOpenResult {
  return { session: sessionFor(project, handle), snapshot: files.get(handle.id)!, projects: list.projects };
}
beforeEach(() => {
  localStorage.clear();
  // jsdom has no native details content slot; restore its closed visibility rule
  // so keyboard tests traverse the same controls as a browser.
  const detailsStyle = document.createElement('style');
  detailsStyle.dataset.testDetails = 'true';
  detailsStyle.textContent = 'details:not([open]) > :not(summary) { display: none; }';
  document.head.append(detailsStyle);
  // jsdom has no Range layout. Focus can ask ProseMirror to scroll the native
  // selection; provide geometry without mocking the editor or swallowing errors.
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); captured.editor = null;
  files = new Map([['a', snapshot(original)], ['b', snapshot('<p>第二篇本地资料</p>')]]);
  handles = new Map([[a.id, ha], [b.id, hb]]);
  currentSession = sessionFor(a, ha); list = { projects: [a, b], activeProjectId: a.id, cloudAvailable: true };
  route = () => undefined; requests = []; previewStatus = 'ready'; previewWarnings = []; creationWarning = undefined;
  projectSettingsState={shared:true,path:'/Users/test/.lark-review/projects.json',sharedPath:'/Users/test/.lark-review/projects.json',hasSharedPath:false,defaultSharedPath:'/Users/test/.lark-review/projects.json'};
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit = {}) => {
    const value = options.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url, method: options.method || 'GET', value, headers: options.headers });
    const routed = route(url, options); if (routed) return routed;
    if (url === '/api/session') return response(currentSession);
    if (url === '/api/project-settings') {
      if(options.method==='POST') {
        projectSettingsState={...projectSettingsState,shared:value.shared,path:value.path,sharedPath:value.path,hasSharedPath:true};
        return response({...result(currentSession.project!,currentSession.document),settings:projectSettingsState});
      }
      return response(projectSettingsState);
    }
    if (url === '/api/projects' && options.method === 'GET') return response(list);
    if (url.startsWith('/api/document')) {
      const id = new URL(url, 'http://localhost').searchParams.get('id')!;
      if (options.method === 'PUT') files.set(id, { xml: value.xml, review: value.review, revision: files.get(id)!.revision + '+' });
      return response(files.get(id));
    }
    if (url.endsWith('/open')) {
      const project = list.projects.find(project => url === '/api/projects/' + project.id + '/open')!, handle = handles.get(project.id)!;
      currentSession = sessionFor(project, handle); return response(result(project, handle));
    }
    if (url.endsWith('/bind')) {
      const project=list.projects.find(project=>url==='/api/projects/'+project.id+'/bind')!;
      const linked={...project,defaultDirection:value.defaultDirection,cloud:{documentId:'late-cloud',url:value.cloud.kind==='existing'?value.cloud.url:'https://example.feishu.cn/docx/late-cloud'}};
      list.projects=list.projects.map(item=>item.id===project.id?linked:item);
      const handle=handles.get(project.id)!;currentSession=sessionFor(linked,handle);
      return response(result(linked,handle));
    }
    if (url.endsWith('/preview')) return response({ id: 'preview-one', projectId: a.id, direction: value.direction, status: previewStatus,
      localXML: files.get('a')!.xml, cloudXML: previewStatus === 'equal' ? files.get('a')!.xml : remote,
      warnings: previewWarnings, summary: previewStatus === 'equal' ? '两端正文一致' : '正文有一处修改', expiresAt: new Date(Date.now() + 300_000).toISOString() } satisfies ContentPreview);
    if (url.endsWith('/sync')) {
      files.set('a', snapshot(remote, 'synced'));
      return response({ snapshot: files.get('a'), project: a, summary: '已从飞书同步正文到本地', warnings: [] });
    }
    if (url === '/api/projects' && options.method === 'POST') {
      const input = value as CreateProjectInput;
      const count = requestsTo('/api/projects').filter(request => request.method === 'POST').length;
      const suffix = count === 1 ? '' : '-' + count;
      const handle = { id: 'created' + suffix, name: input.local.path.split('/').at(-1)!, path: input.local.path, reviewPath: input.local.path.replace(/\.xml$/, '.review.json') };
      const project: ReviewProject = { id: 'created-project' + suffix, name: input.name, localPath: input.local.path, defaultDirection: input.defaultDirection, createdAt: a.createdAt,
        ...(input.cloud.kind === 'none' ? {} : { cloud: { documentId: 'created-cloud', url: input.cloud.kind === 'existing' ? input.cloud.url : 'https://example.feishu.cn/docx/created-cloud' } }) };
      files.set(handle.id, snapshot('<p>创建后的正文</p>')); handles.set(project.id, handle); list.projects.push(project); currentSession = sessionFor(project, handle);
      return response({ ...result(project, handle), warning: creationWarning });
    }
    throw new Error('unexpected fetch ' + url);
  }));
});
afterEach(() => {
  cleanup(); document.querySelectorAll('style[data-test-details]').forEach(style=>style.remove());
  for (const { name, descriptor } of rangeGeometry) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function open() {
  const mounted = render(<App/>);
  await waitFor(() => expect(captured.editor).not.toBeNull());
  if (currentSession.project) await waitFor(() => expect(screen.getByRole('combobox', { name: '当前项目' })).toBeDefined());
  return { mounted, editor: captured.editor! };
}
const projectName = (id: string) => list.projects.find(project => project.id === id)?.name || '选择项目';
const currentProjectName = () => document.getElementById(screen.getByRole('combobox', { name: '当前项目' }).getAttribute('aria-describedby')!)?.textContent;
async function openProjectPicker() {
  const trigger = screen.getByRole('combobox', { name: '当前项目' });
  if (trigger.getAttribute('aria-expanded') !== 'true') await userEvent.click(trigger);
}
async function chooseProject(id: string) {
  await openProjectPicker();
  await userEvent.click(await screen.findByRole('option', { name: projectName(id) }));
}
function openManagement() {
  const summary = screen.getByText('项目管理', { selector: 'summary' });
  if (!(summary.parentElement as HTMLDetailsElement).open) fireEvent.click(summary);
}
function createForm() {
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  return within(screen.getByRole('dialog', { name: '新建项目' }));
}
function fillLocal(form: ReturnType<typeof within>, name = '测试项目', path = '/project/new.xml') {
  fireEvent.change(form.getByLabelText('项目名称'), { target: { value: name } });
  fireEvent.change(form.getByLabelText('项目文件路径'), { target: { value: path } });
}

describe('projects and explicit content synchronization with the real App/Reader', () => {
  it('does not request project endpoints for legacy sessions', async () => {
    delete currentSession.project; await open();
    expect(requestsTo('/api/projects')).toHaveLength(0);
    expect(requestsTo('/api/project-settings')).toHaveLength(0);
    expect(screen.queryByLabelText('当前项目')).toBeNull();
    expect(screen.getByRole('button', { name: '同步飞书评论' })).toBeDefined();
  });

  it('saves before switching, locks the editor, and updates paths and cloud binding to the selected project', async () => {
    const gate = deferred<Response>(); route = url => url === '/api/projects/project-b/open' ? gate.promise : undefined;
    const { editor } = await open();
    act(() => { editor.view.dispatch(editor.state.tr.insertText('已改', 1)); });
    await chooseProject(b.id);
    await waitFor(() => expect(requestsTo('/api/projects/project-b/open')).toHaveLength(1));
    expect(files.get('a')!.xml).toBe('<p>已改第一篇正文</p>');
    expect(editor.isEditable).toBe(false);
    expect((screen.getByRole('combobox', { name: '当前项目' }) as HTMLButtonElement).disabled).toBe(true);
    expect(currentProjectName()).toBe(projectName(a.id));
    await userEvent.click(screen.getByRole('combobox', { name: '当前项目' }));
    expect(screen.queryByRole('listbox', { name: '项目列表' })).toBeNull();
    expect(requestsTo('/api/projects/project-b/open')).toHaveLength(1);
    expect(screen.getByText('项目管理', { selector: 'summary' }).getAttribute('aria-disabled')).toBe('true');
    const put = requests.findIndex(request => request.method === 'PUT'), switched = requests.findIndex(request => request.url.endsWith('project-b/open'));
    expect(put).toBeLessThan(switched);
    await act(async () => { gate.resolve(await response(result(b, hb))); });
    await screen.findByText('第二篇本地资料');
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(b.localPath);
    expect(currentProjectName()).toBe(projectName(b.id));
    expect(screen.queryByRole('button', { name: '同步飞书评论' })).toBeNull();
    expect(screen.queryByLabelText('正文同步方向')).toBeNull();
  });

  it('protects a comment draft before switching or creating projects', async () => {
    const { editor } = await open();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 3 }); });
    fireEvent.click(screen.getByRole('button', { name: '评论选中内容' }));
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '未发送的意见不能丢' } });
    await chooseProject(b.id);
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull();
    expect((screen.getByLabelText('评论内容') as HTMLTextAreaElement).value).toBe('未发送的意见不能丢');
    expect(requestsTo('/api/projects/project-b/open')).toHaveLength(0);
    expect(currentProjectName()).toBe(projectName(a.id));
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(a.localPath);
    expect(screen.getByRole('link', { name: '打开飞书文档' }).getAttribute('href')).toBe(a.cloud!.url);
    expect(screen.getByRole('alert').textContent).toContain('先发送或取消');
  });

  it('offers purely local creation when cloud is unavailable and validates the full XML path', async () => {
    list.cloudAvailable = false; await open(); const form = createForm();
    expect((form.getByRole('button', { name: '关联已有文档' }) as HTMLButtonElement).disabled).toBe(true);
    expect((form.getByRole('button', { name: '新建飞书文档' }) as HTMLButtonElement).disabled).toBe(true);
    fillLocal(form, '本地新项目', 'relative.xml');
    expect((form.getByRole('button', { name: '创建项目' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(form.getByLabelText('项目文件路径'), { target: { value: '/project/local-new.xml' } });
    fireEvent.click(form.getByRole('button', { name: '创建新的 XML' }));
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await screen.findByText('创建后的正文');
    expect(requestsTo('/api/projects').find(request => request.method === 'POST')!.value).toEqual({ name: '本地新项目', local: { kind: 'new', path: '/project/local-new.xml' }, cloud: { kind: 'none' }, defaultDirection: 'pull' });
    expect(requests.some(request => request.url.endsWith('/sync'))).toBe(false);
  });

  it('enables the reported ~/ new-project flow and shows the actual XML destination', async () => {
    await open();const form=createForm();
    fireEvent.change(form.getByLabelText('项目名称'),{target:{value:'测试'}});
    fireEvent.click(form.getByRole('button', { name: '创建新的 XML' }));
    fireEvent.change(form.getByLabelText('项目文件路径'),{target:{value:'~/'}});
    expect(form.getByText('/Users/test/测试.xml').textContent).toBe('/Users/test/测试.xml');
    expect((form.getByRole('button',{name:'创建项目'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(form.getByRole('button',{name:'创建项目'}));
    await screen.findByText('创建后的正文');
    expect(requestsTo('/api/projects').find(request=>request.method==='POST')!.value).toMatchObject({local:{kind:'new',path:'/Users/test/测试.xml'},cloud:{kind:'none'}});
    expect(requests.some(request=>request.url.endsWith('/sync')||request.url.endsWith('/bind'))).toBe(false);
  });

  it('shows why an incomplete path cannot be submitted', async () => {
    await open();const form=createForm();
    fireEvent.change(form.getByLabelText('项目名称'),{target:{value:'测试'}});
    fireEvent.click(form.getByRole('button', { name: '创建新的 XML' }));
    fireEvent.change(form.getByLabelText('项目文件路径'),{target:{value:'~/articles'}});
    expect(form.getByText('请输入 .xml 文件路径；如果填目录，请以 / 结尾。')).toBeDefined();
    expect((form.getByRole('button',{name:'创建项目'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('associates an existing local project in place without creating a project or synchronizing its body', async () => {
    await open();await chooseProject(b.id);
    await screen.findByRole('button',{name:'关联飞书'});
    const originalXML=files.get('b')!.xml;
    fireEvent.click(screen.getByRole('button',{name:'关联飞书'}));
    const form=within(screen.getByRole('dialog',{name:'关联飞书'}));
    expect((form.getByLabelText('关联项目本地文件') as HTMLInputElement).value).toBe(b.localPath);
    fireEvent.change(form.getByLabelText('飞书文档链接'),{target:{value:'https://example.feishu.cn/docx/late-cloud'}});
    fireEvent.click(form.getByRole('button',{name:'关联文档'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'关联飞书'})).toBeNull());
    expect(currentSession.project!.id).toBe(b.id);
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(b.localPath);
    expect(files.get('b')!.xml).toBe(originalXML);
    expect(requestsTo('/api/projects/project-b/bind')[0].value).toEqual({revision:'r0',cloud:{kind:'existing',url:'https://example.feishu.cn/docx/late-cloud'},defaultDirection:'push'});
    expect(requestsTo('/api/projects').filter(request=>request.method==='POST')).toHaveLength(0);
    expect(requests.some(request=>request.url.endsWith('/sync'))).toBe(false);
    expect(screen.getByRole('link',{name:'打开飞书文档'}).getAttribute('href')).toBe('https://example.feishu.cn/docx/late-cloud');
  });

  it('keeps the binding form and local draft after an error without automatically retrying', async () => {
    await open();await chooseProject(b.id);
    route=(url)=>url.endsWith('/bind')?response({error:'同一文档已关联其他项目'},409):undefined;
    fireEvent.click(screen.getByRole('button',{name:'关联飞书'}));
    const form=within(screen.getByRole('dialog',{name:'关联飞书'}));
    fireEvent.change(form.getByLabelText('飞书文档链接'),{target:{value:'https://example.feishu.cn/docx/late-cloud'}});
    fireEvent.click(form.getByRole('button',{name:'关联文档'}));
    await form.findByRole('alert');
    expect((form.getByLabelText('飞书文档链接') as HTMLInputElement).value).toBe('https://example.feishu.cn/docx/late-cloud');
    expect(requestsTo('/api/projects/project-b/bind')).toHaveLength(1);
    expect(currentSession.project!.cloud).toBeUndefined();
    expect(files.get('b')!.xml).toBe('<p>第二篇本地资料</p>');
  });

  it('does not let a late initial project list remove a newly created project or its cloud capability', async () => {
    const oldList = deferred<Response>(); let reads = 0;
    route = (url, options) => url === '/api/projects' && options.method === 'GET' && ++reads === 1 ? oldList.promise : undefined;
    render(<App/>); await waitFor(() => expect(captured.editor).not.toBeNull());
    const form = createForm(); fillLocal(form, '刚创建的项目');
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await screen.findByText('创建后的正文');
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => { oldList.resolve(await response({ projects: [a], activeProjectId: a.id, cloudAvailable: false })); });
    expect(currentProjectName()).toBe(projectName('created-project'));
    await openProjectPicker();
    expect(screen.getByRole('option', { name: '刚创建的项目' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    const nextForm = createForm();
    expect((nextForm.getByRole('button', { name: '关联已有文档' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('locks creation inputs during the request and preserves the full form after a failed response without retrying', async () => {
    const gate = deferred<Response>();
    route = (url, options) => url === '/api/projects' && options.method === 'POST' ? gate.promise : undefined;
    const { editor } = await open(); const form = createForm(); fillLocal(form, '保留新建输入', '/project/keep-form.xml');
    fireEvent.click(form.getByRole('button', { name: '新建飞书文档' }));
    fireEvent.change(form.getByLabelText('飞书文档标题'), { target: { value: '保留标题' } });
    fireEvent.click(form.getByRole('button', { name: '创建项目并发布到飞书' }));
    await waitFor(() => expect(requestsTo('/api/projects').filter(request => request.method === 'POST')).toHaveLength(1));
    const dialog = screen.getByRole('dialog', { name: '新建项目' });
    for (const input of dialog.querySelectorAll('input,select,button')) expect(input.matches(':disabled')).toBe(true);
    expect(editor.isEditable).toBe(false);
    fireEvent.keyDown(dialog, { key: 'Escape' }); fireEvent.submit(dialog);
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBe(dialog);
    expect(requestsTo('/api/projects').filter(request => request.method === 'POST')).toHaveLength(1);
    await act(async () => { gate.resolve(await response({ error: '创建结果尚未确认，请检查记录' }, 503)); });
    await screen.findByText('创建结果尚未确认，请检查记录');
    expect((form.getByLabelText('项目名称') as HTMLInputElement).value).toBe('保留新建输入');
    expect((form.getByLabelText('项目文件路径') as HTMLInputElement).value).toBe('/project/keep-form.xml');
    expect((form.getByLabelText('飞书文档标题') as HTMLInputElement).value).toBe('保留标题');
    expect(editor.isEditable).toBe(true);
    expect(editor.getText()).toContain('第一篇正文');
    expect(requestsTo('/api/projects').filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('retains unexpected late article input when project creation returns and leaves the creation form available', async () => {
    const gate = deferred<Response>();
    route = (url, options) => url === '/api/projects' && options.method === 'POST' ? gate.promise : undefined;
    const { editor } = await open(); const form = createForm(); fillLocal(form);
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(requestsTo('/api/projects').filter(request => request.method === 'POST')).toHaveLength(1));
    act(() => { editor.view.dispatch(editor.state.tr.insertText('创建期间的新输入', 1)); });
    await act(async () => { gate.resolve(await response(result(b, hb))); });
    expect(editor.getText()).toContain('创建期间的新输入第一篇正文');
    expect(currentProjectName()).toBe(projectName(a.id));
    expect((form.getByLabelText('项目名称') as HTMLInputElement).value).toBe('测试项目');
    expect(screen.getByRole('alert').textContent).toContain('已保留当前稿件');
    expect(requestsTo('/api/projects').filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it.each(['existing', 'new'] as const)('creates an explicit %s cloud project without issuing a separate content sync', async kind => {
    await open(); const form = createForm(); fillLocal(form);
    fireEvent.click(form.getByRole('button', { name: kind === 'new' ? '新建飞书文档' : '关联已有文档' }));
    if (kind === 'existing') fireEvent.change(form.getByLabelText('飞书文档链接'), { target: { value: 'https://example.feishu.cn/docx/existing' } });
    else {
      fireEvent.change(form.getByLabelText('飞书文档标题'), { target: { value: '新飞书文档' } });
      fireEvent.click(form.getByText('指定飞书文件夹（可选）'));
      fireEvent.change(form.getByLabelText('飞书文件夹 Token'), { target: { value: 'folder-token' } });
    }
    fireEvent.click(form.getByRole('button', { name: '本地 → 飞书' }));
    fireEvent.click(form.getByRole('button', { name: kind === 'new' ? '创建项目并发布到飞书' : '创建项目' }));
    await screen.findByText('创建后的正文');
    expect(requestsTo('/api/projects').find(request => request.method === 'POST')!.value).toMatchObject({ name: '测试项目', local: { kind: 'existing', path: '/project/new.xml' }, defaultDirection: 'push',
      cloud: kind === 'new' ? { kind: 'new', title: '新飞书文档', parentToken: 'folder-token' } : { kind: 'existing', url: 'https://example.feishu.cn/docx/existing' } });
    expect(screen.getByRole('button', { name: '预览差异' })).toBeDefined();
    expect(screen.getByRole('link', { name: '打开飞书文档' }).getAttribute('href')).toContain(kind === 'new' ? 'created-cloud' : 'existing');
    expect(requests.some(request => request.url.endsWith('/sync'))).toBe(false);
  });

  it('keeps the creation warning visible after comment input and automatic saving', async () => {
    creationWarning = '文档已创建，但指定管理员权限尚未确认；请在飞书检查权限。';
    await open(); const form = createForm(); fillLocal(form);
    fireEvent.click(form.getByRole('button', { name: '新建飞书文档' }));
    fireEvent.change(form.getByLabelText('飞书文档标题'), { target: { value: '新飞书文档' } });
    fireEvent.click(form.getByRole('button', { name: '创建项目并发布到飞书' }));
    const card = await screen.findByRole('complementary', { name: '创建时提示' });
    expect(within(card).getByText(creationWarning)).toBeDefined();
    expect(within(card).getByText('这是创建时的记录；如果已在飞书处理，可关闭。')).toBeDefined();
    expect(screen.getAllByText(creationWarning)).toHaveLength(1);
    act(() => { captured.editor!.commands.setTextSelection({ from: 1, to: 3 }); });
    fireEvent.click(screen.getByRole('button', { name: '评论选中内容' }));
    fireEvent.input(screen.getByLabelText('评论内容'), { target: { value: '输入后仍可核对创建记录' } });
    expect(screen.getByRole('complementary', { name: '创建时提示' })).toBe(card);
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
    await waitFor(() => expect(files.get('created')!.review?.comments[0]?.body).toBe('输入后仍可核对创建记录'));
    expect(requests.some(request => request.method === 'PUT')).toBe(true);
    expect(screen.getByRole('complementary', { name: '创建时提示' }).textContent).toContain(creationWarning);
  });

  it('shows only the selected project creation warning and restores it when switching back', async () => {
    creationWarning = '第一篇创建时的格式需要核对。';
    await open(); let form = createForm(); fillLocal(form, '第一篇', '/project/first.xml');
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await screen.findByRole('complementary', { name: '创建时提示' });
    await chooseProject(b.id);
    await screen.findByText('第二篇本地资料');
    expect(screen.queryByRole('complementary', { name: '创建时提示' })).toBeNull();

    creationWarning = '第二篇创建时的资源需要核对。';
    form = createForm(); fillLocal(form, '第二篇', '/project/second.xml');
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(screen.getByRole('complementary', { name: '创建时提示' }).textContent).toContain(creationWarning));
    expect(screen.queryByText('第一篇创建时的格式需要核对。')).toBeNull();
    await chooseProject('created-project');
    await waitFor(() => expect(screen.getByRole('complementary', { name: '创建时提示' }).textContent).toContain('第一篇创建时的格式需要核对。'));
    expect(screen.queryByText('第二篇创建时的资源需要核对。')).toBeNull();
    expect(requests.some(request => request.url.endsWith('/sync'))).toBe(false);
  });

  it('dismisses only the selected creation warning and keeps it dismissed when reopening that project', async () => {
    creationWarning = '第一篇创建时的格式需要核对。';
    await open(); let form = createForm(); fillLocal(form, '第一篇', '/project/first.xml');
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await screen.findByRole('complementary', { name: '创建时提示' });
    creationWarning = '第二篇创建时的资源需要核对。';
    form = createForm(); fillLocal(form, '第二篇', '/project/second.xml');
    fireEvent.click(form.getByRole('button', { name: '创建项目' }));
    await waitFor(() => expect(screen.getByRole('complementary', { name: '创建时提示' }).textContent).toContain(creationWarning));
    fireEvent.click(screen.getByRole('button', { name: '关闭创建时提示' }));
    expect(screen.queryByRole('complementary', { name: '创建时提示' })).toBeNull();
    await chooseProject('created-project');
    await screen.findByText('第一篇创建时的格式需要核对。');
    await chooseProject('created-project-2');
    await waitFor(() => expect(currentProjectName()).toBe(projectName('created-project-2')));
    expect(screen.queryByRole('complementary', { name: '创建时提示' })).toBeNull();
  });

  it('uses the file picker only for a path and restores the active server project without replacing the editor', async () => {
    const picked: DocumentHandle = { id: 'picked', name: 'selected.xml', path: '/another/selected.xml', reviewPath: '/another/selected.review.json' };
    route = url => { if (url === '/api/pick') { currentSession = { csrf: 'project-csrf', nativePicker: true, document: picked }; return response(picked); } };
    const { editor } = await open(); const form = createForm();
    fireEvent.click(form.getByRole('button', { name: '浏览' }));
    await waitFor(() => expect((form.getByLabelText('项目文件路径') as HTMLInputElement).value).toBe(picked.path));
    expect(requestsTo('/api/projects/project-a/open')).toHaveLength(1);
    expect(currentSession.project?.id).toBe(a.id); expect(captured.editor).toBe(editor);
    expect(editor.getText()).toContain('第一篇正文');
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(ha.path);
  });

  it('requires restoring project selection after a failed picker restore and retains the original article', async () => {
    let restoreFails = true;
    route = url => url === '/api/pick' ? response(hb) : url.endsWith('project-a/open') && restoreFails ? response({ error: '恢复失败' }, 500) : undefined;
    const { editor } = await open(); const form = createForm(); fillLocal(form);
    fireEvent.click(form.getByRole('button', { name: '浏览' }));
    await screen.findByText('文件选择后未能恢复当前项目，请关闭此窗口并重新选择项目后再创建。');
    expect((form.getByRole('button', { name: '创建项目' }) as HTMLButtonElement).disabled).toBe(true);
    expect(editor.getText()).toContain('第一篇正文');
    fireEvent.click(form.getByRole('button', { name: '取消' }));
    expect(currentProjectName()).toBe(projectName(''));
    restoreFails = false;
    await chooseProject(a.id);
    await waitFor(() => expect(currentProjectName()).toBe(projectName(a.id)));
    expect(screen.getByRole('button', { name: '预览差异' })).toBeDefined();
  });

  it('previews the default direction and two sources, then syncs only after a concrete direction confirmation', async () => {
    const { editor } = await open();
    fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    await screen.findByRole('dialog', { name: '正文同步预览' });
    const dialog = screen.getByRole('dialog', { name: '正文同步预览' });
    await waitFor(() => expect(screen.getByRole('button', { name: '确认拉取' }).matches(':disabled')).toBe(false));
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('查看完整原文', { selector: 'summary' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭正文同步预览' }));
    expect(requestsTo('/api/projects/project-a/preview')[0].value).toEqual({ revision: 'r0', direction: 'pull' });
    expect(screen.getByText('同步前 · 本地正文')).toBeDefined();
    expect(screen.getByText('同步后 · 来自飞书')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '合并' }));
    fireEvent.click(screen.getByText('查看完整原文', { selector: 'summary' }));
    expect(screen.getByLabelText('本地正文源码').textContent).toBe(original);
    expect(screen.getByLabelText('飞书正文源码').textContent).toBe(remote);
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认拉取' }));
    await screen.findByText('已从飞书同步正文到本地');
    expect(editor.getText()).toContain('飞书中的修订');
    expect(requestsTo('/api/projects/project-a/sync')[0].value).toEqual({ previewId: 'preview-one', adoptPublished: true });
    expect(requestsTo('/api/projects/project-a/sync')[0].headers).toMatchObject({ 'X-CSRF-Token': 'project-csrf' });
    expect(screen.queryByRole('dialog', { name: '正文同步预览' })).toBeNull();
  });

  it.each(['拉取', '推送'] as const)('executes %s directly with automatic local adoption and no mandatory preview', async label => {
    const { editor } = await open();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(1));
    expect(requestsTo('/api/projects/project-a/preview')[0].value.direction).toBe(label === '拉取' ? 'pull' : 'push');
    expect(requestsTo('/api/projects/project-a/sync')[0].value).toEqual({ previewId: 'preview-one', adoptPublished: true });
    await waitFor(() => expect(editor.getText()).toContain('飞书中的修订'));
    expect(screen.queryByRole('dialog', { name: '正文同步预览' })).toBeNull();
  });

  it('does not write when a direct sync finds both ends unchanged', async () => {
    previewStatus = 'equal'; await open();
    fireEvent.click(screen.getByRole('button', { name: '推送' }));
    await screen.findByText('两端没有待同步的内容。');
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
  });

  it('blocks duplicate direct pushes while preparing and stops after late input', async () => {
    const gate = deferred<Response>(); route = url => url.endsWith('/preview') ? gate.promise : undefined;
    const { editor } = await open();
    fireEvent.click(screen.getByRole('button', { name: '推送' }));
    await waitFor(() => expect(requestsTo('/api/projects/project-a/preview')).toHaveLength(1));
    expect(screen.getByRole('button', { name: '推送' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '推送' }));
    act(() => { editor.view.dispatch(editor.state.tr.insertText('保留后输入', 1)); });
    await act(async () => { gate.resolve(await response({ id: 'late', projectId: a.id, direction: 'push', status: 'ready', localXML: original, cloudXML: remote, warnings: [], summary: '就绪', expiresAt: '2099-01-01T00:00:00Z' })); });
    await screen.findByText(/同步准备期间又有新输入/);
    expect(requestsTo('/api/projects/project-a/preview')).toHaveLength(1);
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
    expect(editor.getText()).toContain('保留后输入');
  });

  it('shows conflict warnings before a push, while an equal preview has no execution action', async () => {
    previewStatus = 'conflict'; previewWarnings = ['本地与飞书都有独立改动']; await open();
    fireEvent.click(screen.getByRole('button', { name: '推送' }));
    await screen.findByText('本地与飞书都有独立改动');
    expect(requestsTo('/api/projects/project-a/preview')[0].value.direction).toBe('push');
    expect(screen.getByText('同步前 · 飞书正文')).toBeDefined();
    expect(screen.getByText('同步后 · 来自本地')).toBeDefined();
    expect(screen.getByRole('button', { name: '确认推送' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    previewStatus = 'equal'; previewWarnings = [];
    fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    await screen.findByText('两端正文一致');
    expect(screen.queryByRole('button', { name: '确认推送' })).toBeNull();
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
  });

  it('invalidates a preview after a new document edit rather than executing an outdated comparison', async () => {
    const { editor } = await open(); fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    await screen.findByRole('dialog', { name: '正文同步预览' });
    act(() => { editor.view.dispatch(editor.state.tr.insertText('新输入', 1)); });
    expect(screen.queryByRole('button', { name: '确认拉取' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新预览' })).toBeDefined();
    expect(editor.getText()).toContain('新输入第一篇正文');
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
  });

  it('retains late input during a content sync receipt and blocks overwriting the changed page', async () => {
    const gate = deferred<Response>(); route = url => url.endsWith('/sync') ? gate.promise : undefined;
    const { editor } = await open(); fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    await screen.findByRole('dialog', { name: '正文同步预览' });
    fireEvent.click(screen.getByRole('button', { name: '确认拉取' }));
    await waitFor(() => expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(1));
    expect(editor.isEditable).toBe(false);
    act(() => { editor.view.dispatch(editor.state.tr.insertText('迟到输入', 1)); });
    await act(async () => { gate.resolve(await response({ snapshot: snapshot(remote, 'r2'), project: a, summary: '同步完成', warnings: [] })); });
    expect(editor.getText()).toContain('迟到输入第一篇正文');
    expect(screen.getByText(/同步期间又有新输入/)).toBeDefined();
    expect(screen.getByRole('button', { name: '重新载入磁盘版本' })).toBeDefined();
  });

  it('retains the original project and input when a late project-open response arrives', async () => {
    const gate = deferred<Response>(); route = url => url.endsWith('project-b/open') ? gate.promise : undefined;
    const { editor } = await open();
    await chooseProject(b.id);
    await waitFor(() => expect(requestsTo('/api/projects/project-b/open')).toHaveLength(1));
    act(() => { editor.view.dispatch(editor.state.tr.insertText('保留', 1)); });
    await act(async () => { gate.resolve(await response(result(b, hb))); });
    expect(editor.getText()).toContain('保留第一篇正文');
    expect(currentProjectName()).toBe(projectName(a.id));
    expect(screen.getByRole('alert').textContent).toContain('已保留当前稿件');
  });

  it('shows only the effective configuration directory and one modify action without writing on open', async () => {
    await open();openManagement();
    const panel=within(screen.getByRole('group',{name:'项目管理设置'}));
    const input=panel.getByLabelText('项目配置路径') as HTMLInputElement;
    expect(input.value).toBe('/Users/test/.lark-review');expect(input.readOnly).toBe(true);
    expect(panel.getAllByRole('button').map(button=>button.textContent)).toEqual(['修改']);
    expect(panel.queryByRole('checkbox')).toBeNull();expect(panel.queryByLabelText('项目管理文件路径')).toBeNull();
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it('saves document edits before applying a new configuration directory and keeps existing projects', async () => {
    const {editor}=await open();openManagement();
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'~/ReviewProjects/'}});
    act(()=>{editor.view.dispatch(editor.state.tr.insertText('尚未落盘',1));});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).readOnly).toBe(true));
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/Users/test/ReviewProjects');
    expect(files.get('a')!.xml).toBe('<p>尚未落盘第一篇正文</p>');
    expect(editor.getText()).toContain('尚未落盘第一篇正文');expect(currentProjectName()).toBe(a.name);
    const setting=requests.findIndex(request=>request.url==='/api/project-settings'&&request.method==='POST');
    expect(requests.findIndex(request=>request.method==='PUT')).toBeLessThan(setting);
    expect(requests[setting].value).toEqual({shared:true,path:'/Users/test/ReviewProjects/projects.json'});
    expect(list.projects).toEqual([a,b]);expect(requests.some(request=>request.url.endsWith('/sync'))).toBe(false);
  });

  it('keeps the effective directory and typed path when configuration merging fails', async () => {
    await open();openManagement();
    route=(url,options)=>url==='/api/project-settings'&&options.method==='POST'?response({error:'目标目录存在冲突项目，原配置未改变。'},409):undefined;
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'/Volumes/ReviewConflict'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false));
    const panel=within(screen.getByRole('group',{name:'项目管理设置'}));
    expect(panel.getByRole('alert').textContent).toContain('目标目录存在冲突项目');
    expect((panel.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/Volumes/ReviewConflict');
    expect((panel.getByLabelText('项目配置路径') as HTMLInputElement).readOnly).toBe(false);
    expect(panel.getByText('/Users/test/.lark-review',{selector:'code'})).toBeDefined();
    expect(projectSettingsState.path).toBe('/Users/test/.lark-review/projects.json');
    expect(currentProjectName()).toBe(a.name);expect(list.projects).toEqual([a,b]);
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(1);
  });

  it('does not change configuration while a comment is still being written', async () => {
    const {editor}=await open();openManagement();
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'/Volumes/Review'}});
    act(()=>{editor.commands.setTextSelection({from:1,to:3});});
    fireEvent.click(screen.getByRole('button',{name:'评论选中内容'}));
    fireEvent.change(screen.getByLabelText('评论内容'),{target:{value:'正在写的评论'}});
    openManagement();fireEvent.click(screen.getByRole('button',{name:'保存'}));
    expect((screen.getByLabelText('评论内容') as HTMLInputElement).value).toBe('正在写的评论');
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).readOnly).toBe(false);
    expect(projectSettingsState.path).toBe('/Users/test/.lark-review/projects.json');
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it('refreshes projects on window focus without replacing current content and ignores a late older list', async () => {
    const { editor } = await open(); const older = deferred<Response>(); let focused = 0;
    route = (url, options) => url === '/api/projects' && options.method === 'GET' && ++focused === 1 ? older.promise : undefined;
    act(() => { editor.view.dispatch(editor.state.tr.insertText('当前输入', 1)); });
    fireEvent(window, new Event('focus'));
    const additional = { ...b, id: 'from-another-client', name: '其他客户端新项目', localPath: '/project/other-client.xml' };
    list = { ...list, projects: [...list.projects, additional] };
    fireEvent(window, new Event('focus'));
    await openProjectPicker();
    await screen.findByRole('option', { name: additional.name });
    await act(async () => { older.resolve(await response({ projects: [a, b], activeProjectId: a.id, cloudAvailable: true })); });
    expect(screen.getByRole('option', { name: additional.name })).toBeDefined();
    expect(editor.getText()).toContain('当前输入第一篇正文');
    expect(currentProjectName()).toBe(projectName(a.id));
    await userEvent.keyboard('{Escape}');
    expect(requests.some(request => request.url.endsWith('/sync'))).toBe(false);
  });

  it('changes configuration only after save and restores the original directory on cancel', async () => {
    const user=userEvent.setup();await open();openManagement();
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    const input=screen.getByLabelText('项目配置路径') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input,{target:{value:'/Volumes/UnappliedReview'}});
    fireEvent(window,new Event('focus'));
    await waitFor(()=>expect(requestsTo('/api/projects').length).toBeGreaterThan(1));
    expect(input.value).toBe('/Volumes/UnappliedReview');
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
    await user.keyboard('{Escape}');
    await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('button',{name:'修改'})));
    expect(input.value).toBe('/Users/test/.lark-review');expect(input.readOnly).toBe(true);
    expect((screen.getByText('项目管理',{selector:'summary'}).parentElement as HTMLDetailsElement).open).toBe(true);
    expect(localStorage.getItem('lark-review.directory')).toBeNull();
  });

  it('shows an older effective directory without silently replacing it with the default or a cached draft', async () => {
    projectSettingsState={shared:false,path:'/instance/projects.json',sharedPath:'/Volumes/RememberedReview/projects.json',hasSharedPath:true,defaultSharedPath:'/Users/test/.lark-review/projects.json'};
    localStorage.setItem('lark-review.directory','/Volumes/BrowserDraft');
    const {mounted}=await open();openManagement();
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/instance');
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'/Volumes/UnappliedReview'}});
    mounted.unmount();await open();openManagement();
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/instance');
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it('validates a directory before enabling save and does not accept the index filename', async () => {
    await open();openManagement();fireEvent.click(screen.getByRole('button',{name:'修改'}));
    const input=screen.getByLabelText('项目配置路径');
    for(const value of ['relative/path','/Users/test/.lark-review/projects.json']) {
      fireEvent.change(input,{target:{value}});
      expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(input,{target:{value:'~/.lark-review-next/'}});
    expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false);
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it('finishes editing an unchanged legacy directory without trying to migrate onto its own index', async () => {
    projectSettingsState={shared:false,path:'/instance/projects.json',defaultSharedPath:'/Users/test/.lark-review/projects.json'};
    await open();openManagement();fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'/instance/'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/instance');
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it('does not submit configuration twice while the new directory is being applied', async () => {
    const pending=deferred<Response>();await open();openManagement();
    route=(url,options)=>url==='/api/project-settings'&&options.method==='POST'?pending.promise:undefined;
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('项目配置路径'),{target:{value:'/Volumes/PendingReview'}});
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(1));
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'正在保存…'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('项目配置路径').closest('form')!);
    await act(async()=>{pending.resolve(await response({...result(a,ha),settings:{...projectSettingsState,path:'/Volumes/PendingReview/projects.json'}}));});
    await waitFor(()=>expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).readOnly).toBe(true));
    expect((screen.getByLabelText('项目配置路径') as HTMLInputElement).value).toBe('/Volumes/PendingReview');
    expect(requestsTo('/api/project-settings').filter(request=>request.method==='POST')).toHaveLength(1);
  });

  it('restores the last successful project after remount only when the full server list still contains it', async () => {
    const { mounted } = await open();
    await chooseProject(b.id);
    await screen.findByText('第二篇本地资料'); mounted.unmount(); currentSession = sessionFor(a, ha);
    await open(); await screen.findByText('第二篇本地资料');
    expect(currentProjectName()).toBe(projectName(b.id));
    expect(requestsTo('/api/projects/project-b/open')).toHaveLength(2);
    expect(Object.keys(localStorage).sort()).toEqual(['lark-review.last-project']);
    expect(requests.some(request => request.url.endsWith('/sync'))).toBe(false);
  });

  it('ignores a deleted cached project and remains usable when browser storage is unavailable', async () => {
    localStorage.setItem('lark-review.last-project', 'deleted-project');
    const { mounted } = await open();
    expect(requestsTo('/api/projects/deleted-project/open')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull(); mounted.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    await open(); await chooseProject(b.id);
    await screen.findByText('第二篇本地资料'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps cloud targets beside preview controls and shows local actions directly in the toolbar', async () => {
    currentSession.cloud = { url: 'https://example.feishu.cn/docx/stale-session', documentId: 'stale-session', localPath: ha.path };
    await open();
    const context = within(screen.getByRole('banner', { name: '文档工作区' }));
    expect(context.getByRole('link', { name: '打开飞书文档' }).getAttribute('href')).toBe(a.cloud!.url);
    expect(context.getByLabelText('当前飞书绑定').getAttribute('title')).toBe(a.cloud!.url);
    expect(context.getByRole('button', { name: '预览差异' })).toBeDefined();
    expect(context.getByRole('button', { name: '拉取' })).toBeDefined();
    expect(context.getByRole('button', { name: '推送' })).toBeDefined();
    expect((context.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(ha.path);
    expect(context.getByRole('button', { name: '新建项目' })).toBeDefined();
    expect(context.getByRole('button', { name: '切换文档' })).toBeDefined();
    expect(screen.queryByRole('group', { name: '项目管理设置' })).toBeNull();
    expect(within(screen.getByRole('complementary', { name: '评论与内容编辑' })).queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeDefined();
    expect(screen.getByRole('button', { name: '切换文档' })).toBeDefined();
    expect(requests.some(request => request.url.endsWith('/preview') || request.url.endsWith('/sync'))).toBe(false);
  });

  it('explains create and switch on hover and keyboard focus without making the tooltip an action', async () => {
    const user=userEvent.setup();await open();
    const create=screen.getByRole('button',{name:'新建项目'}),switchDocument=screen.getByRole('button',{name:'切换文档'});
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(create);
    expect(screen.getByRole('tooltip').textContent).toContain('每个项目对应一篇正文');
    expect(screen.getByRole('tooltip').id).toBe(create.getAttribute('aria-describedby'));
    await user.unhover(create);expect(screen.queryByRole('tooltip')).toBeNull();
    act(()=>{switchDocument.focus();});
    expect(screen.getByRole('tooltip').textContent).toBe('选择另一份本地文档继续编辑；已有项目会恢复关联。不会向当前项目添加文件。');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();expect(document.activeElement).toBe(switchDocument);
    expect(requestsTo('/api/pick')).toHaveLength(0);
    expect(requestsTo('/api/projects').filter(request=>request.method==='POST')).toHaveLength(0);
  });

  it.each(['short','long'] as const)('copies the complete %s local path next to its visible value without saving or synchronizing', async length => {
    const user=userEvent.setup(), writeText=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
    const path=length==='short'?ha.path:'/Users/test/'+('较长的项目目录/'.repeat(18))+'文章与图表.xml';
    if(length==='long')vi.stubGlobal('innerWidth',375);
    const project={...a,localPath:path},handle={...ha,path,name:path.split('/').at(-1)!};
    currentSession=sessionFor(project,handle);list.projects[0]=project;handles.set(project.id,handle);
    await open();
    const input=screen.getByLabelText('当前文件路径') as HTMLInputElement;
    const copy=screen.getByRole('button',{name:'复制文件路径'});
    expect(input.value).toBe(path);expect(input.title).toBe(path);
    expect(input.parentElement?.querySelector('.file-path-measure')?.textContent).toBe(path);
    expect(input.parentElement?.nextElementSibling).toBe(copy);
    act(()=>input.focus());expect(input.selectionStart).toBe(0);expect(input.selectionEnd).toBe(path.length);
    const requestCount=requests.length;
    await user.click(copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(copy.title).toBe('已复制文件路径');expect(copy.classList.contains('copied')).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('已复制文件路径');
    expect(document.querySelector('.notice')).toBeNull();expect(requests).toHaveLength(requestCount);
  });

  it('copies the full cloud URL without navigating, then hides the action for an unbound document', async () => {
    const user=userEvent.setup(),writeText=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
    await open();
    const binding=screen.getByLabelText('当前飞书绑定'),copy=screen.getByRole('button',{name:'复制飞书链接'});
    expect(binding.nextElementSibling).toBe(copy);expect(copy.closest('a')).toBeNull();
    expect(binding.textContent).not.toContain('https://');
    const href=window.location.href,requestCount=requests.length;
    await user.click(copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(a.cloud!.url);
    expect(copy.title).toBe('已复制飞书链接');expect(window.location.href).toBe(href);
    expect(screen.getByRole('status').textContent).toBe('已复制飞书链接');
    expect(requests).toHaveLength(requestCount);
    await chooseProject(b.id);await screen.findByText('第二篇本地资料');
    expect(screen.queryByRole('button',{name:'复制飞书链接'})).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    await user.click(screen.getByRole('button',{name:'复制文件路径'}));
    expect(writeText).toHaveBeenLastCalledWith(b.localPath);
    expect(requests.some(request=>request.method==='PUT'||request.url.endsWith('/sync'))).toBe(false);
  });

  it('reports a clipboard failure without marking it copied or changing document data', async () => {
    const user=userEvent.setup();vi.spyOn(navigator.clipboard,'writeText').mockRejectedValue(new Error('denied'));
    await open();const requestCount=requests.length;
    await user.click(screen.getByRole('button',{name:'复制飞书链接'}));
    expect(screen.getByText('复制失败，可从“打开飞书文档”链接手动复制地址。')).toBeDefined();
    expect(screen.getByRole('button',{name:'复制飞书链接'}).classList.contains('copied')).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('');expect(requests).toHaveLength(requestCount);
  });

  it('keeps action help inside a narrow viewport and does not cover the creation dialog after clicking', async () => {
    vi.stubGlobal('innerWidth',375);
    const user=userEvent.setup();await open();
    const create=screen.getByRole('button',{name:'新建项目'});
    vi.spyOn(create,'getBoundingClientRect').mockReturnValue(new DOMRect(330,10,88,32));
    await user.hover(create);
    const tooltip=screen.getByRole('tooltip');
    expect(parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(12);
    expect(parseFloat(tooltip.style.left)+parseFloat(tooltip.style.width)).toBeLessThanOrEqual(363);
    expect(parseFloat(tooltip.style.top)).toBeGreaterThan(42);
    await user.click(create);expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('项目名称'));
    await user.keyboard('{Escape}');expect(document.activeElement).toBe(create);
  });

  it('switches a registered local document through the direct action and restores its project without creating or adding files', async () => {
    const picking=deferred<Response>();
    route=url=>url==='/api/pick'?picking.promise:undefined;
    await open();fireEvent.click(screen.getByRole('button',{name:'切换文档'}));
    await waitFor(()=>expect(requestsTo('/api/pick')).toHaveLength(1));
    expect((screen.getByRole('button',{name:'切换文档'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'新建项目'}) as HTMLButtonElement).disabled).toBe(true);
    currentSession=sessionFor(b,hb);
    await act(async()=>{picking.resolve(await response(hb));});
    await screen.findByText('第二篇本地资料');
    expect(currentProjectName()).toBe(b.name);
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(b.localPath);
    expect(requestsTo('/api/projects').filter(request=>request.method==='POST')).toHaveLength(0);
    expect(requests.some(request=>request.method==='PUT'||request.url.endsWith('/sync')||request.url.endsWith('/bind'))).toBe(false);
    expect(list.projects.map(project=>project.localPath)).toEqual([a.localPath,b.localPath]);
  });

  it('updates the top cloud link when switching between cloud projects without writing to either document', async () => {
    const linked = { ...b, cloud: { documentId: 'cloud-b', url: 'https://example.feishu.cn/docx/cloud-b' } };
    list.projects[1] = linked;
    await open();
    await chooseProject(linked.id);
    await screen.findByText('第二篇本地资料');
    expect(screen.getByRole('link', { name: '打开飞书文档' }).getAttribute('href')).toBe(linked.cloud.url);
    expect(screen.getByLabelText('当前飞书绑定').getAttribute('title')).toBe(linked.cloud.url);
    expect(requests.some(request => request.method === 'PUT' || request.url.endsWith('/sync'))).toBe(false);
  });

  it('labels resource paths and shows the actual XML and cloud targets in the synchronization preview', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: '项目资源' })).getByTitle(ha.reviewPath));
    await screen.findByRole('region', { name: '资源预览' });
    expect(within(screen.getByRole('navigation', { name: '当前文件' })).getByText('资源')).toBeDefined();
    expect((screen.getByLabelText('当前文件路径') as HTMLInputElement).value).toBe(ha.reviewPath);
    expect(screen.getByText('正文同步：a.xml')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '预览差异' }));
    const dialog = within(await screen.findByRole('dialog', { name: '正文同步预览' }));
    expect(dialog.getByLabelText('正文同步本地路径').textContent).toBe(ha.path);
    expect(dialog.getByRole('link', { name: '正文同步飞书链接' }).getAttribute('href')).toBe(a.cloud!.url);
    expect(dialog.getByLabelText('本地正文源码').textContent).toBe(original);
    expect(requestsTo('/api/projects/project-a/preview')).toHaveLength(1);
    expect(requestsTo('/api/projects/project-a/sync')).toHaveLength(0);
  });

  it.each(['keyboard', 'pointer'] as const)('focuses the narrow comment panel after %s opening so Escape immediately returns to the entry', async kind => {
    vi.stubGlobal('innerWidth', 768);
    const user = userEvent.setup(); await open();
    const entry = screen.getByRole('button', { name: '查看评论' });
    if (kind === 'keyboard') { act(() => { entry.focus(); }); await user.keyboard('{Enter}'); }
    else await user.click(entry);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭评论面板' }));
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(entry);
  });

  it('keeps a selected comment draft while tabbing out of the narrow nonmodal panel and reopening it', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup(); const { editor } = await open();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 3 }); });
    fireEvent.click(screen.getByRole('button', { name: '评论选中内容' }));
    const input = screen.getByLabelText('评论内容') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    await user.type(input, '继续保留未发送意见');
    const panel = screen.getByRole('complementary', { name: '评论与内容编辑' });
    for (let step = 0; step < 8 && panel.contains(document.activeElement); step++) await user.tab({ shift: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(panel.contains(document.activeElement)).toBe(false);
    const entry = screen.getByRole('button', { name: '查看评论' });
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('继续保留未发送意见');
    await user.click(entry);
    expect(entry.getAttribute('aria-expanded')).toBe('true');
    expect(input.value).toBe('继续保留未发送意见');
    await user.click(input);
    expect(document.activeElement).toBe(input);
    expect(requests.some(request => request.method === 'PUT')).toBe(false);
  });

  it('keeps the narrow comment panel and its draft open when clicking nonfocusable text inside it', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup(); const { editor } = await open();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 3 }); });
    fireEvent.click(screen.getByRole('button', { name: '评论选中内容' }));
    const input = screen.getByLabelText('评论内容') as HTMLTextAreaElement;
    await user.type(input, '点击面板内部仍需保留');
    const panel = screen.getByRole('complementary', { name: '评论与内容编辑' });
    await user.click(within(panel).getByText('留下你的想法'));
    expect(screen.getByRole('button', { name: '查看评论' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(panel);
    expect(input.value).toBe('点击面板内部仍需保留');
    expect(requests.some(request => request.method === 'PUT')).toBe(false);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '查看评论' }).getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('点击面板内部仍需保留');
  });

  it('keeps project operations open after editing its settings and clicking explanatory text inside', async () => {
    const user = userEvent.setup(); await open(); openManagement();
    await user.click(screen.getByRole('button',{name:'修改'}));
    const input = screen.getByLabelText('项目配置路径') as HTMLInputElement;
    await user.clear(input); await user.type(input, '/Volumes/MyReview');
    await user.click(screen.getByText('/Users/test/.lark-review',{selector:'code'}));
    const menu = screen.getByText('项目管理', { selector: 'summary' });
    expect((menu.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(input.value).toBe('/Volumes/MyReview');
    expect(requestsTo('/api/project-settings').filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('returns focus after keyboard creation cancellation and renders the dialog outside the sticky header', async () => {
    vi.stubGlobal('innerWidth', 768);
    const user = userEvent.setup(); await open();
    const entry = screen.getByRole('button', { name: '查看评论' });
    await user.click(entry);
    const menu = screen.getByRole('button', { name: '新建项目' });
    act(() => { menu.focus(); });
    expect(document.activeElement).toBe(menu);
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    expect(dialog.closest('.workspace-header')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('项目名称'));
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('closes project operations when tab focus moves outside without moving focus back', async () => {
    const user = userEvent.setup(); await open();
    const menu = screen.getByText('项目管理', { selector: 'summary' });
    await user.click(menu);
    const details = menu.parentElement as HTMLDetailsElement;
    for (let step = 0; step < 6 && details.contains(document.activeElement); step++) await user.tab();
    expect(details.open).toBe(false);
    expect(document.activeElement).not.toBe(menu);
    expect(details.contains(document.activeElement)).toBe(false);
  });
});
