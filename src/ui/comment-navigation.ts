import type { Editor } from '@tiptap/core';
import type { Anchor } from '../core/types';
import { locateWhiteboardComponent } from './whiteboard-comments';

export interface CommentLocation { located: boolean; reason?: string; }

/** Scroll the actual first line of a quote, including independently scrolling
 * editor panes in Obsidian. A paragraph may be much taller than the viewport. */
function scrollRange(range: Range, root: HTMLElement): boolean {
  const owner = root.ownerDocument, viewport = owner.defaultView;
  if (!viewport) return false;
  const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
  if (!start || !root.contains(start)) return false;
  const rect = Array.from(range.getClientRects?.() || []).find(value => value.height > 0 || value.width > 0);
  if (!rect) {
    // Non-layout hosts still support element navigation; use the exact marked
    // span when available, rather than the whole editor or document container.
    if (typeof start.scrollIntoView !== 'function') return false;
    start.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }
  let top = rect.top, left = rect.left;
  for (let element: Element | null = start; element; element = element.parentElement) {
    if (element === owner.scrollingElement || element === owner.documentElement || element === owner.body) continue;
    const style = viewport.getComputedStyle(element), bounds = element.getBoundingClientRect();
    const beforeTop = element.scrollTop, beforeLeft = element.scrollLeft;
    if (/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight && element.clientHeight > 0)
      element.scrollTop += top + rect.height / 2 - (bounds.top + element.clientTop + element.clientHeight / 2);
    if (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth && element.clientWidth > 0) {
      const visibleLeft = bounds.left + element.clientLeft, visibleRight = visibleLeft + element.clientWidth;
      if (left < visibleLeft) element.scrollLeft += left - visibleLeft;
      else if (left + rect.width > visibleRight) element.scrollLeft += left + Math.min(rect.width, element.clientWidth) - visibleRight;
    }
    top -= element.scrollTop - beforeTop;
    left -= element.scrollLeft - beforeLeft;
  }
  // Nested panes may already have made the quote visible. Only scroll the
  // document when it is actually scrollable, so its surrounding host stays put.
  const page = owner.scrollingElement || owner.documentElement;
  if (page.scrollHeight > viewport.innerHeight) {
    const y = Math.max(0, viewport.scrollY + top + rect.height / 2 - viewport.innerHeight / 2);
    viewport.scrollTo({ top: y, left: viewport.scrollX, behavior: 'instant' });
  }
  return true;
}

/** Navigation must not change the editor/native selection, create a comment
 * draft, expose an atom's source editor, or add undo history. */
export function locateComment(editor: Editor | null, anchor: Anchor): CommentLocation {
  if (anchor.state === 'deleted') return { located: false, reason: '原评论引用的内容已删除，原引用仍保留。' };
  if (anchor.state !== 'attached') return { located: false, reason: '文档已修改，这条评论的引用位置需要重新确认。' };
  if (!editor || editor.isDestroyed) return { located: false, reason: '文档编辑器尚未就绪，请重新打开文章。' };
  const { from, to } = anchor, root = editor.view.dom;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > editor.state.doc.content.size)
    return { located: false, reason: '这条评论的引用位置已失效，请重新确认。' };
  if (root.closest('[hidden]')) return { located: false, reason: '请先返回正文，再定位评论。' };
  if (anchor.target) {
    const result = locateWhiteboardComponent(editor, anchor);
    if (!result.element) return { located: false, reason: result.reason };
    if (typeof result.element.scrollIntoView !== 'function') return { located: false, reason: '当前视图暂不支持滚动定位。' };
    for (const selected of root.querySelectorAll('.lr-whiteboard-component-selected')) {
      selected.classList.remove('lr-whiteboard-component-selected');
      selected.removeAttribute('data-comment-navigation');
    }
    result.element.classList.add('lr-whiteboard-component-selected');
    result.element.setAttribute('data-comment-navigation', 'true');
    result.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { located: true };
  }
  try {
    const node = editor.state.doc.nodeAt(from);
    if (node?.isAtom && !node.isText && to === from + node.nodeSize) {
      const dom = editor.view.nodeDOM(from);
      if (dom?.nodeType !== 1 || !root.contains(dom) || typeof (dom as Element).scrollIntoView !== 'function')
        return { located: false, reason: '原引用内容尚未展示，请稍后再定位。' };
      (dom as Element).scrollIntoView({ block: 'center', inline: 'nearest' });
      return { located: true };
    }
    const start = editor.view.domAtPos(from, 1), end = editor.view.domAtPos(to, -1);
    if (!root.contains(start.node) || !root.contains(end.node)) return { located: false, reason: '原引用内容尚未展示，请稍后再定位。' };
    const range = root.ownerDocument.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    if (range.collapsed) return { located: false, reason: '这条评论的引用范围已失效，请重新确认。' };
    return scrollRange(range, root) ? { located: true } : { located: false, reason: '当前视图暂不支持滚动定位。' };
  } catch {
    return { located: false, reason: '这条评论的引用位置已失效，请重新确认。' };
  }
}
