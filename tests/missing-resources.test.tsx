// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { Reader } from '../src/ui/Reader';
import { createReview, type ResourceManifest } from '../src/core/types';
import { parseDocxXML } from '../src/core/docxml';
import { resolveResourceFailure } from '../src/core/resources';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open(xml: string, resources?: ResourceManifest, load = async () => 'text', assetURL = (path:string) => 'blob:' + path) {
  let editor!: Editor;
  const onEdit = vi.fn(), review = {...createReview('sample.xml', xml), resources};
  const view = render(<Reader xml={xml} readOnly assetURL={assetURL} readResourceText={load}
    comments={[]} getReview={() => review} getDraft={() => null} onEdit={onEdit} onSelection={() => {}}
    onReady={value => { editor = value; }} onError={() => {}}/>);
  await waitFor(() => expect(editor).toBeDefined());
  return {...view, editor, onEdit};
}
describe('visible missing resources', () => {
  it('reports host-rejected image URLs immediately even when lazy images never emit an error', async()=>{
    const {container,editor}=await open('<img path="@lost.png"/><source path="@lost.png"/><whiteboard token="board"/>',
      {version:1,items:[{tag:'whiteboard',attribute:'token',value:'board',path:'lost.png',representation:'preview'}]},undefined,()=> 'data:,');
    await waitFor(()=>expect(container.querySelector('.resource-notice summary')?.textContent).toContain('3 处'));
    expect(editor.view.dom.querySelector('img[src]')).toBeNull();
  });
  it('shows named in-place placeholders and a count including inline files, without exposing tokens or editing XML', async () => {
    const xml = '<img src="private-image-token" name="&lt;script&gt;.png"/><p>内嵌<source token="private-file-token" name="note.md"/></p><source token="private-video-token" name="demo.mp4" mime="video/mp4"/><whiteboard token="private-board-token"/>';
    const {container, editor, onEdit} = await open(xml);
    await waitFor(() => expect(container.querySelector('.resource-notice summary')?.textContent).toContain('4 处'));
    const body = editor.view.dom;
    expect(body.querySelectorAll('[data-resource-issue]')).toHaveLength(4);
    expect(body.textContent).toContain('图片：<script>.png');
    expect(body.textContent).toContain('视频');
    expect(body.textContent).toContain('无可用本地映射');
    expect(container.textContent).not.toContain('private-');
    expect(body.querySelector('script,img[src],video')).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
    expect(parseDocxXML(xml).serialize(editor.getJSON())).toBe(xml);
  });
  it('distinguishes recorded denial and not-downloaded evidence; unrelated or ambiguous records cannot claim permission failure', async () => {
    const failures = [{tag:'img',attribute:'src',value:'denied',reason:'http-403'}, {tag:'source',attribute:'token',value:'pending',reason:'not-downloaded'}] as const;
    const resources: ResourceManifest = {version:1,items:[],failures:[...failures]};
    const {editor} = await open('<img src="denied"/><source token="pending" name="note.md"/><img src="unknown"/>', resources);
    const issues = [...editor.view.dom.querySelectorAll('[data-resource-issue]')].map(el=>el.textContent);
    expect(issues[0]).toContain('403'); expect(issues[1]).toContain('未下载到本地');
    expect(issues[2]).toContain('无可用本地映射'); expect(issues[2]).not.toContain('权限');
    expect(resolveResourceFailure({...resources,failures:[failures[0],failures[0]]},'img',{src:'denied'})).toBeUndefined();
    expect(resolveResourceFailure(resources,'img',{token:'denied'})).toBeUndefined();
    expect(resolveResourceFailure({...resources,failures:[{...failures[0],reason:'secret error'}]},'img',{src:'denied'})).toBeUndefined();
  });
  it('counts image, text and video load failures, leaves valid resources untouched and preserves source', async () => {
    vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
    vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
    const xml = '<img path="@missing.png" name="lost.png"/><source path="@note.md" name="note.md"/><source path="@bad.mp4" name="bad.mp4" mime="video/mp4"/><img path="@good.png" name="good.png"/>';
    const {container, editor, onEdit} = await open(xml, undefined, async()=>{throw new Error('private request token');});
    const images = editor.view.dom.querySelectorAll('img');
    act(()=>{images[0].dispatchEvent(new Event('error')); images[1].dispatchEvent(new Event('load')); editor.view.dom.querySelector('video')!.dispatchEvent(new Event('error'));});
    await waitFor(()=>expect(container.querySelector('.resource-notice summary')?.textContent).toContain('3 处'));
    expect(editor.view.dom.querySelectorAll('img')).toHaveLength(1);
    expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('blob:good.png');
    expect(container.textContent).toContain('缺失或不可读取');
    expect(container.textContent).not.toContain('private request token');
    expect(parseDocxXML(xml).serialize(editor.getJSON())).toBe(xml);
    expect(onEdit).not.toHaveBeenCalled();
    const first = editor.view.dom.querySelector<HTMLElement>('[data-resource-issue]')!;
    first.scrollIntoView = vi.fn();
    fireEvent.click(container.querySelector('.resource-notice button')!);
    expect(first.scrollIntoView).toHaveBeenCalled();
  });
});
