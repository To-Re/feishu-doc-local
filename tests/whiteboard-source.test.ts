import { describe, expect, it } from 'vitest';
import { readWhiteboardSource, replaceWhiteboardSource } from '../src/core/whiteboard-source';

describe('inline whiteboard source edits', () => {
  it('preserves original attributes, quoting and source whitespace and safely splits CDATA terminators', () => {
    const source = '\nflowchart LR\n A[原稿] --> B[评论]\n';
    const opening = "<whiteboard data-unknown='keep > here' type='mermaid' width='720' caption='评审图'>";
    const xml = opening + '<![CDATA[' + source + ']]></whiteboard>';
    expect(readWhiteboardSource(xml)?.source).toBe(source);
    expect(replaceWhiteboardSource(xml, source)).toBe(xml);
    const next = 'flowchart LR\n A["中文😀 & < > ]]> 内容"] --> B[调整]';
    const edited = replaceWhiteboardSource(xml, next);
    expect(edited.startsWith(opening)).toBe(true);
    expect(edited.endsWith('</whiteboard>')).toBe(true);
    expect(edited).toContain(']]]]><![CDATA[>');
    expect(readWhiteboardSource(edited)?.source).toBe(next);
  });

  it('reads a complete nested SVG source and changes it without rebuilding the whiteboard tag', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><!-- 图源注释 --><g><text>中文 &amp; 文字</text></g></svg>';
    const xml = '<whiteboard type="SVG" custom="保留">\n' + svg + '\n</whiteboard>';
    expect(readWhiteboardSource(xml)?.source).toBe(svg);
    const next = svg.replace('中文', '已改');
    const edited = replaceWhiteboardSource(xml, next);
    expect(edited).toBe('<whiteboard type="SVG" custom="保留">' + next + '</whiteboard>');
    expect(readWhiteboardSource(edited)?.source).toBe(next);
    expect(replaceWhiteboardSource(xml, svg)).toBe(xml);
  });

  it('keeps cloud references, empty boards and unknown or mixed structures protected', () => {
    for (const xml of [
      '<whiteboard token="cloud"/>', '<whiteboard type="blank"/>', '<whiteboard type="mermaid"/>',
      '<whiteboard type="mermaid" src="cloud">flowchart LR\nA-->B</whiteboard>',
      '<whiteboard type="svg" path="@./board.svg"/>',
      '<whiteboard type="mermaid" token="">flowchart LR\nA-->B</whiteboard>',
      '<whiteboard type="mermaid"><custom>flowchart LR</custom></whiteboard>',
      '<whiteboard type="mermaid">flowchart LR<!-- 保留未知注释 -->A-->B</whiteboard>',
      '<whiteboard type="svg">before<svg/></whiteboard>',
      '<whiteboard type="svg"><svg/><extra/></whiteboard>',
      '<whiteboard type="other">source</whiteboard>',
      '<!DOCTYPE whiteboard><whiteboard type="mermaid">flowchart LR</whiteboard>',
      '<whiteboard type="mermaid">broken',
    ]) {
      expect(readWhiteboardSource(xml), xml).toBeNull();
      expect(() => replaceWhiteboardSource(xml, 'new source')).toThrow('没有可编辑');
    }
  });

  it('rejects empty or malformed changes before the document can be serialized', () => {
    const svg = '<whiteboard type="svg"><svg/></whiteboard>';
    for (const source of ['', '<div/>', '<svg><g></svg>', '<svg/><svg/>', '<!DOCTYPE svg><svg/>']) {
      expect(() => replaceWhiteboardSource(svg, source)).toThrow();
    }
    expect(() => replaceWhiteboardSource(svg, '<svg>' + '<g>'.repeat(256) + '</g>'.repeat(256) + '</svg>')).toThrow('嵌套');
    const mermaid = '<whiteboard type="mermaid">flowchart LR\nA-->B</whiteboard>';
    expect(() => replaceWhiteboardSource(mermaid, 'x'.repeat(50_001))).toThrow('长度限制');
    expect(() => replaceWhiteboardSource(mermaid, 'flowchart LR\nA[\u0000]-->B')).toThrow('无效的 XML');
  });
});
