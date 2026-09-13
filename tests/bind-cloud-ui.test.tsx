// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BindCloud } from '../src/ui/BindCloud';
import type { ReviewProject } from '../src/core/projects';

const project: ReviewProject = { id: 'local-project', name: '待发布的本地文章', localPath: '/articles/长目录/母稿.xml', defaultDirection: 'pull', createdAt: '2026-09-13T00:00:00Z' };
const url = 'https://example.feishu.cn/docx/test-document';
type Props = React.ComponentProps<typeof BindCloud>;
function mount(overrides: Partial<Props> = {}) {
  const props: Props = { project, cloudAvailable: true, busy: false, error: '', onClose: vi.fn(), onBind: vi.fn(async () => false), ...overrides };
  const rendered = render(<BindCloud {...props}/>);
  return { ...rendered, props, rerenderProps: (changes: Partial<Props>) => rendered.rerender(<BindCloud {...props} {...changes}/>) };
}
function enterURL(value = url) { fireEvent.change(screen.getByLabelText('飞书文档链接'), { target: { value } }); }
function chooseNew() { fireEvent.click(screen.getByRole('button', { name: '新建飞书文档' })); }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  const style = document.createElement('style');
  style.dataset.bindTest = 'true';
  style.textContent = 'details:not([open]) > :not(summary) { display:none; }';
  document.head.append(style);
});
afterEach(() => { cleanup(); document.querySelectorAll('[data-bind-test]').forEach(element => element.remove()); vi.restoreAllMocks(); });

describe('existing local project cloud binding form', () => {
  it('shows the precise current local target and defaults to existing cloud with push, without calling the callback', () => {
    const { props } = mount();
    expect(screen.getByRole('dialog', { name: '关联飞书' })).toBeDefined();
    expect(screen.getByText(project.name)).toBeDefined();
    expect((screen.getByLabelText('关联项目本地文件') as HTMLInputElement).value).toBe(project.localPath);
    expect((screen.getByLabelText('关联项目本地文件') as HTMLInputElement).readOnly).toBe(true);
    expect(button('关联已有飞书文档').getAttribute('aria-pressed')).toBe('true');
    expect(button('本地 → 飞书').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('只建立关联，不改动两端正文。后续同步前先预览差异。')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText('飞书文档链接'));
    expect(button('关联文档').disabled).toBe(true);
    expect(props.onBind).not.toHaveBeenCalled();
  });

  it('validates the link visibly and never submits unsupported protocols or non-document URLs', () => {
    const { props } = mount();
    for (const value of ['http://example.feishu.cn/docx/id', 'https://example.com/docx/id', 'https://example.feishu.cn/drive/home', 'https://user:pass@example.feishu.cn/docx/id', 'https://example.feishu.cn.evil.example/docx/id']) {
      enterURL(value);
      expect(button('关联文档').disabled).toBe(true);
      expect(screen.getByText('请输入 https:// 开头的飞书或 Lark Docx / Wiki 文档链接。')).toBeDefined();
      fireEvent.submit(screen.getByRole('dialog'));
    }
    expect(props.onBind).not.toHaveBeenCalled();
    enterURL('https://example.larkoffice.com/wiki/wiki_id?from=share#section');
    expect(button('关联文档').disabled).toBe(false);
  });

  it('submits existing binding with the selected direction and closes only after true', async () => {
    const { props } = mount({ onBind: vi.fn(async () => true) });
    enterURL('  ' + url + '  ');
    fireEvent.click(button('飞书 → 本地'));
    await userEvent.click(button('关联文档'));
    expect(props.onBind).toHaveBeenCalledExactlyOnceWith({ cloud: { kind: 'existing', url }, defaultDirection: 'pull' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('names the write explicitly and publishes the current project title with an optional folder', async () => {
    const { props } = mount();
    chooseNew();
    expect((screen.getByLabelText('飞书文档标题') as HTMLInputElement).value).toBe(project.name);
    expect(screen.getByText('将当前本地文章发布为一篇新的飞书文档，并与此项目关联。')).toBeDefined();
    await userEvent.click(screen.getByText('指定飞书文件夹（可选）', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('飞书文件夹 Token'), { target: { value: '  folder_01  ' } });
    fireEvent.change(screen.getByLabelText('飞书文档标题'), { target: { value: '  新文章  ' } });
    await userEvent.click(button('新建并发布当前文章'));
    expect(props.onBind).toHaveBeenCalledExactlyOnceWith({ cloud: { kind: 'new', title: '新文章', parentToken: 'folder_01' }, defaultDirection: 'push' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('explains invalid title and folder values and omits an empty folder from the submitted input', async () => {
    const { props } = mount(); chooseNew();
    fireEvent.change(screen.getByLabelText('飞书文档标题'), { target: { value: '  ' } });
    expect(button('新建并发布当前文章').disabled).toBe(true);
    expect(screen.getByText('请输入飞书文档标题。')).toBeDefined();
    fireEvent.change(screen.getByLabelText('飞书文档标题'), { target: { value: '字'.repeat(201) } });
    expect(button('新建并发布当前文章').disabled).toBe(true);
    expect(screen.getByText('标题需在 200 个字符以内，且不能包含控制字符。')).toBeDefined();
    fireEvent.change(screen.getByLabelText('飞书文档标题'), { target: { value: '有效标题' } });
    await userEvent.click(screen.getByText('指定飞书文件夹（可选）', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('飞书文件夹 Token'), { target: { value: 'https://example.feishu.cn/folder/test' } });
    expect(button('新建并发布当前文章').disabled).toBe(true);
    expect(screen.getByText(/文件夹 Token 只能包含/)).toBeDefined();
    fireEvent.change(screen.getByLabelText('飞书文件夹 Token'), { target: { value: ' ' } });
    await userEvent.click(button('新建并发布当前文章'));
    expect(props.onBind).toHaveBeenCalledExactlyOnceWith({ cloud: { kind: 'new', title: '有效标题' }, defaultDirection: 'push' });
  });

  it('allows inspecting and cancelling the form without a configured CLI but disables all submissions', async () => {
    const { props } = mount({ cloudAvailable: false });
    enterURL();
    expect(screen.getByRole('status').textContent).toContain('本机启动配置');
    expect(button('关联文档').disabled).toBe(true);
    fireEvent.submit(screen.getByRole('dialog'));
    chooseNew();
    expect(button('新建并发布当前文章').disabled).toBe(true);
    fireEvent.submit(screen.getByRole('dialog'));
    await userEvent.click(button('取消'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onBind).not.toHaveBeenCalled();
  });

  it('retains the entered link and chosen mode after a false response and displays the parent error', async () => {
    const { props, rerenderProps } = mount();
    enterURL(); await userEvent.click(button('关联文档'));
    rerenderProps({ error: '文档没有编辑权限，请检查当前连接。' });
    expect(screen.getByRole('alert').textContent).toBe('文档没有编辑权限，请检查当前连接。');
    expect((screen.getByLabelText('飞书文档链接') as HTMLInputElement).value).toBe(url);
    expect(button('关联文档').disabled).toBe(false);
    expect(props.onBind).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('handles a rejected request without exposing raw transport details or retrying', async () => {
    const { props } = mount({ onBind: vi.fn(async () => { throw new Error('token=private-value'); }) });
    enterURL(); await userEvent.click(button('关联文档'));
    expect(screen.getByRole('alert').textContent).toBe('关联未完成，请核对错误信息后再操作。');
    expect(document.body.textContent).not.toContain('private-value');
    expect((screen.getByLabelText('飞书文档链接') as HTMLInputElement).value).toBe(url);
    expect(props.onBind).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('locks immediately while the promise is pending, blocks duplicate submits and Escape, then unlocks on failure', async () => {
    let done!: (result: boolean) => void;
    const onBind = vi.fn(() => new Promise<boolean>(resolve => { done = resolve; }));
    const { props } = mount({ onBind });
    enterURL();
    fireEvent.submit(screen.getByRole('dialog'));
    fireEvent.submit(screen.getByRole('dialog'));
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    expect(button('关闭关联飞书').disabled).toBe(true);
    expect(button('取消').disabled).toBe(true);
    expect(screen.getByLabelText('飞书文档链接').matches(':disabled')).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => done(false));
    expect(button('关联文档').disabled).toBe(false);
    expect((screen.getByLabelText('飞书文档链接') as HTMLInputElement).value).toBe(url);
  });

  it('honors parent busy state for the optional disclosure and restores normal interaction afterwards', async () => {
    const { props, rerenderProps } = mount(); chooseNew();
    const summary = screen.getByText('指定飞书文件夹（可选）', { selector: 'summary' });
    rerenderProps({ busy: true });
    await userEvent.click(summary);
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
    expect(summary.tabIndex).toBe(-1);
    fireEvent.submit(screen.getByRole('dialog'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onBind).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    rerenderProps({ busy: false });
    await userEvent.click(summary);
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true);
    expect(button('新建并发布当前文章').disabled).toBe(false);
  });

  it('portals outside a disabled parent, traps keyboard focus, and restores the opener on unmount', async () => {
    const opener = document.createElement('button'); opener.dataset.bindTest = 'true'; opener.textContent = '关联入口'; document.body.append(opener); opener.focus();
    const onClose = vi.fn(), onBind = vi.fn(async () => false);
    const mounted = render(<fieldset disabled><BindCloud project={project} cloudAvailable busy={false} error="" onClose={onClose} onBind={onBind}/></fieldset>);
    enterURL();
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(document.body);
    expect(screen.getByLabelText('飞书文档链接').matches(':disabled')).toBe(false);
    expect(button('关联文档').disabled).toBe(false);
    button('关联文档').focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(button('关闭关联飞书'));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(button('关联文档'));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBind).not.toHaveBeenCalled();
    mounted.unmount();
    expect(document.activeElement).toBe(opener);
  });
});
