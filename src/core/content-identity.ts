import { createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import { isAnchorTarget } from './anchors';
import { comparableXML, contentNodes, type ContentNode } from './content-xml';
import { parseDocxXML } from './docxml';
import type { Anchor, ReviewComment } from './types';

export interface PublishedIdentityContext {
  kind: 'create' | 'first-push';
  expectedDocumentId: string;
  documentId: string;
}
export interface PublishedIdentityResult {
  comments: ReviewComment[];
  equivalent: boolean;
  migrated: number;
  unverified: number;
}

const leaves = new Set(['protectedBlock', 'protectedInline', 'xmlInlineLatex', 'xmlBlockLatex', 'hardBreak', 'horizontalRule']);
type PositionedNode = { node: JSONContent; from: number; to: number; leaf: boolean };
type DocumentShape = { signature: string; size: number; nodes: PositionedNode[] };
function shape(xml: string): DocumentShape {
  const nodes: PositionedNode[] = [];
  // The raw structure is checked independently. These source bookkeeping values
  // must not make cloud-assigned block IDs change the editor's position proof.
  function plain(node: JSONContent): unknown {
    const attrs = Object.entries(node.attrs || {}).filter(([key]) => !['lrSource', 'lrAttrs', 'rawXML'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
    return [node.type, node.text, attrs, node.marks?.map(plain), node.content?.map(plain)];
  }
  function visit(node: JSONContent, from: number): number {
    const leaf = node.type === 'text' || leaves.has(node.type || '');
    let size = node.type === 'text' ? node.text!.length : leaf ? 1 : node.type === 'doc' ? 0 : 2;
    let offset = from + (node.type === 'doc' || leaf ? 0 : 1);
    for (const child of node.content || []) { const childSize = visit(child, offset); offset += childSize; size += childSize; }
    nodes.push({ node, from, to: from + size, leaf });
    return size;
  }
  const content = parseDocxXML(xml).content;
  return { signature: JSON.stringify(plain(content)), size: visit(content, 0), nodes };
}

function boardIdentity(node: JSONContent): string | undefined {
  if (!['protectedBlock', 'protectedInline'].includes(node.type || '') || node.attrs?.lrTag !== 'whiteboard') return;
  const attrs = node.attrs.lrAttrs || {};
  for (const key of ['token', 'src', 'id', 'path']) {
    const value = attrs[key];
    if (typeof value === 'string' && value.trim() && value.length <= 4000) return key + ':' + value;
  }
  return typeof node.attrs.rawXML === 'string' ? 'sha256:' + createHash('sha256').update(node.attrs.rawXML).digest('hex') : undefined;
}
function anchoredBoard(anchor: Anchor, document: DocumentShape): PositionedNode | undefined {
  return document.nodes.find(({ node, from, to, leaf }) => leaf && from === anchor.from && to === anchor.to && boardIdentity(node));
}
function validAnchor(anchor: Anchor, document: DocumentShape): boolean {
  if (!Number.isSafeInteger(anchor.from) || !Number.isSafeInteger(anchor.to) || anchor.from < 0 || anchor.from >= anchor.to || anchor.to > document.size) return false;
  if (anchor.target) return isAnchorTarget(anchor.target) && boardIdentity(anchoredBoard(anchor, document)?.node || {}) === anchor.target.board;
  return document.nodes.some(node => node.leaf && node.from < anchor.to && node.to > anchor.from);
}
function unverified(comment: ReviewComment): ReviewComment {
  return comment.anchor.state === 'attached' ? { ...comment, anchor: { ...comment.anchor, state: 'unverified' } } : comment;
}

/** Validate an unchanged local revision without requiring cloud IDs or guessing a
 * new location. The caller must first prove review.document.xml === local.xml.
 * Board components are checked against their actual containing board identity;
 * component existence inside a cached cloud board remains the preview's check.
 */
export function validateUnchangedLocalComments(xml: string, comments: ReviewComment[]): ReviewComment[] {
  let document: DocumentShape;
  try { document = shape(xml); } catch { return comments.map(unverified); }
  return comments.map(comment => comment.anchor.state !== 'attached' || validAnchor(comment.anchor, document) ? comment : unverified(comment));
}

function uniqueDocumentIDs(xml: string): boolean {
  const ids = new Set<string>();
  function walk(nodes: ContentNode[]): boolean {
    for (const node of nodes) {
      const id = node.attrs.id;
      if (id && (ids.has(id) || !/^[A-Za-z0-9_-]{1,512}$/.test(id))) return false;
      if (id) ids.add(id);
      if (node.tag !== 'whiteboard' && !walk(node.children.filter((child): child is ContentNode => typeof child !== 'string'))) return false;
    }
    return true;
  }
  return walk(contentNodes(xml));
}

/** Server-only, one-time adoption after an explicitly authorized first publish.
 * Never use for an ordinary pull or to recover comments already marked uncertain.
 * The accepted cloud XML itself stores the real IDs, while contentSync stores its
 * document ID and baseline; a second, potentially stale ID mapping is unnecessary.
 */
export function adoptPublishedCommentIdentity(beforeXML: string, afterXML: string, comments: ReviewComment[], context: PublishedIdentityContext): PublishedIdentityResult {
  let before: DocumentShape | undefined, after: DocumentShape | undefined;
  let equivalent = false;
  if (['create', 'first-push'].includes(context.kind) && /^[A-Za-z0-9_-]{1,512}$/.test(context.expectedDocumentId) && context.documentId === context.expectedDocumentId) {
    try {
      if (comparableXML(beforeXML) === comparableXML(afterXML) && uniqueDocumentIDs(afterXML)) {
        before = shape(beforeXML); after = shape(afterXML);
        equivalent = before.signature === after.signature && before.size === after.size;
      }
    } catch { /* No positional proof is available for malformed or unsupported input. */ }
  }
  let migrated = 0, uncertain = 0;
  const mapped = comments.map(comment => {
    if (comment.anchor.state !== 'attached') return comment;
    const anchor = comment.anchor;
    let safe = equivalent && validAnchor(anchor, before!) && validAnchor(anchor, after!);
    if (safe && anchor.target) {
      // A copied cloud whiteboard may regenerate every native component ID.
      // Do not rewrite token/id/hash identities from a label or drawing similarity.
      const oldBoard = anchoredBoard(anchor, before!)!, newBoard = anchoredBoard(anchor, after!)!;
      safe = oldBoard.node.attrs?.rawXML === newBoard.node.attrs?.rawXML;
    }
    if (safe) { migrated++; return comment; }
    uncertain++; return unverified(comment);
  });
  return { comments: mapped, equivalent, migrated, unverified: uncertain };
}
