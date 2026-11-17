import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot, referencedResources, reviewName } from '../src/snapshot';

const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
const sidecar=(resources?:unknown)=>JSON.stringify({format:'lark-review',version:1,comments:[{author:'演示读者',body:'补充例子',anchor:{quote:'正文'},replies:[{author:'作者',body:'已补充'}]}],resources});
describe('read-only document snapshots',()=>{
 it('opts into generic XML without taking over configuration files',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  expect(manifest.contributes.customEditors.map((entry:any)=>[entry.selector,entry.priority])).toEqual([
   [[{filenamePattern:'*.feishu.xml'}],'default'],[[{filenamePattern:'*.xml'}],'option']]);
  expect(manifest.contributes.languages).toBeUndefined();
  expect(reviewName('文档.feishu.xml')).toBe('文档.feishu.review.json');
  expect(reviewName('legacy.XML')).toBe('legacy.review.json');
 });
 it.each(['<project><name>config</name></project>','<svg xmlns="http://www.w3.org/2000/svg"/>','<!DOCTYPE p [<!ENTITY x SYSTEM "file:///secret">]><p>&x;</p>','<p>'])('rejects non-document or malformed XML without reading resources: %s',async xml=>{
  const read=vi.fn();await expect(makeSnapshot(xml,undefined,read)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
 });
 it('reads only explicitly referenced local assets, retaining exact source and comments',async()=>{
  const xml='<title>阅读演示</title><p>正文</p><img path="@./assets/a.png"/><img token="fixture"/><img path="@../secret.png"/><img src="https://example.com/image.png"/>';
  const raw=sidecar({version:1,items:[{tag:'img',attribute:'token',value:'fixture',representation:'original',path:'assets/mapped.png'},{tag:'img',attribute:'token',value:'unused',representation:'original',path:'unused.png'}]});
  const read=vi.fn(async()=>png),result=await makeSnapshot(xml,raw,read);
  expect(read.mock.calls).toHaveLength(2);expect(Object.keys(result.assets)).toEqual(['assets/a.png','assets/mapped.png']);
  expect(result.xml).toBe(xml);expect(result.review.comments[0].replies[0].body).toBe('已补充');expect(result.warnings).toEqual([]);
  expect(result.assets['assets/a.png']).toMatch(/^data:image\/png;base64,/);
 });
 it('ignores dangerous and ambiguous resource paths',()=>{
  const xml='<p>正文</p>'+['../a.png','/a.png','https://example.com/a.png','file:///a.png','a\\b.png'].map(path=>`<img path="@${path}"/>`).join('');
  expect(referencedResources(xml,{comments:[]})).toEqual([]);
 });
 it('keeps readable text when comments or resources are corrupt or missing',async()=>{
  const read=vi.fn(async()=>new TextEncoder().encode('<html>not a PNG</html>'));
  const result=await makeSnapshot('<p>正文</p><img path="@a.png"/>','{broken',read);
  expect(result.xml).toContain('正文');expect(result.warnings).toHaveLength(2);expect(Object.keys(result.assets)).toEqual([]);
 });
 it('bounds bytes and keeps only supported UTF-8 text and SVG for sanitized rendering',async()=>{
  const result=await makeSnapshot('<p>正文</p><source path="@a.txt"/><whiteboard type="svg" path="@board.svg"/><source path="@large.txt"/>',undefined,async path=>new TextEncoder().encode(path==='large.txt'?'x'.repeat(2_000_001):path==='a.txt'?'公开附件':'<svg/>'));
  expect(result.texts).toEqual({'a.txt':'公开附件','board.svg':'<svg/>'});expect(result.warnings).toHaveLength(1);
 });
});
