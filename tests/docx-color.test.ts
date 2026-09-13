// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { docxColor, type ColorRole } from '../src/ui/docx-color';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';

const roles: ColorRole[] = ['text', 'background', 'table', 'callout', 'border'];

describe('full fetch color literals', () => {
  it('accepts cloud numeric colors in every context and confirmed authored names', () => {
    for (const color of ['rgb(245,74,69)', 'rgba(186,206,253,0.7)', 'rgba(0, 0, 0, 1)', '#123456', '#abc']) {
      for (const role of roles) expect(docxColor(color, role)).toBe(color);
    }
    expect(docxColor('light-blue', 'background')).toBe('rgba(186,206,253,0.7)');
    expect(docxColor('light-blue', 'callout')).toBe('rgb(240,244,255)');
  });
  it('rejects out-of-range channels, malformed functions and injected declarations', () => {
    for (const color of ['rgb(256,0,0)', 'rgba(0,0,0,1.1)', 'rgb(0,0,0,.5)', 'rgba(0,0,0)', 'rgba(1,2,3,.7);position:fixed', 'url(https://example.com)', 'var(--unknown)', '__proto__', 'constructor']) {
      for (const role of roles) expect(docxColor(color, role), color).toBeUndefined();
    }
  });
  it('does not borrow an unverified color from a different context', () => {
    expect(docxColor('medium-yellow', 'callout')).toBe('rgb(255,255,204)');
    expect(docxColor('medium-yellow', 'table')).toBeUndefined();
    expect(docxColor('medium-yellow', 'background')).toBeUndefined();
    expect(docxColor('light-blue', 'text')).toBeUndefined();
    expect(docxColor('red', 'border')).toBeUndefined();
  });
});

// Public test content extracted from the SAME authored S03/S05/S07 fixture and
// its real full-fetch response on 2026-09-12. Cloud IDs and tokens are omitted.
// Keep both XML literals independent: deriving one through the color mapper
// would miss a wrong palette or a renderHTML caller using the wrong context.
const authored = `<p><span text-color="red">红</span><span text-color="orange">橙</span><span text-color="yellow">黄</span><span text-color="green">绿</span><span text-color="blue">蓝</span><span text-color="purple">紫</span><span text-color="gray">灰</span></p>
<p><span background-color="light-red">待修正</span><span background-color="light-orange">需注意</span><span background-color="light-yellow">待讨论</span><span background-color="light-green">已确认</span><span background-color="light-blue">参考信息</span><span background-color="light-purple">备选方案</span><span background-color="medium-gray">中性标签</span></p>
<p><span text-color="blue" background-color="light-blue"><b>颜色与粗体叠加</b></span></p>
<callout emoji="💡" background-color="light-blue" border-color="blue"><p>S05.C1 · 信息提示，默认文字颜色。</p></callout>
<callout emoji="✅" background-color="light-green" border-color="green"><p>S05.C2 · 完成提示。</p></callout>
<callout emoji="⚠️" background-color="medium-yellow" border-color="orange" text-color="red"><p>S05.C3 · 强提醒配色，仅用于测试颜色与对比度。</p></callout>
<table><tr><th background-color="light-gray"><p>项目</p></th><th background-color="medium-gray"><p>合并的两列表头</p></th></tr><tr><td background-color="light-green"><p>已确认</p></td><td background-color="light-yellow"><p>待讨论</p></td></tr></table>`;

const fetched = `<p><span text-color="rgb(216,57,49)">红</span><span text-color="rgb(222,120,2)">橙</span><span text-color="rgb(220,155,4)">黄</span><span text-color="rgb(46,161,33)">绿</span><span text-color="rgb(36,91,219)">蓝</span><span text-color="rgb(100,37,208)">紫</span><span text-color="rgb(143,149,158)">灰</span></p>
<p><span background-color="rgb(251,191,188)">待修正</span><span background-color="rgba(254,212,164,0.8)">需注意</span><span background-color="rgba(255,246,122,0.8)">待讨论</span><span background-color="rgba(183,237,177,0.8)">已确认</span><span background-color="rgba(186,206,253,0.7)">参考信息</span><span background-color="rgba(205,178,250,0.7)">备选方案</span><span background-color="rgba(222,224,227,0.8)">中性标签</span></p>
<p><span background-color="rgba(186,206,253,0.7)" text-color="rgb(36,91,219)"><b>颜色与粗体叠加</b></span></p>
<callout emoji="💡" background-color="rgb(240,244,255)" border-color="rgb(130,167,252)"><p>S05.C1 · 信息提示，默认文字颜色。</p></callout>
<callout emoji="✅" background-color="rgb(240,251,239)" border-color="rgb(142,224,133)"><p>S05.C2 · 完成提示。</p></callout>
<callout emoji="⚠️" background-color="rgb(255,255,204)" border-color="rgb(255,186,107)" text-color="rgb(216,57,49)"><p>S05.C3 · 强提醒配色，仅用于测试颜色与对比度。</p></callout>
<table><tr><th background-color="rgba(245,246,247,0.9)"><p>项目</p></th><th background-color="rgb(242,243,245)"><p>合并的两列表头</p></th></tr><tr><td background-color="rgb(240,251,239)"><p>已确认</p></td><td background-color="rgb(254,255,240)"><p>待讨论</p></td></tr></table>`;

it('renders the authored and real full-fetch colors identically, retaining each original XML through edits', () => {
  function render(xml: string) {
    const adapter = parseDocxXML(xml);
    const editor = new Editor({ element: document.createElement('div'), extensions: xmlExtensions(), content: adapter.content });
    document.body.append(editor.view.dom);
    try {
      const colors = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('span[data-xml-span], aside[data-xml-callout], th, td'), element => {
        const style = getComputedStyle(element);
        return { tag: element.tagName, text: element.textContent, color: style.color, background: style.backgroundColor, border: style.borderLeftColor };
      });
      expect(adapter.serialize(editor.getJSON())).toBe(xml);
      editor.commands.insertContentAt(1, '编辑');
      expect(adapter.serialize(editor.getJSON())).toContain('编辑');
      editor.commands.undo();
      expect(adapter.serialize(editor.getJSON())).toBe(xml);
      return colors;
    } finally { editor.view.dom.remove(); editor.destroy(); }
  }
  const sourceColors = render(authored);
  const returnedColors = render(fetched);
  expect(sourceColors).toHaveLength(22);
  expect(sourceColors).toEqual(returnedColors);
  expect(sourceColors.find(item => item.text === '参考信息')?.background).toBe('rgba(186, 206, 253, 0.7)');
  expect(sourceColors.find(item => item.tag === 'ASIDE')?.background).toBe('rgb(240, 244, 255)');
  expect(sourceColors.find(item => item.tag === 'TH')?.background).toBe('rgba(245, 246, 247, 0.9)');
});
