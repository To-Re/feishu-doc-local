// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourceEditor } from '../src/ui/SourceEditor';

const original = '<docx>\n  <p id="p1" unknown="keep">原文 &amp; <b>样式</b></p>\n</docx>';
const source = () => screen.getByRole('textbox', { name: '文档源码' }) as HTMLTextAreaElement;
function Controlled({ initial = original, onChange = (_value: string) => {} }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <SourceEditor value={value} onChange={next => { onChange(next); setValue(next); }}/>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('whole-document source editor', () => {
  it('displays literal XML and preserves its whitespace, attributes and entities without an initial write', () => {
    const onChange = vi.fn();
    render(<SourceEditor value={original} onChange={onChange}/>);
    expect(source().value).toBe(original);
    expect(source().wrap).toBe('soft');
    expect(source().getAttribute('spellcheck')).toBe('false');
    expect(source().getAttribute('autocapitalize')).toBe('off');
    expect(screen.queryByText('样式', { selector: 'b' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('passes each native edit synchronously to the parent without parsing or repairing incomplete XML', async () => {
    const onChange = vi.fn();
    render(<Controlled initial="" onChange={onChange}/>);
    const replacement = original + '\n<unfinished attr="';
    await userEvent.type(source(), replacement);
    expect(onChange).toHaveBeenLastCalledWith(replacement);
    expect(source().value).toBe(replacement);
    fireEvent.change(source(), { target: { value: replacement + 'x' } });
    expect(onChange).toHaveBeenLastCalledWith(replacement + 'x');
    expect(source().value).toBe(replacement + 'x');
  });

  it('reports the active selection edge and counts Unicode characters instead of UTF-16 halves', async () => {
    const xml = '<p>🙂</p>\n  中文';
    render(<Controlled initial={xml}/>);
    await userEvent.click(source());
    const lineStart = xml.indexOf('\n') + 1;
    source().setSelectionRange(lineStart, lineStart + 3, 'forward');
    fireEvent.select(source());
    expect(screen.getByText('第 2 行，第 4 列')).toBeDefined();
    expect(screen.getByText(Array.from(xml).length + ' 字符')).toBeDefined();
    source().setSelectionRange(lineStart, lineStart + 3, 'backward');
    fireEvent.select(source());
    expect(screen.getByText('第 2 行，第 1 列')).toBeDefined();
    source().setSelectionRange(5, 5);
    fireEvent.select(source());
    expect(screen.getByText('第 1 行，第 5 列')).toBeDefined();
  });

  it('allows selection while read-only and blocks both user typing and change callbacks', async () => {
    const onChange = vi.fn();
    render(<SourceEditor value={original} readOnly onChange={onChange}/>);
    await userEvent.click(source());
    await userEvent.keyboard('{End}不会写入');
    expect(source().value).toBe(original);
    source().setSelectionRange(0, 6);
    fireEvent.select(source());
    expect(source().value.slice(source().selectionStart, source().selectionEnd)).toBe('<docx>');
    fireEvent.change(source(), { target: { value: 'forced change' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('respects an enclosing disabled fieldset while a parent operation is in progress', async () => {
    const onChange = vi.fn();
    render(<fieldset disabled><SourceEditor value={original} onChange={onChange}/></fieldset>);
    expect(source().matches(':disabled')).toBe(true);
    await userEvent.type(source(), '不会写入');
    fireEvent.change(source(), { target: { value: 'forced change' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts a new parent value and exposes validation errors without modifying or auto-saving it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SourceEditor value={original} onChange={onChange}/>);
    rerender(<SourceEditor value="<p>未闭合" onChange={onChange} error="第 1 行：缺少结束标签"/>);
    expect(source().value).toBe('<p>未闭合');
    expect(source().getAttribute('aria-invalid')).toBe('true');
    expect(source().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(screen.getByRole('alert').textContent).toBe('第 1 行：缺少结束标签');
    expect(onChange).not.toHaveBeenCalled();
    rerender(<SourceEditor value="<p>已修复</p>" onChange={onChange}/>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(source().getAttribute('aria-invalid')).toBe('false');
    expect(source().getAttribute('aria-describedby')).toBeNull();
  });

  it('does not intercept native undo and redo keyboard shortcuts', () => {
    render(<SourceEditor value={original} onChange={vi.fn()}/>);
    for (const [key, ctrlKey, metaKey, shiftKey] of [['z', true, false, false], ['z', false, true, true], ['y', true, false, false]] as const) {
      expect(fireEvent.keyDown(source(), { key, ctrlKey, metaKey, shiftKey })).toBe(true);
    }
  });
});
