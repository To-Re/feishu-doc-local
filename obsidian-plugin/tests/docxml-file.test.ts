import { describe, expect, it, vi } from 'vitest';
import type { TFile, Vault } from 'obsidian';
import { parseDocxXML } from '../../src/core/docxml';
import { assertDocxXML, assertDocxXMLFile } from '../src/docxml-file';

describe('explicit DocxXML file recognition',()=>{
  it.each([
    '<title>公开样稿</title><p>正文</p>',
    '<p>无标题的已有正文</p>',
    '<p/>',
    '\ufeff<!-- local article -->\r\n<h9>深层标题</h9>',
    '<whiteboard type="svg"><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg></whiteboard>',
    '<whiteboard type="mermaid"><![CDATA[flowchart LR; A-->B]]></whiteboard>',
    '<sheet token="SAMPLE_SHEET"/>',
    '<title>原样保留</title><future-block custom="x"><data>未知扩展</data></future-block>',
  ])('accepts supported document fragments without changing their bytes: %s',xml=>{
    expect(()=>assertDocxXML(xml)).not.toThrow();const parsed=parseDocxXML(xml);expect(parsed.serialize(parsed.content)).toBe(xml);
  });
  it.each([
    '<project><name>Config</name><p>嵌套段落不是文档标记</p></project>',
    '<root><title>配置的 title</title><p>值</p></root>',
    '<html><head><title>网页</title></head><body><p>段落</p></body></html>',
    '<body><p>HTML 正文</p></body>',
    '<document><p>自创包装</p></document>',
    '<svg xmlns="http://www.w3.org/2000/svg"><title>图片标题</title></svg>',
    '<p xmlns="urn:unrelated">另一个协议</p>',
    '<x:p xmlns:x="urn:unrelated">另一个协议</x:p>',
    '<configuration><![CDATA[<p>伪标签</p>]]></configuration>',
    '<!-- <title>仅注释</title> --><root/>',
    '',
    '<p>',
    '<!DOCTYPE p [<!ENTITY payload SYSTEM "file:///not-read">]><p>&payload;</p>',
  ])('rejects configuration, XML wrappers, malformed XML and markup-shaped text: %s',xml=>{
    expect(()=>assertDocxXML(xml)).toThrow();
  });
  it('reads only the selected XML and rejects changes while reading, private configuration and oversize input',async()=>{
    const file={path:'articles/sample.xml',extension:'xml',stat:{size:20,mtime:1}} as TFile;
    const read=vi.fn(async()=>'<p>公开样稿</p>');
    const vault={configDir:'.obsidian',getFileByPath:()=>file,read} as unknown as Vault;
    await assertDocxXMLFile(vault,file);expect(read).toHaveBeenCalledExactlyOnceWith(file);
    read.mockImplementationOnce(async()=>{file.stat.mtime=2;return '<p>外部修改</p>';});
    await expect(assertDocxXMLFile(vault,file)).rejects.toThrow('已变化');
    read.mockClear();
    await expect(assertDocxXMLFile(vault,{...file,path:'.obsidian/settings.xml'} as TFile)).rejects.toThrow('配置文件');
    file.stat.size=5_000_001;
    await expect(assertDocxXMLFile(vault,file)).rejects.toThrow('5 MB');expect(read).not.toHaveBeenCalled();
  });
});
