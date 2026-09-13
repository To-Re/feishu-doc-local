// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import compatibilityXML from '../examples/compatibility.xml?raw';
import { cloudCommentAnchor, indexCloudBlocks } from '../src/core/cloud-blocks';
import type { CloudComment } from '../src/core/cloud-types';
import { parseDocxXML } from '../src/core/docxml';
import { xmlExtensions } from '../src/ui/xml-extensions';

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

const comment: CloudComment = {
  id: 'native-component-comment', body: '请补充失败分支', author: '评审者',
  createdAt: '2026-09-12T00:00:00Z', status: 'open', quote: '原白板中的组件',
  blockId: 'board-block', boardToken: 'original-board', replies: [],
};

describe('cloud comment identity audit', () => {
  it('does not attach a cloud component comment to a different board referenced by the same local block ID', () => {
    const local = indexCloudBlocks('<title id="docA">测试</title><whiteboard id="board-block" token="replacement-board"/>');
    expect(cloudCommentAnchor(comment, local).state).toBe('unverified');
  });

  it('still attaches when both the exact Docx block and whiteboard identity agree', () => {
    const local = indexCloudBlocks('<title id="docA">测试</title><whiteboard id="board-block" token="original-board"/>');
    const board = local.find(block => block.id === 'board-block')!;
    expect(cloudCommentAnchor(comment, local)).toMatchObject({state: 'attached', from: board.from, to: board.to});
  });
});

describe('cloud block offsets against a real Tiptap editor', () => {
  it.each([
    ['UTF-16, inline atoms and following blocks', '<title id="docA">评审😀</title><p id="p1">A👨‍👩‍👧‍👦é<b>强调</b><br id="br1"/><latex id="math1">x^2</latex><source id="attachment1" name="附件.txt"/>尾文</p><whiteboard id="wb1" token="board-one"/><p id="after1">后续</p>'],
    ['table cells, merged cells and nested lists', '<title id="docA">测试</title><table id="table1"><tr id="row1"><th id="head1" colspan="2"><p id="hp">合并😀</p></th></tr><tr id="row2"><td id="cell1"><p id="cp1">A</p></td><td id="cell2"><ul id="list1"><li id="li1">B<ol id="list2"><li id="li2">C😀</li></ol></li></ul></td></tr></table><p id="after2">后续</p>'],
    ['columns, callouts, unknown protected blocks and boards', '<title id="docA">测试</title><grid id="grid1"><column id="col1" width-ratio="0.5"><p id="gp">左😀</p><whiteboard id="wb2" src="board-two"/></column><column id="col2" width-ratio="0.5"><callout id="callout1"><p id="callp">提醒</p></callout><future-block id="future1"><p id="not-editor-block">未知内容</p></future-block></column></grid><hr id="hr1"/><p id="after3">后续</p>'],
    ['public compatibility fixture', compatibilityXML],
  ])('%s uses the same block IDs, positions and atom sizes', (_name, xml) => {
    const element = document.createElement('div'); document.body.append(element);
    const editor = new Editor({element, extensions: xmlExtensions(), content: parseDocxXML(xml).content}); editors.push(editor);
    const actual: {id: string; tag: string; from: number; to: number; atom: boolean}[] = [];
    editor.state.doc.descendants((node, position) => {
      const id = node.attrs.lrAttrs?.id;
      if (typeof id === 'string' && id) actual.push({id, tag: node.attrs.lrTag, from: position, to: position + node.nodeSize, atom: node.isLeaf && !node.isText});
    });
    expect(indexCloudBlocks(xml).map(({id, tag, from, to, atom}) => ({id, tag, from, to, atom}))).toEqual(actual);
  });
});
