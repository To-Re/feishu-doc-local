// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { parseDocxXML } from '../src/core/docxml';
import { contentNodes, exchangeXML } from '../src/core/content-xml';
import { xmlExtensions } from '../src/ui/xml-extensions';

const guide = readFileSync('docs/writing-protocol.md', 'utf8');
const minimum = readFileSync('examples/writing-minimal.xml', 'utf8');
const snippets = [...guide.matchAll(/```xml\n([\s\S]*?)\n```/g)].map(match => match[1]);

describe('public Agent writing protocol examples', () => {
  it('keeps every documented XML example locally parseable and exchangeable', () => {
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets).toContain(minimum.trimEnd());
    for (const xml of snippets) {
      const parsed = parseDocxXML(xml);
      expect(parsed.serialize(parsed.content)).toBe(xml);
      expect(contentNodes(exchangeXML(xml)).length).toBeGreaterThan(0);
    }
  });

  it('opens and edits the standalone minimum without protected fallback or losing structure', () => {
    const parsed = parseDocxXML(minimum);
    expect(parsed.warnings).toEqual([]);
    const editor = new Editor({
      element: document.createElement('div'), extensions: xmlExtensions(), content: parsed.content,
    });
    try {
      expect(parsed.serialize(editor.getJSON())).toBe(minimum);
      let position: number | undefined;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === '等待核对') position = pos;
      });
      expect(position).toBeDefined();
      editor.view.dispatch(editor.state.tr.insertText('已经核对', position!, position! + '等待核对'.length));
      const updated = parsed.serialize(editor.getJSON());
      expect(updated).toContain('<td><p>已经核对</p></td>');
      expect(updated).toContain('<colgroup><col width="180"/><col width="280"/></colgroup>');
      expect(updated).toContain('1 &lt; 2，A &amp; B。');
      expect(parseDocxXML(updated).warnings).toEqual([]);
    } finally { editor.destroy(); }
  });
});
