// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { redoNoScroll, undoNoScroll } from '@tiptap/pm/history';
import { parseDocxXML } from '../src/core/docxml';
import { captureAnchor } from '../src/core/anchors';
import { createReview, type Review, type ReviewComment } from '../src/core/types';
import { xmlExtensions } from '../src/ui/xml-extensions';
import { Reader } from '../src/ui/Reader';

const editors: Editor[] = [];
function open(xml: string) {
  const adapter = parseDocxXML(xml);
  const editor = new Editor({ element: document.createElement('div'), extensions: xmlExtensions(), content: adapter.content });
  editors.push(editor);
  return { adapter, editor, code: () => editor.view.dom.querySelector('code')!, lines: () => editor.view.dom.querySelectorAll('.lr-code-lines span') };
}
afterEach(() => { cleanup(); editors.splice(0).forEach(editor => editor.destroy()); });

describe('DocxXML code highlighting and line numbers', () => {
  it.each(['Go', 'golang'])('highlights %s without touching XML bytes, blank lines, tabs or read-only selections', language => {
    const code = 'package main\n\nfunc main() {\n\tprintln("中文😀") // 注释\n}\n';
    const xml = `<pre id='code' lang='${language}' caption='保留标题'><code data-original='keep'><![CDATA[${code}]]></code></pre>`;
    const { adapter, editor, code: codeDOM, lines } = open(xml);
    expect(codeDOM().textContent).toBe(code);
    expect(codeDOM().getAttribute('spellcheck')).toBe('false');
    expect(codeDOM().querySelector('.hljs-keyword')?.textContent).toBe('package');
    expect(codeDOM().querySelector('.hljs-string')?.textContent).toBe('"中文😀"');
    expect(codeDOM().querySelector('.hljs-comment')?.textContent).toBe('// 注释');
    expect([...lines()].map(line => (line as HTMLElement).dataset.line)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(editor.view.dom.querySelector('.lr-code-lines')?.textContent).toBe('');
    expect(editor.view.dom.querySelector('.lr-code-lines')?.getAttribute('aria-hidden')).toBe('true');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    const from = 1 + code.indexOf('中文');
    editor.commands.setTextSelection({ from, to: from + '中文😀'.length });
    editor.setEditable(false);
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('中文😀');
    expect(captureAnchor(editor.state.doc, from, from + '中文😀'.length)?.quote).toBe('中文😀');
    expect(codeDOM().querySelector('.hljs-string')?.textContent).toBe('"中文😀"');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    editor.commands.setTextSelection({ from: 1, to: 1 + code.length });
    const clipboard = new Map<string, string>();
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: {
      clearData: () => clipboard.clear(), setData: (format: string, value: string) => clipboard.set(format, value),
    } });
    editor.view.dom.dispatchEvent(copy);
    expect(clipboard.get('text/plain')).toBe(code);
    const copiedHTML = document.createElement('div'); copiedHTML.innerHTML = clipboard.get('text/html')!;
    expect(copiedHTML.textContent).toBe(code);
    expect(copiedHTML.querySelector('.lr-code-caption,.lr-code-lines,.hljs-keyword')).toBeNull();
  });

  it('recomputes syntax across multiline edits and undo while preserving full-fetch br separators', () => {
    const xml = '<pre lang="JavaScript" caption="真实回读形状"><code>const answer = 42;<br/><br/>console.log("😀", answer);<br/></code></pre>';
    const { adapter, editor, code, lines } = open(xml);
    expect(code().querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(lines()).toHaveLength(4);
    const original = editor.state.doc.firstChild!.textContent;
    const firstBreak = 1 + original.indexOf('\n');
    editor.view.dispatch(editor.state.tr.insertText('\n/* 多行注释\n第二行 😀 */', firstBreak));
    expect(code().querySelector('.hljs-comment')?.textContent).toBe('/* 多行注释\n第二行 😀 */');
    expect(lines()).toHaveLength(6);
    const edited = adapter.serialize(editor.getJSON());
    expect(edited).toBe(xml.replace('42;<br/>', '42;<br/>/* 多行注释<br/>第二行 😀 */<br/>'));
    expect(edited).not.toContain('hljs');
    expect(edited).not.toContain('data-line');
    expect(parseDocxXML(edited).content.content![0].content![0].text).toBe(code().textContent);
    expect(undoNoScroll(editor.state, transaction => editor.view.dispatch(transaction))).toBe(true);
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    expect(code().querySelector('.hljs-comment')).toBeNull();
    expect(lines()).toHaveLength(4);
    expect(redoNoScroll(editor.state, transaction => editor.view.dispatch(transaction))).toBe(true);
    expect(adapter.serialize(editor.getJSON())).toBe(edited);
    expect(lines()).toHaveLength(6);
  });

  it('uses plain code for unknown or empty languages and refreshes after a language transaction', () => {
    const xml = '<pre lang="custom-template-v2"><code>const example = "&lt;script&gt;";</code></pre>';
    const { adapter, editor, code } = open(xml);
    expect(code().querySelector('span')).toBeNull();
    expect(code().textContent).toBe('const example = "<script>";');
    expect(editor.view.dom.querySelector('.lr-code-language')?.textContent).toBe('custom-template-v2');
    expect(adapter.serialize(editor.getJSON())).toBe(xml);
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'language', 'js'));
    expect(code().querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(editor.view.dom.querySelector('.lr-code-language')?.textContent).toBe('js');
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('custom-template-v2', 'js'));
    editor.view.dispatch(editor.state.tr.setNodeAttribute(0, 'language', null));
    expect(code().querySelector('span')).toBeNull();
    expect(editor.view.dom.querySelector('.lr-code-header')?.hasAttribute('hidden')).toBe(true);
    expect(code().querySelector('script')).toBeNull();
  });

  it('accepts real contentDOM edits inside highlighted spans without reading line numbers into code', async () => {
    const xml = '<pre lang="js"><code>const answer = 42;<br/>// 保留注释</code></pre>';
    const { adapter, editor, code, lines } = open(xml);
    const keywordText = code().querySelector('.hljs-keyword')!.firstChild!;
    keywordText.nodeValue = 'let';
    await waitFor(() => expect(editor.state.doc.firstChild!.textContent).toBe('let answer = 42;\n// 保留注释'));
    expect(adapter.serialize(editor.getJSON())).toBe(xml.replace('const', 'let'));
    expect(code().querySelector('.hljs-keyword')?.textContent).toBe('let');
    code().textContent = 'let answer = 43;\n\n// 新注释 😀';
    await waitFor(() => expect(editor.state.doc.firstChild!.textContent).toBe('let answer = 43;\n\n// 新注释 😀'));
    expect(lines()).toHaveLength(3);
    expect(code().querySelector('.hljs-comment')?.textContent).toBe('// 新注释 😀');
    expect(adapter.serialize(editor.getJSON())).toBe('<pre lang="js"><code>let answer = 43;<br/><br/>// 新注释 😀</code></pre>');
  });

  it('keeps real Reader comments attached across emoji and multiline edits inside decorated code', async () => {
    const code = 'const icon = "😀";\n// 评论目标 😀\nconsole.log(icon);';
    const xml = `<pre lang="js"><code>${code}</code></pre>`;
    const from = 1 + code.indexOf('评论目标');
    const anchor = { from, to: from + '评论目标 😀'.length, quote: '评论目标 😀', state: 'attached' as const };
    const comment: ReviewComment = { id: 'code-comment', author: '人类', body: '补全说明', createdAt: '2026-09-12T00:00:00.000Z', status: 'open', anchor, replies: [] };
    let review: Review = { ...createReview('code.xml', xml), comments: [comment] };
    let editor: Editor | undefined;
    const saves: string[] = [];
    const errors: string[] = [];
    const props = {
      xml, readOnly: false, assetURL: (path: string) => path, comments: [comment], getReview: () => review, getDraft: () => null,
      onReady: (value: Editor) => { editor = value; }, onSelection: () => {}, onError: (error: string) => { errors.push(error); },
      onEdit: (nextXML: string, comments: ReviewComment[]) => {
        saves.push(nextXML); review = { ...review, comments, document: { ...review.document, xml: nextXML } };
      },
    };
    const mounted = render(<Reader {...props}/>);
    await waitFor(() => expect(editor).toBeDefined());
    const prefix = '// 新增 😀\n\n';
    act(() => { editor!.view.dispatch(editor!.state.tr.insertText(prefix, 1)); });
    const mapped = review.comments[0].anchor;
    expect(mapped).toEqual({ ...anchor, from: anchor.from + prefix.length, to: anchor.to + prefix.length });
    expect(editor!.state.doc.textBetween(mapped.from, mapped.to)).toBe(anchor.quote);
    mounted.rerender(<Reader {...props} xml={review.document.xml} comments={review.comments} readOnly/>);
    expect(document.querySelector('[data-comment-id="code-comment"]')?.textContent).toBe(anchor.quote);
    expect(document.querySelectorAll('.lr-code-lines span')).toHaveLength(5);
    expect(saves).toHaveLength(1);
    expect(saves[0]).not.toMatch(/hljs|data-line|comment-highlight/);
    expect(errors).toEqual([]);
  });
});
