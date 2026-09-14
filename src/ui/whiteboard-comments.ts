import type { Editor } from '@tiptap/core';
import { isAnchorTarget } from '../core/anchors';
import type { Anchor, ReviewComment } from '../core/types';

export interface WhiteboardComponentLocation { element: SVGElement | null; reason?: string; }

/** Find an exact component within its original document atom and rendered board identity. */
export function locateWhiteboardComponent(editor: Editor, anchor: Anchor): WhiteboardComponentLocation {
  if (!isAnchorTarget(anchor.target)) return { element: null, reason: '这条评论没有有效的白板节点标识。' };
  if (anchor.state === 'deleted') return { element: null, reason: '原评论所在的白板已删除，原引用仍保留。' };
  if (anchor.state !== 'attached') return { element: null, reason: '文档已修改，白板节点的位置需要重新确认。' };
  if (editor.isDestroyed) return { element: null, reason: '文档编辑器尚未就绪，请重新打开文章。' };
  const doc = editor.state.doc;
  if (!Number.isSafeInteger(anchor.from) || anchor.from < 0 || anchor.from >= doc.content.size || anchor.to !== anchor.from + 1)
    return { element: null, reason: '白板评论的位置已失效，请重新确认。' };
  const node = doc.nodeAt(anchor.from);
  if (!node?.isAtom || !node.isLeaf || node.attrs.lrTag !== 'whiteboard' ||
    (node.type.name !== 'protectedBlock' && node.type.name !== 'protectedInline'))
    return { element: null, reason: '原评论位置已不再是白板，请重新确认。' };
  const dom = editor.view.nodeDOM(anchor.from);
  if (dom?.nodeType !== 1 || !editor.view.dom.contains(dom))
    return { element: null, reason: '白板预览尚未就绪，请稍后再定位。' };
  const rendered = dom as Element;
  const boards = [ ...(rendered.hasAttribute('data-review-board') ? [rendered] : []), ...rendered.querySelectorAll('[data-review-board]') ];
  if (!boards.length) return { element: null, reason: '白板预览尚未就绪或暂不支持节点定位，请稍后重试。' };
  const matchingBoards = boards.filter(board => board.getAttribute('data-review-board') === anchor.target!.board);
  if (!matchingBoards.length) return { element: null, reason: '白板来源已变化，这条节点评论需要重新确认。' };
  if (matchingBoards.length !== 1) return { element: null, reason: '白板预览包含重复身份，无法唯一定位节点。' };

  const board = matchingBoards[0];
  // Compare opaque identities as data; ids can contain characters meaningful in CSS selectors.
  const matches = [ ...(board.hasAttribute('data-review-component-id') ? [board] : []), ...board.querySelectorAll('[data-review-component-id]') ]
    .filter(component => component.getAttribute('data-review-component-id') === anchor.target!.id &&
      component.closest('[data-review-board]') === board);
  if (!matches.length) return { element: null, reason: '白板中已找不到这个节点，原评论与引用仍保留。' };
  if (matches.length !== 1) return { element: null, reason: '白板包含重复的节点标识，无法唯一定位。' };
  const component = matches[0];
  if (component.namespaceURI !== 'http://www.w3.org/2000/svg')
    return { element: null, reason: '白板节点预览格式不正确，无法定位。' };
  return { element: component as SVGElement };
}

/** Update presentation only; no ProseMirror transaction or source XML change is needed. */
export function applyWhiteboardComponentHighlights(editor: Editor, comments: readonly ReviewComment[], showResolved = false): void {
  if (editor.isDestroyed) return;
  for (const element of editor.view.dom.querySelectorAll('.lr-whiteboard-component-commented'))
    element.classList.remove('lr-whiteboard-component-commented');
  for (const comment of comments) {
    if ((!showResolved && comment.status !== 'open') || comment.anchor.state !== 'attached' || !comment.anchor.target) continue;
    locateWhiteboardComponent(editor, comment.anchor).element?.classList.add('lr-whiteboard-component-commented');
  }
  for (const element of editor.view.dom.querySelectorAll('[data-comment-navigation]')) {
    if (element.classList.contains('lr-whiteboard-component-commented')) continue;
    element.classList.remove('lr-whiteboard-component-selected');
    element.removeAttribute('data-comment-navigation');
  }
}
