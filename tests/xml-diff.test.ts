import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildXMLDiff, type XMLDiff } from '../src/core/xml-diff';

function restores(result: XMLDiff, before: string, after: string) {
  expect(result.rows.map(row => row.before?.text || '').join('')).toBe(before);
  expect(result.rows.map(row => row.after?.text || '').join('')).toBe(after);
  for (const side of ['before', 'after'] as const) {
    let number = 0;
    for (const row of result.rows) if (row[side]) {
      expect(row[side]!.number).toBe(++number);
      expect(row[side]!.parts.map(part => part.text).join('')).toBe(row[side]!.text);
    }
  }
}
afterEach(() => vi.restoreAllMocks());

describe('bounded raw XML block diff', () => {
  it('highlights a single Chinese character inside an otherwise unchanged paragraph', () => {
    const before = '<p id="first">计划明天发布</p>', after = '<p id="first">计划今天发布</p>';
    const result = buildXMLDiff(before, after);
    expect(result.identical).toBe(false); expect(result.limited).toBe(false);
    expect(result.added).toBe(1); expect(result.removed).toBe(1);
    expect(result.rows[0].before!.parts.filter(part => part.changed).map(part => part.text).join('')).toBe('明');
    expect(result.rows[0].after!.parts.filter(part => part.changed).map(part => part.text).join('')).toBe('今');
    restores(result, before, after);
  });

  it('separates concatenated official paragraphs and keeps unchanged blocks aligned', () => {
    const before = '<title>标题</title><p id="a">甲</p><p id="b">乙</p>', after = '<title>标题</title><p id="a">甲</p><p id="b">丙</p><p>新增</p>';
    const result = buildXMLDiff(before, after);
    expect(result.rows.map(row => row.kind)).toEqual(['equal', 'equal', 'change', 'change']);
    expect(result.rows[3].before).toBeUndefined();
    expect(result.added).toBe(2); expect(result.removed).toBe(1);
    restores(result, before, after);
  });

  it('shows a table by row with its wrappers preserved', () => {
    const row1 = '<tr><td><p>A</p></td><td>B</td></tr>';
    const before = '<table id="t"><tbody>' + row1 + '<tr><td>C</td><td>D</td></tr></tbody></table>';
    const after = before.replace('>D<', '>E<');
    const result = buildXMLDiff(before, after);
    expect(result.rows.map(row => row.before?.text)).toEqual(['<table id="t">', '<tbody>', row1, '<tr><td>C</td><td>D</td></tr>', '</tbody>', '</table>']);
    expect(result.rows.filter(row => row.kind === 'change')).toHaveLength(1);
    restores(result, before, after);
  });

  it('pairs adjacent removed and added blocks in order and leaves the extra side blank', () => {
    const before = '<p>A</p><p>B</p><p>保留</p>', after = '<p>C</p><p>保留</p>';
    const result = buildXMLDiff(before, after);
    expect(result.rows.map(row => [row.before?.text, row.after?.text])).toEqual([
      ['<p>A</p>', '<p>C</p>'], ['<p>B</p>', undefined], ['<p>保留</p>', '<p>保留</p>'],
    ]);
    restores(result, before, after);
  });

  it('does not split quoted angle brackets, comments, CDATA or unknown mixed content', () => {
    const before = '\ufeff<!-- <p>不是标签</p>\n保留 -->\r\n<future title="a > b"><![CDATA[a < b && c > d\n<p>原样</p>]]><x mode="raw"/></future><p z="2" a="1">A &amp; B &#62;</p>';
    const after = before.replace('A &amp;', 'C &amp;');
    const result = buildXMLDiff(before, after);
    expect(result.limited).toBe(false);
    expect(result.rows.some(row => row.before?.text.startsWith('<future') && row.before.text.endsWith('</future>'))).toBe(true);
    expect(result.rows.some(row => row.before?.text.includes('<!-- <p>不是标签</p>\n保留 -->'))).toBe(true);
    restores(result, before, after);
  });

  it('keeps nested unknown structures and every inter-block whitespace slice', () => {
    const before = '<future>\n <child><p>甲</p></child>\n</future>  <p>尾</p>\n';
    const after = before.replace('甲', '乙');
    const result = buildXMLDiff(before, after);
    expect(result.rows.map(row => row.before?.text)).toContain('<child>');
    expect(result.rows.map(row => row.before?.text)).toContain('\n ');
    restores(result, before, after);
  });

  it('reports newline, indentation, attribute-order and ID changes rather than semantic equality', () => {
    for (const [before, after] of [
      ['<p>A</p>\r\n<p>B</p>', '<p>A</p>\n<p>B</p>'],
      ['<p>A</p>  <p>B</p>', '<p>A</p> <p>B</p>'],
      ['<p id="a" align="left">A</p>', '<p align="left" id="a">A</p>'],
      ['<p id="a">A</p>', '<p id="b">A</p>'],
    ]) {
      const result = buildXMLDiff(before, after);
      expect(result.identical).toBe(false); expect(result.added + result.removed).toBeGreaterThan(0);
      restores(result, before, after);
    }
  });

  it.each([['', '<p>新增</p>'], ['<p>删除</p>', ''], ['', '\r\n  ']])('preserves a pure insertion or deletion: %j to %j', (before, after) => {
    const result = buildXMLDiff(before, after);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].before === undefined).toBe(before === '');
    expect(result.rows[0].after === undefined).toBe(after === '');
    restores(result, before, after);
  });

  it('keeps emoji code points intact in inline changes', () => {
    const before = '<p>测试🙂完成</p>', after = '<p>测试🙃完成</p>';
    const result = buildXMLDiff(before, after);
    expect(result.rows[0].before!.parts.filter(part => part.changed).map(part => part.text)).toEqual(['🙂']);
    expect(result.rows[0].after!.parts.filter(part => part.changed).map(part => part.text)).toEqual(['🙃']);
    restores(result, before, after);
  });

  it('exits on exactly identical strings before parsing, including empty or oversized content', () => {
    for (const text of ['', 'not even XML <', 'x'.repeat(1_000_001)])
      expect(buildXMLDiff(text, text)).toEqual({ rows: [], added: 0, removed: 0, identical: true, limited: false });
  });

  it('uses whole-block highlights with an explicit notice for a long changed block', () => {
    const before = '<p>' + '甲'.repeat(5_000) + '</p>', after = before.replace('甲', '乙');
    const result = buildXMLDiff(before, after);
    expect(result.limited).toBe(true); expect(result.notice).toContain('整行');
    expect(result.rows[0].before!.parts).toEqual([{ text: before, changed: true }]);
    restores(result, before, after);
  });

  it('returns an explicit unavailable result for oversized inputs or too many block rows', () => {
    for (const before of ['<p>' + '甲'.repeat(1_000_001) + '</p>', '<p>A</p>'.repeat(8_001)]) {
      const result = buildXMLDiff(before, '<p>B</p>');
      expect(result.rows).toEqual([]); expect(result.limited).toBe(true); expect(result.identical).toBe(false);
      expect(result.notice).toContain('展开「查看完整原文」');
    }
  });

  it('does not call an exhausted time budget an identical result', () => {
    let time = 0; vi.spyOn(Date, 'now').mockImplementation(() => (time += 200));
    const result = buildXMLDiff('<p>A</p>', '<p>B</p>');
    expect(result.identical).toBe(false); expect(result.limited).toBe(true); expect(result.rows).toEqual([]);
    expect(result.notice).toContain('时间预算');
  });

  it('does not return a partial diff when the real line algorithm exhausts its edit budget', () => {
    const before = Array.from({ length: 1_100 }, (_, index) => '<p>旧' + index + '</p>').join('');
    const after = Array.from({ length: 1_100 }, (_, index) => '<p>新' + index + '</p>').join('');
    const result = buildXMLDiff(before, after);
    expect(result.limited).toBe(true); expect(result.identical).toBe(false); expect(result.rows).toEqual([]);
    expect(result.notice).toContain('预算');
  });

  it('keeps both complete rows if the real character algorithm exhausts its edit budget', () => {
    const before = '<p>' + '甲'.repeat(1_000) + '</p>', after = '<p>' + '乙'.repeat(1_000) + '</p>';
    const result = buildXMLDiff(before, after);
    expect(result.limited).toBe(true); expect(result.identical).toBe(false);
    expect(result.rows[0].before!.parts).toEqual([{ text: before, changed: true }]);
    expect(result.rows[0].after!.parts).toEqual([{ text: after, changed: true }]);
    restores(result, before, after);
  });

  it('does not repair malformed XML in order to produce an apparently complete comparison', () => {
    const result = buildXMLDiff('<p>未闭合', '<p>完整</p>');
    expect(result.limited).toBe(true); expect(result.rows).toEqual([]); expect(result.identical).toBe(false);
    expect(result.notice).toContain('无法安全');
  });

  it('restores the exact before and after strings over block insertion, deletion and replacement combinations', () => {
    const blocks = ['<p id="a">中文🙂 &amp; raw</p>', '\r\n  ', '<!-- <tag> -->', '<p title="a > b"><i>B</i></p>', '<future><![CDATA[x < y]]></future>'];
    for (let index = 0; index < blocks.length; index++) {
      const before = blocks.join('');
      for (const replacement of ['', '<p>替换🙃</p>', '\n']) {
        const after = blocks.map((block, position) => position === index ? replacement : block).join('');
        const result = buildXMLDiff(before, after);
        expect(result.limited).toBe(false);
        restores(result, before, after);
      }
    }
  });
});
