// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';

it('preserves the complete compatibility fixture, renders supported structures, and saves edits inside columns', () => {
  const source = readFileSync(resolve('examples/compatibility.xml'), 'utf8');
  const adapter = parseDocxXML(source);
  const editor = new Editor({
    element: document.createElement('div'), extensions: xmlExtensions(path => '/fixture-assets/' + path), content: adapter.content,
  });
  try {
    expect(source.match(/<title(?:\s|>)/g)).toHaveLength(1);
    expect(source).not.toMatch(/(?:token|user-id|doc-id|sheet-id|cycle-id)="/);
    expect(source).not.toMatch(/src="(?!https:\/\/)/);
    expect(existsSync(resolve('examples/assets/colors.png'))).toBe(true);
    expect(adapter.serialize(editor.getJSON())).toBe(source);

    expect(editor.view.dom.querySelectorAll('.lr-grid')).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll('.katex')).toHaveLength(4);
    expect(editor.view.dom.querySelector('.lr-latex-error')).toBeNull();
    expect(editor.view.dom.querySelector('.lr-code-caption')?.textContent).toBe('S06.G · Go 代码标题');
    const image = editor.view.dom.querySelector('img[src^="/fixture-assets/"]');
    expect(image?.getAttribute('width')).toBe('360');
    expect(image?.getAttribute('height')).toBe('90');
    const columns = editor.view.dom.querySelector('table')!.querySelectorAll('col');
    expect(Array.from(columns).map(column => column.style.width)).toEqual(['320px', '160px', '240px']);

    function replaceText(before: string, after: string) {
      let from = 0;
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text?.includes(before)) from = position + node.text.indexOf(before);
      });
      expect(from).toBeGreaterThan(0);
      editor.view.dispatch(editor.state.tr.insertText(after, from, from + before.length));
    }
    replaceText('等待核对', '完成核对');
    expect(adapter.serialize(editor.getJSON())).toBe(source.replace('等待核对', '完成核对'));
    const before = '左栏的正文可以直接修改，也应能选文评论。';
    replaceText(before, '左栏正文已经修改。');
    expect(adapter.serialize(editor.getJSON())).toBe(source.replace('等待核对', '完成核对').replace(before, '左栏正文已经修改。'));
  } finally { editor.destroy(); }
});
