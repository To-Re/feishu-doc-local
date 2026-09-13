import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adoptPublishedCommentIdentity, validateUnchangedLocalComments, type PublishedIdentityContext } from '../src/core/content-identity';
import type { ReviewComment } from '../src/core/types';

const context: PublishedIdentityContext = { kind: 'create', expectedDocumentId: 'Doc-new', documentId: 'Doc-new' };
const comment = (from: number, to: number, id = 'comment'): ReviewComment => ({ id, author: '我', body: '修改意见', createdAt: '2026-09-13T00:00:00Z', status: 'open',
  anchor: { from, to, quote: '原始引用保留', state: 'attached' }, replies: [{ id: 'reply', author: '我', body: '保留回复', createdAt: '2026-09-13T00:00:00Z' }] });
const target = (board: string) => ({ kind: 'whiteboard-component' as const, board, id: 'shape-1', label: '原节点' });

describe('validated identity adoption after the first publication', () => {
  it('preserves an unchanged local comment without inventing a block ID', () => {
    const xml = '<p>本地正文🙂</p>', original = comment(1, 5);
    expect(validateUnchangedLocalComments(xml, [original])).toEqual([original]);
    expect(xml).toBe('<p>本地正文🙂</p>');
    const migrated = adoptPublishedCommentIdentity(xml, '<p id="cloud-p">本地正文🙂</p>', [original], context);
    expect(migrated).toEqual({ comments: [original], equivalent: true, migrated: 1, unverified: 0 });
  });

  it('uses proven ordered structure for repeated paragraphs, never a quote search', () => {
    const before = '<p>相同</p><p>相同</p>', after = '<p id="first">相同</p><p id="second">相同</p>';
    const comments = [comment(1, 3, 'first'), comment(5, 7, 'second')];
    const result = adoptPublishedCommentIdentity(before, after, comments, context);
    expect(result.comments).toEqual(comments); expect(result.migrated).toBe(2);
    const changed = adoptPublishedCommentIdentity(before, after + '<p id="third">相同</p>', comments, context);
    expect(changed.equivalent).toBe(false); expect(changed.comments.every(value => value.anchor.state === 'unverified')).toBe(true);
  });

  it('accepts cloud document IDs and harmless serialization differences without changing offsets', () => {
    const before = '<p align="left">甲 &amp; 乙</p>', after = '<p comment-refs="cloud-comment" id="cloud-p" align="left">甲 &#38; 乙</p>';
    const original = comment(1, 6);
    const result = adoptPublishedCommentIdentity(before, after, [original], { ...context, kind: 'first-push' });
    expect(result.equivalent).toBe(true); expect(result.comments).toEqual([original]);
  });

  it('rejects another document, missing identity, and an ordinary pull even for identical text', () => {
    for (const invalid of [{ ...context, documentId: 'Other' }, { ...context, expectedDocumentId: '', documentId: '' }, { ...context, kind: 'pull' }]) {
      const result = adoptPublishedCommentIdentity('<p>A</p>', '<p id="A">A</p>', [comment(1, 2)], invalid as PublishedIdentityContext);
      expect(result.equivalent).toBe(false); expect(result.comments[0].anchor.state).toBe('unverified');
    }
  });

  it('rejects changed titles, formatting, ordering, whitespace and duplicate cloud block IDs', () => {
    const before = '<title>原题</title><p>甲</p><p>乙</p>';
    for (const after of [
      '<title id="t">新题</title><p id="a">甲</p><p id="b">乙</p>',
      '<title id="t">原题</title><p id="a"><b>甲</b></p><p id="b">乙</p>',
      '<title id="t">原题</title><p id="a">乙</p><p id="b">甲</p>',
      '<title id="t">原题</title><p id="a">甲 </p><p id="b">乙</p>',
      '<title id="t">原题</title><p id="same">甲</p><p id="same">乙</p>',
    ]) {
      const result = adoptPublishedCommentIdentity(before, after, [comment(5, 6)], context);
      expect(result.equivalent).toBe(false); expect(result.migrated).toBe(0);
    }
  });

  it('keeps text and whole-board anchors only when their exact PM positions remain valid', () => {
    const before = '<p>A🙂</p><whiteboard type="svg"><svg><text id="shape-1">图</text></svg></whiteboard>';
    const after = '<p id="p">A🙂</p><whiteboard id="board" type="svg"><svg><text id="shape-1">图</text></svg></whiteboard>';
    const comments = [comment(1, 4, 'text'), comment(5, 6, 'whole-board')];
    expect(adoptPublishedCommentIdentity(before, after, comments, context).comments).toEqual(comments);
    for (const invalid of [comment(-1, 1), comment(0, 0), comment(1, 50), comment(0, 1), comment(1.5, 2)])
      expect(adoptPublishedCommentIdentity(before, after, [invalid], context).comments[0].anchor.state).toBe('unverified');
  });

  it('validates stored board identity even when the local XML is byte-for-byte unchanged', () => {
    const xml = '<whiteboard id="B" token="newBoard"/>';
    const wrong = { ...comment(0, 1), anchor: { ...comment(0, 1).anchor, target: target('token:oldBoard') } };
    expect(validateUnchangedLocalComments(xml, [wrong])[0].anchor.state).toBe('unverified');
    expect(adoptPublishedCommentIdentity(xml, xml, [wrong], context).comments[0].anchor.state).toBe('unverified');
    const right = { ...wrong, anchor: { ...wrong.anchor, target: target('token:newBoard') } };
    expect(validateUnchangedLocalComments(xml, [right])).toEqual([right]);
    expect(adoptPublishedCommentIdentity(xml, xml, [right], context).comments).toEqual([right]);
  });

  it('preserves a local inline board draft anchor but does not guess new cloud component identities', () => {
    const xml = '<whiteboard type="svg"><svg><text id="shape-1">图</text></svg></whiteboard>';
    const identity = 'sha256:' + createHash('sha256').update(xml).digest('hex');
    const original = { ...comment(0, 1), anchor: { ...comment(0, 1).anchor, target: target(identity) } };
    expect(validateUnchangedLocalComments(xml, [original])).toEqual([original]);
    const onlyOuterIDChanged = xml.replace('<whiteboard ', '<whiteboard id="new-block" ');
    const result = adoptPublishedCommentIdentity(xml, onlyOuterIDChanged, [original], context);
    expect(result.equivalent).toBe(true); expect(result.comments[0].anchor.state).toBe('unverified');
    expect(result.comments[0].anchor.target).toEqual(original.anchor.target);
    const copied = adoptPublishedCommentIdentity(xml, '<whiteboard id="new-block" token="new-cloud-board"/>', [original], context);
    expect(copied.equivalent).toBe(false); expect(copied.comments[0].anchor.state).toBe('unverified');
  });

  it('never upgrades deleted or previously unverified anchors and never mutates input comments', () => {
    const comments = [comment(1, 2), { ...comment(1, 2, 'deleted'), anchor: { ...comment(1, 2).anchor, state: 'deleted' as const } },
      { ...comment(1, 2, 'unverified'), anchor: { ...comment(1, 2).anchor, state: 'unverified' as const } }];
    const saved = structuredClone(comments);
    const result = adoptPublishedCommentIdentity('<p>A</p>', '<p id="p">A</p>', comments, context);
    expect(result.migrated).toBe(1); expect(result.unverified).toBe(0); expect(result.comments).toEqual(saved);
    adoptPublishedCommentIdentity('<p>A</p>', '<p id="p">B</p>', comments, context);
    expect(comments).toEqual(saved);
  });

  it('fails closed for malformed source rather than inventing correspondence', () => {
    const original = comment(1, 2);
    expect(validateUnchangedLocalComments('<p>broken', [original])[0].anchor.state).toBe('unverified');
    expect(adoptPublishedCommentIdentity('<p>broken', '<p>A</p>', [original], context).equivalent).toBe(false);
  });
});
