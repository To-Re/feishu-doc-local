import {describe,expect,it} from 'vitest';
import {comparableXML,contentNodes,exchangeXML,planContentWrites} from '../src/core/content-xml';
import {remapContentComments} from '../src/server/content-sync';
import type {ReviewComment} from '../src/core/types';
import {indexCloudBlocks} from '../src/core/cloud-blocks';
import {isContentSyncState} from '../src/core/content-state';

const comment=(from:number,to:number):ReviewComment=>({id:'c',author:'我',body:'意见',createdAt:'2026-09-12T00:00:00Z',status:'open',anchor:{from,to,quote:'正文',state:'attached'},replies:[]});
describe('lossless content exchange and write planning',()=>{
  it('preserves comments and processing instructions in order, including PI-like text in a PI body',()=>{
    const xml='<!-- before --><?test    body<?test nested?><p id="B">A<!-- middle --><?inner data?><![CDATA[<text>]]>Z</p><?after end?>';
    const exchanged=exchangeXML(xml);
    expect(exchanged).toBe('<!-- before --><?test    body<?test nested?><p>A<!-- middle --><?inner data?>&lt;text&gt;Z</p><?after end?>');
    expect(comparableXML(xml)).toBe(comparableXML(exchanged));
    expect(comparableXML(xml)).not.toBe(comparableXML(xml.replace('middle','changed')));
    expect(contentNodes(xml).map(n=>n.raw)).toEqual(['<!-- before -->','<?test    body<?test nested?>','<p id="B">A<!-- middle --><?inner data?><![CDATA[<text>]]>Z</p>','<?after end?>']);
  });
  it('retains IDs inside drawings while removing only document/comment identities',()=>{
    const result=exchangeXML('<whiteboard id="B" comment-refs="C"><svg id="root"><path id="edge" data-custom="kept"/></svg></whiteboard><p id="P" data-x="&quot;">内容</p>');
    expect(result).toContain('<whiteboard><svg id="root"><path id="edge" data-custom="kept"></path></svg></whiteboard>');
    expect(result).toContain('<p data-x="&quot;">内容</p>');
  });
  it('keeps an unchanged official title and root metadata out of block replacement',()=>{
    const cloud='<title>标题</title><!-- memo --><p id="P">旧文</p>';
    expect(planContentWrites(cloud.replace('旧文','新文'),cloud).writes).toEqual([{command:'block_replace',blockId:'P',xml:'<p>新文</p>'}]);
    expect(planContentWrites(cloud.replace('标题','新标题'),cloud).writes[0].command).toBe('overwrite');
    expect(planContentWrites(cloud+'<p>追加</p>',cloud).writes).toEqual([{command:'append',xml:'<p>追加</p>'}]);
    expect(planContentWrites(cloud+'<title>第二个标题</title>',cloud).writes[0].command).toBe('overwrite');
  });
  it('never uses drawing IDs as Docx block IDs or targets duplicate IDs',()=>{
    const board='<whiteboard><svg id="svg"><text id="shape">旧</text></svg></whiteboard>';
    expect(planContentWrites(board.replace('旧','新'),board).writes[0].command).toBe('overwrite');
    const duplicate='<p id="P">一</p><p id="P">二</p>';
    expect(planContentWrites(duplicate.replace('二','三'),duplicate).writes[0].command).toBe('overwrite');
  });
  it('rejects malformed or entity-declaring XML before planning any write',()=>{
    for(const xml of ['<p>broken','outside<p/>','<!DOCTYPE p [<!ENTITY x "y">]><p>&x;</p>'])expect(()=>exchangeXML(xml)).toThrow();
  });
});

describe('conservative comment remapping across cloud content adoption',()=>{
  it('moves offsets only for a unique, unchanged block identity',()=>{
    const before='<p id="A">前</p><p id="B">正文</p>',after=before.replace('前','前方变长');
    const b=indexCloudBlocks(before).find(b=>b.id==='B')!,c=comment(b.from+1,b.to-1);
    const next=remapContentComments(before,after,[c])[0];
    expect(next.anchor).toMatchObject({state:'attached',from:c.anchor.from+3,to:c.anchor.to+3});
    expect(remapContentComments(before,after.replace('正文','另文'),[c])[0].anchor.state).toBe('unverified');
  });
  it('rejects duplicate identities even if the last duplicate signature matches the new block',()=>{
    const before='<p id="B">旧</p><p id="B">正文</p>',b=indexCloudBlocks(before)[1];
    expect(remapContentComments(before,'<p id="B">正文</p>',[comment(b.from+1,b.to-1)])[0].anchor.state).toBe('unverified');
  });
  it('does not reattach a component whose stored board identity does not match the block',()=>{
    const xml='<whiteboard id="B" token="newBoard"/>',c=comment(0,1);
    c.anchor.target={kind:'whiteboard-component',board:'token:oldBoard',id:'shape'};
    expect(remapContentComments(xml,xml,[c])[0].anchor.state).toBe('unverified');
  });
});

describe('content asset baseline schema',()=>{
  const state={version:1,documentId:'Doc',localXML:'<p/>',cloudXML:'<p/>',cloudRevision:1,syncedAt:'2026-09-12T00:00:00Z'};
  it('accepts legacy snapshots and exact safe relative paths with SHA-256 hashes',()=>{
    expect(isContentSyncState(state)).toBe(true);
    expect(isContentSyncState({...state,localAssets:{'assets/a.png':'a'.repeat(64)}})).toBe(true);
    expect(isContentSyncState({...state,localAssets:{}})).toBe(true);
  });
  it('rejects unsafe or noncanonical paths, malformed hashes and non-map payloads',()=>{
    for(const localAssets of [null,[],{'../a.png':'a'.repeat(64)},{'/a.png':'a'.repeat(64)},{'./a.png':'a'.repeat(64)},{'a//b.png':'a'.repeat(64)},{'a.png':'not-a-hash'},{'a.png':23}])
      expect(isContentSyncState({...state,localAssets})).toBe(false);
  });
});
