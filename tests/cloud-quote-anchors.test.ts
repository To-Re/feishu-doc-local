// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { cloudCommentAnchor, indexCloudBlocks, normalizeImportedCloudAnchors } from '../src/core/cloud-blocks';
import type { CloudComment } from '../src/core/cloud-types';
import { parseDocxXML } from '../src/core/docxml';
import { createReview, type Review } from '../src/core/types';
import { xmlExtensions } from '../src/ui/xml-extensions';

const editors:Editor[]=[];
afterEach(()=>{for(const editor of editors.splice(0))editor.destroy();document.body.replaceChildren();});
const native=(quote:string,blockId='paragraph',extra:Partial<CloudComment>={}):CloudComment=>({
  id:'remote-comment',body:'请核对这里',author:'评审者',createdAt:'2026-09-14T00:00:00Z',
  status:'open',quote,blockId,replies:[],...extra,
});
function editorFor(xml:string){
  const element=document.createElement('div');document.body.append(element);
  const editor=new Editor({element,extensions:xmlExtensions(),content:parseDocxXML(xml).content});
  editors.push(editor);return editor;
}
function storedImport(xml:string,cloud:CloudComment):Review {
  const review=createReview('sample.xml',xml),id=`cloud:document:${cloud.id}`;
  const block=indexCloudBlocks(xml).find(block=>block.id===cloud.blockId)!;
  review.comments.push({id,author:cloud.author,body:cloud.body,createdAt:cloud.createdAt,status:cloud.status,
    anchor:{from:block.from+1,to:block.to-1,quote:cloud.quote||'【飞书评论】',state:'attached'},
    replies:[{id:'local-reply',author:'作者',body:'保留回复',createdAt:cloud.createdAt}]});
  review.cloudSync={version:1,documentId:'document',url:'https://example.feishu.cn/docx/document',
    links:[{localId:id,cloudId:cloud.id,body:cloud.body,cloudBody:cloud.body,status:cloud.status,replies:{},remote:cloud}]};
  return review;
}

describe('precise imported cloud quote positions',()=>{
  it.each(['paragraph','callout'])('locates a formatted quote inside a nested callout scoped by %s',blockId=>{
    const xml='<title id="document">样例</title><callout id="callout"><p id="paragraph">提示。方<b>法：用</b>每节内容检查覆盖范围。</p><p id="other">另一段</p></callout>';
    const anchor=cloudCommentAnchor(native('方法：用每节',blockId),indexCloudBlocks(xml));
    const editor=editorFor(xml);let actualFrom=-1;
    editor.state.doc.descendants((node,position)=>{if(node.isText&&node.text==='提示。方')actualFrom=position+3;});
    expect(anchor).toEqual({from:actualFrom,to:actualFrom+6,quote:'方法：用每节',state:'attached'});
    expect(editor.state.doc.textBetween(anchor.from,anchor.to)).toBe('方法：用每节');
  });

  it('preserves UTF-16 positions through emoji, combining marks, entities and formatting',()=>{
    const xml='<title id="document">😀标题</title><p id="paragraph">前😀é&amp;<b>👨‍👩‍👧‍👦</b>后文。</p>';
    const quote='é&👨‍👩‍👧‍👦后';
    const anchor=cloudCommentAnchor(native(quote),indexCloudBlocks(xml));
    const editor=editorFor(xml);let start=-1;
    editor.state.doc.descendants((node,position)=>{if(node.isText&&node.text!.startsWith('前😀'))start=position+'前😀'.length;});
    expect(anchor).toMatchObject({from:start,to:start+quote.length,state:'attached'});
    expect(editor.state.doc.textBetween(anchor.from,anchor.to)).toBe(quote);
  });

  it('matches explicit line breaks without treating an opaque atom as selected text',()=>{
    const xml='<p id="paragraph">第一行<br/>第二行<latex>x</latex>末尾</p>';
    const anchor=cloudCommentAnchor(native('行\n第二'),indexCloudBlocks(xml));
    expect(anchor).toEqual({from:3,to:7,quote:'行\n第二',state:'attached'});
    expect(cloudCommentAnchor(native('第二行末尾'),indexCloudBlocks(xml)).state).toBe('unverified');
  });

  it('uses the proven block scope when another block contains the same quote',()=>{
    const xml='<p id="other">精确文本</p><p id="paragraph">在这里的精确文本后方</p>';
    const blocks=indexCloudBlocks(xml),block=blocks.find(block=>block.id==='paragraph')!;
    expect(cloudCommentAnchor(native('精确文本'),blocks)).toMatchObject({from:block.from+5,to:block.from+9,state:'attached'});
    expect(cloudCommentAnchor(native('精确文本','paragraph',{blockId:undefined}),blocks).state).toBe('unverified');
  });

  it.each([
    ['overlapping quote','<p id="paragraph">aaaa</p>','aa'],
    ['repeat separated by formatting','<p id="paragraph">引用<b>引用</b></p>','引用'],
    ['repeat across nested paragraphs','<callout id="paragraph"><p>引用</p><p>引用</p></callout>','引用'],
    ['partial remote quote','<p id="paragraph">完整引用</p>','完整引用以及缺失文本'],
    ['truncated remote quote','<p id="paragraph">完整引用后半句</p>','完整引用…'],
    ['missing quote','<p id="paragraph">完整引用</p>',''],
    ['blank quote','<p id="paragraph">完整 引用</p>',' '],
    ['duplicate block identity','<p id="paragraph">引用</p><p id="paragraph">其他文字</p>','引用'],
    ['quote spanning a structural gap','<callout id="paragraph"><p>完整</p><p>引用</p></callout>','完整引用'],
  ])('leaves %s unverified',(_name,xml,quote)=>{
    expect(cloudCommentAnchor(native(quote),indexCloudBlocks(xml))).toMatchObject({from:0,to:0,state:'unverified'});
  });

  it('keeps whole comments and referenced atoms independent of text matching',()=>{
    const blocks=indexCloudBlocks('<title id="document">文档标题</title><whiteboard id="board" token="board-token"/>');
    expect(cloudCommentAnchor(native('', 'document',{whole:true}),blocks)).toEqual({from:1,to:5,quote:'【全文评论】',state:'attached'});
    const board=blocks.find(block=>block.id==='board')!;
    expect(cloudCommentAnchor(native('组件标签','board',{boardToken:'board-token'}),blocks))
      .toEqual({from:board.from,to:board.to,quote:'【白板】组件标签',state:'attached'});
  });
});

describe('legacy imported cloud quote normalization',()=>{
  const xml='<title id="document">样例</title><callout id="callout"><p id="paragraph">使用方法：用每节内容检查覆盖范围。</p></callout><h2 id="heading">检查标题层级与字号关系</h2>';
  it.each([
    ['open','方法：用每节','paragraph'],
    ['resolved','题层级与','heading'],
  ] as const)('repairs a saved %s import without losing its data', (status,quote,blockId)=>{
    const review=storedImport(xml,native(quote,blockId,{status,raw:{relation:{preserved:'opaque metadata'}}}));
    const before=structuredClone(review),normalized=normalizeImportedCloudAnchors(review,xml);
    expect(normalized.comments[0].anchor).toEqual(cloudCommentAnchor(review.cloudSync!.links[0].remote,indexCloudBlocks(xml)));
    expect(editorFor(xml).state.doc.textBetween(normalized.comments[0].anchor.from,normalized.comments[0].anchor.to)).toBe(quote);
    expect(normalized.comments[0].status).toBe(status);
    expect({...normalized,comments:normalized.comments.map((c,i)=>({...c,anchor:before.comments[i].anchor}))}).toEqual(before);
    expect(review).toEqual(before);
    expect(normalizeImportedCloudAnchors(normalized,xml)).toBe(normalized);
  });

  it.each(['重复','不存在',''])('retains ambiguous or missing quote data as unverified (%s)',quote=>{
    const repeated='<p id="paragraph">重复与重复</p>',review=storedImport(repeated,native(quote));
    const normalized=normalizeImportedCloudAnchors(review,repeated);
    expect(normalized.comments[0].anchor).toEqual({...review.comments[0].anchor,state:'unverified'});
    expect(normalized.cloudSync).toBe(review.cloudSync);
    expect(normalized.comments[0].replies).toBe(review.comments[0].replies);
  });

  it.each(['deleted','unverified'] as const)('does not reattach an already %s imported comment',state=>{
    const review=storedImport(xml,native('方法：用每节'));
    review.comments[0].anchor.state=state;
    expect(normalizeImportedCloudAnchors(review,xml)).toBe(review);
  });

  it('does not reassign a local selection, changed quote or mapped range',()=>{
    const original=storedImport(xml,native('方法：用每节'));
    for(const change of [
      (review:Review)=>{review.comments[0].id='local-comment';review.cloudSync!.links[0].localId='local-comment';},
      (review:Review)=>{review.comments[0].anchor.quote='本地选区';},
      (review:Review)=>{review.comments[0].anchor.from+=1;},
      (review:Review)=>{review.cloudSync!.links[0].remote.whole=true;},
    ]){
      const review=structuredClone(original);change(review);
      expect(normalizeImportedCloudAnchors(review,xml)).toBe(review);
    }
    expect(normalizeImportedCloudAnchors(original,xml+'<p>外部修改</p>')).toBe(original);
  });
});
