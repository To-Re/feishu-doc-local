import { Extension, Node as TiptapNode, Mark, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlock } from '@tiptap/extension-code-block';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { canSplit } from '@tiptap/pm/transform';
import { render as renderLatex } from 'katex';
import { attachWhiteboardPreview, attachSVGPreview, whiteboardIdentity } from './whiteboard-preview';
import type { AnchorTarget } from '../core/types';
import { RESOURCE_REFRESH, isSafeResourcePath, isWhiteboardSVGPath, type ResourceResolver, type ResourceTextLoader } from '../core/resources';
import { attachmentView, renderAttachment } from './attachment-preview';
import { docxColor as color } from './docx-color';
import { codeHighlightingPlugin } from './code-highlighting';
export const WHITEBOARD_COMPONENT_SELECTION = 'whiteboardComponentSelection';
const metadataTypes = ['paragraph', 'heading', 'xmlTitle', 'bulletList', 'orderedList', 'listItem', 'xmlCheckbox', 'blockquote', 'xmlCallout', 'xmlGrid', 'xmlColumn', 'xmlInlineLatex', 'xmlBlockLatex', 'codeBlock', 'horizontalRule', 'hardBreak', 'table', 'tableRow', 'tableCell', 'tableHeader', 'protectedBlock', 'protectedInline', 'bold', 'italic', 'underline', 'strike', 'code', 'link', 'xmlSpan'];
const silent = { default: null, rendered: false, keepOnSplit: false };
const XMLMetadata = Extension.create({
  name: 'xmlMetadata',
  addGlobalAttributes() {
    return [
      { types: metadataTypes, attributes: { lrSource: silent, lrAttrs: silent, lrTag: silent } },
      { types: ['tableRow'], attributes: { lrSection: silent } },
      { types: ['table'], attributes: { xmlColgroup: silent } },
      { types: ['codeBlock'], attributes: { xmlCodeAttrs: silent, xmlCaption: silent } },
      {
        types: ['paragraph', 'heading', 'xmlTitle', 'listItem', 'xmlCheckbox'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: element => ['left', 'center', 'right'].includes(element.style.textAlign) ? element.style.textAlign : null,
            renderHTML: attrs => ['left', 'center', 'right'].includes(attrs.textAlign) ? { style: `text-align: ${attrs.textAlign}` } : {},
          },
        },
      },
      {
        types: ['heading', 'listItem'],
        attributes: {
          xmlSeq: { ...silent, rendered: true, renderHTML: attrs => attrs.xmlSeq === 'auto' || /^\d+$/.test(attrs.xmlSeq || '') ? { 'data-xml-seq': attrs.xmlSeq, ...(/^\d+$/.test(attrs.xmlSeq) ? { value: attrs.xmlSeq } : {}) } : {} },
        },
      },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          xmlBackground: { default: null, renderHTML: attrs => color(attrs.xmlBackground, 'table') ? { style: `background-color: ${color(attrs.xmlBackground, 'table')}` } : {} },
          verticalAlign: { default: null, renderHTML: attrs => ['top', 'middle', 'bottom'].includes(attrs.verticalAlign) ? { style: `vertical-align: ${attrs.verticalAlign}` } : {} },
        },
      },
    ];
  },
});

const XMLHeading = TiptapNode.create({
  name: 'heading', group: 'block', content: 'inline*', defining: true,
  addAttributes: () => ({ level: { default: 1, rendered: false } }),
  parseHTML: () => Array.from({ length: 9 }, (_, i) => ({ tag: `h${i + 1}`, attrs: { level: i + 1 } })),
  renderHTML: ({ node, HTMLAttributes }) => {
    const level = Math.max(1, Math.min(9, Number(node.attrs.level) || 1));
    return [`h${level}`, mergeAttributes(HTMLAttributes, level > 6 ? { style: 'display: block; font-weight: 600; font-size: 1em' } : {}), 0];
  },
  addCommands() {
    return {
      setHeading: attributes => ({ commands }) => commands.setNode(this.name, attributes),
      toggleHeading: attributes => ({ commands }) => commands.toggleNode(this.name, 'paragraph', attributes),
    };
  },
});
const XMLTitle = TiptapNode.create({
  name: 'xmlTitle', group: 'block', content: 'inline*', defining: true,
  parseHTML: () => [{ tag: 'h1[data-xml-title]' }],
  renderHTML: ({ HTMLAttributes }) => ['h1', mergeAttributes(HTMLAttributes, { 'data-xml-title': '', class: 'docx-title' }), 0],
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.command(({ tr, state, dispatch }) => {
        const selection = tr.selection;
        if (!this.editor.isEditable || !(selection instanceof TextSelection) || selection.$from.parent.type.name !== this.name || !selection.$from.sameParent(selection.$to)) return false;
        const paragraph = state.schema.nodes.paragraph;
        if (!paragraph) return false;
        const types = [{ type: paragraph }];
        if (!canSplit(tr.doc, selection.from, 1, types)) return false;
        if (dispatch) {
          // A DocxXML document has one title. Its right half becomes ordinary body text.
          tr.deleteSelection();
          const position = tr.selection.from;
          tr.split(position, 1, types);
          tr.setSelection(TextSelection.near(tr.doc.resolve(position + 2)));
          tr.setStoredMarks(null);
          tr.scrollIntoView();
        }
        return true;
      }),
    };
  },
});
const XMLCheckbox = TiptapNode.create({
  name: 'xmlCheckbox', group: 'block', content: 'inline*', defining: true,
  addAttributes: () => ({ checked: { default: false, parseHTML: element => element.getAttribute('data-checked') === 'true' } }),
  parseHTML: () => [{ tag: 'div[data-xml-checkbox]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-xml-checkbox': '', 'data-checked': String(node.attrs.checked) }), 0],
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'lr-checkbox';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.contentEditable = 'false'; input.setAttribute('aria-label', '完成此项');
      const contentDOM = document.createElement('span');
      dom.append(input, contentDOM);
      function sync() { input.checked = !!current.attrs.checked; dom.dataset.checked = String(current.attrs.checked); }
      input.addEventListener('change', () => {
        const position = getPos();
        if (editor.isEditable && typeof position === 'number') editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, checked: input.checked }));
        else sync();
      });
      sync();
      return { dom, contentDOM, stopEvent: event => event.target === input, update(next) { if (next.type !== current.type) return false; current = next; sync(); return true; } };
    };
  },
});
const XMLCallout = TiptapNode.create({
  name: 'xmlCallout', group: 'block', content: '(paragraph | bulletList | orderedList | xmlCheckbox)+', defining: true, isolating: true,
  addAttributes: () => ({ emoji: { default: null }, xmlBackground: { default: null }, borderColor: { default: null }, textColor: { default: null } }),
  parseHTML: () => [{ tag: 'aside[data-xml-callout]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const styles = [
      `background-color: ${color(node.attrs.xmlBackground, 'callout') || '#f3f5f7'}`,
      `border-left: 3px solid ${color(node.attrs.borderColor, 'border') || '#c6cdd7'}`,
      color(node.attrs.textColor, 'text') ? `color: ${color(node.attrs.textColor, 'text')}` : '',
    ].filter(Boolean).join('; ');
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-xml-callout': '', class: 'callout', style: styles }),
      ['span', { contenteditable: 'false', class: 'lr-callout-icon' }, node.attrs.emoji || ''], ['div', 0]];
  },
});
const XMLSpan = Mark.create({
  name: 'xmlSpan',
  addAttributes: () => ({ textColor: { default: null }, backgroundColor: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-xml-span]' }],
  renderHTML: ({ mark, HTMLAttributes }) => {
    const style = [color(mark.attrs.textColor, 'text') ? `color: ${color(mark.attrs.textColor, 'text')}` : '', color(mark.attrs.backgroundColor, 'background') ? `background-color: ${color(mark.attrs.backgroundColor, 'background')}` : ''].filter(Boolean).join('; ');
    return ['span', mergeAttributes(HTMLAttributes, { 'data-xml-span': '', ...(style ? { style } : {}) }), 0];
  },
});
const XMLCodeBlock = CodeBlock.extend({
  addProseMirrorPlugins() {
    return [...(this.parent?.() || []), codeHighlightingPlugin()];
  },
  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'lr-code-block';
      const header = document.createElement('div');
      header.className = 'lr-code-header'; header.contentEditable = 'false';
      const caption = document.createElement('span'); caption.className = 'lr-code-caption';
      const language = document.createElement('span'); language.className = 'lr-code-language';
      header.append(caption, language);
      const body = document.createElement('div'); body.className = 'lr-code-body';
      const lines = document.createElement('div');
      lines.className = 'lr-code-lines'; lines.contentEditable = 'false'; lines.setAttribute('aria-hidden', 'true');
      const pre = document.createElement('pre');
      const contentDOM = document.createElement('code');
      contentDOM.setAttribute('spellcheck', 'false');
      pre.append(contentDOM); body.append(lines, pre); dom.append(header, body);
      function sync() {
        caption.textContent = String(current.attrs.xmlCaption || '');
        language.textContent = String(current.attrs.language || '');
        caption.hidden = !caption.textContent; language.hidden = !language.textContent;
        header.hidden = !caption.textContent && !language.textContent;
        contentDOM.className = current.attrs.language ? `language-${String(current.attrs.language).replace(/[^a-zA-Z0-9_+-]/g, '')}` : '';
        const count = current.textContent.split('\n').length;
        if (lines.childElementCount !== count) {
          // Numbers are decoration outside contentDOM, never copied or serialized as code.
          lines.replaceChildren(...Array.from({ length: count }, (_, index) => {
            const line = document.createElement('span'); line.dataset.line = String(index + 1); return line;
          }));
        }
      }
      sync();
      return {
        dom, contentDOM,
        ignoreMutation: mutation => mutation.type !== 'selection' && !contentDOM.contains(mutation.target),
        update(next) { if (next.type !== current.type) return false; current = next; sync(); return true; },
      };
    };
  },
});
const XMLGrid = TiptapNode.create({
  name: 'xmlGrid', group: 'block', content: 'xmlColumn+', defining: true, isolating: true,
  parseHTML: () => [{ tag: 'div[data-xml-grid]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-xml-grid': '', class: 'lr-grid', style: 'display: flex; align-items: stretch; gap: 24px' }), 0],
});
const XMLColumn = TiptapNode.create({
  name: 'xmlColumn', content: 'block+', defining: true, isolating: true,
  addAttributes: () => ({ widthRatio: { default: null, rendered: false, parseHTML: element => element.getAttribute('data-width-ratio') } }),
  parseHTML: () => [{ tag: 'div[data-xml-column]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const ratio = Number(node.attrs.widthRatio);
    const valid = Number.isFinite(ratio) && ratio > 0 && ratio <= 1;
    return ['div', mergeAttributes(HTMLAttributes, { 'data-xml-column': '', 'data-width-ratio': node.attrs.widthRatio || '', class: 'lr-column', style: `flex-grow: ${valid ? ratio : 1}; flex-shrink: 1; flex-basis: 0px; min-width: 0` }), 0];
  },
});
function latexContent(inline: boolean) {
  return TiptapNode.create({
    name: inline ? 'xmlInlineLatex' : 'xmlBlockLatex',
    group: inline ? 'inline' : 'block', inline, atom: true, isolating: true, selectable: true,
    addAttributes: () => ({ expression: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-latex-source') || '' } }),
    parseHTML: () => [{ tag: `${inline ? 'span' : 'div'}[data-xml-latex="${inline ? 'inline' : 'block'}"]` }],
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { 'data-xml-latex': inline ? 'inline' : 'block', 'data-latex-source': node.attrs.expression, class: inline ? 'lr-latex-inline' : 'lr-latex-block' }, node.attrs.expression],
    addNodeView() {
      return ({ node }) => {
        let current = node;
        const dom = document.createElement(inline ? 'span' : 'div');
        dom.className = inline ? 'lr-latex-inline' : 'lr-latex-block';
        dom.contentEditable = 'false';
        dom.dataset.xmlLatex = inline ? 'inline' : 'block';
        function sync() {
          const expression = String(current.attrs.expression || '');
          dom.dataset.latexSource = expression;
          dom.setAttribute('aria-label', `公式：${expression}`);
          dom.classList.remove('lr-latex-error');
          dom.removeAttribute('title');
          try {
            // KaTeX builds its own DOM. Untrusted TeX cannot load images, URLs or HTML.
            // Feishu uses display-style operators inside an inline layout. Keep this
            // presentation prefix out of the stored expression and exported XML.
            const renderedExpression = inline ? `\\displaystyle ${expression}` : expression;
            renderLatex(renderedExpression, dom, { displayMode: !inline, trust: false, throwOnError: true, strict: 'ignore', maxExpand: 1000, maxSize: 20 });
          } catch {
            dom.textContent = expression || '空公式';
            dom.classList.add('lr-latex-error');
            dom.title = '暂不能显示此公式，源表达式已保留。';
          }
        }
        sync();
        return { dom, ignoreMutation: () => true, update(next) { if (next.type !== current.type) return false; current = next; sync(); return true; } };
      };
    },
  });
}
function protectedContent(inline: boolean, assetURL?: (path: string) => string, resolveResource?: ResourceResolver, loadResource?: ResourceTextLoader, onComponentSelect?: (from:number,target:AnchorTarget)=>void) {
  return TiptapNode.create({
    name: inline ? 'protectedInline' : 'protectedBlock',
    group: inline ? 'inline' : 'block', inline, atom: true, isolating: true, selectable: true,
    addAttributes: () => ({ rawXML: silent, label: { default: '受保护内容', rendered: false }, assetPath: silent }),
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { 'data-lark-protected': inline ? 'inline' : 'block', contenteditable: 'false', class: inline ? 'protected-inline' : 'protected-block' }, node.attrs.label || '受保护内容'],
    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node;
        const dom = document.createElement(inline ? 'span' : 'div');
        dom.className = inline ? 'protected-inline' : 'protected-block';
        dom.contentEditable = 'false';
        dom.setAttribute('data-lark-protected', '');
        let destroyPreview: (() => void) | undefined;
        const selectComponent=(target:AnchorTarget)=>{
          const position=getPos();
          if(typeof position!=='number'||editor.isDestroyed)return;
          editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc,position)).setMeta(WHITEBOARD_COMPONENT_SELECTION,true));
          onComponentSelect?.(position,target);
        };
        const previewState=(state:string)=>{if(state==='ready')dom.dispatchEvent(new CustomEvent('whiteboard-preview-ready',{bubbles:true}));};
        function render() {
          destroyPreview?.(); destroyPreview = undefined;
          dom.classList.remove('lr-attachment', 'lr-attachment-inline', 'lr-attachment-block');
          dom.removeAttribute('data-attachment-view'); dom.removeAttribute('aria-label');
          const label = document.createElement('span'); label.textContent = current.attrs.label || '受保护内容'; dom.replaceChildren(label);
          const tag = current.attrs.lrTag;
          const attrs = current.attrs.lrAttrs || {};
          const attachment = attachmentView(current.attrs.rawXML, tag, inline);
          if (attachment) { renderAttachment(dom, attachment, inline, assetURL, resolveResource); return; }
          const resource = resolveResource?.(tag,attrs);
          let path: string | undefined;
          if (tag === 'whiteboard' && typeof current.attrs.rawXML === 'string') {
            const board = new DOMParser().parseFromString(current.attrs.rawXML,'application/xml').documentElement;
            const hasInlineContent = !!board.textContent?.trim() || board.childElementCount > 0;
            const boardType = (board.getAttribute('type') || '').trim().toLowerCase();
            const inlineSVG = hasInlineContent && boardType === 'svg';
            const locallyRenderable = hasInlineContent && ['svg','mermaid'].includes(boardType);
            if (!inlineSVG && resource?.representation === 'preview' && isWhiteboardSVGPath(resource.path) && loadResource) {
              label.textContent = '白板云端预览（本地缓存）'; label.className = 'lr-media-caption';
              const preview = document.createElement('div'); preview.className = 'whiteboard-preview'; dom.prepend(preview);
              let disposed=false,dispose:(()=>void)|undefined;
              void whiteboardIdentity(current.attrs.rawXML).then(board=>{
                if(!disposed)dispose=attachSVGPreview(preview,signal => loadResource(resource.path,signal),previewState,{board,onComponentSelect:selectComponent});
              }).catch(()=>{if(!disposed)preview.textContent='白板引用格式不正确，原始内容已保留。';});
              destroyPreview=()=>{disposed=true;dispose?.();};
            } else if (!locallyRenderable && resource?.representation === 'preview' && isSafeResourcePath(resource.path)) {
              path = resource.path;
              label.textContent = '白板预览（本地缓存）'; label.className = 'lr-media-caption';
            } else {
              label.remove();
              const preview = document.createElement('div'); preview.className = 'whiteboard-preview';
              dom.prepend(preview);
              destroyPreview = attachWhiteboardPreview(preview, current.attrs.rawXML,previewState,{onComponentSelect:selectComponent});
            }
          } else if (tag === 'img') {
            const rawPath = typeof current.attrs.assetPath === 'string' ? current.attrs.assetPath : '';
            const local = rawPath.startsWith('@') ? rawPath.slice(1) : '';
            path = isSafeResourcePath(local) ? local : resource?.representation === 'original' ? resource.path : undefined;
          }
          if (assetURL && isSafeResourcePath(path)) {
            const img = document.createElement('img');
            img.alt = tag === 'whiteboard' ? '白板预览（本地缓存）' : current.attrs.label || '本地图片'; img.loading = 'lazy';
            if (tag === 'img') {
              const originalScale = Number(attrs.scale);
              const scale = Number.isFinite(originalScale) && originalScale > 0 ? originalScale : 1;
              for (const key of ['width', 'height']) {
                const size = Number(attrs[key])*scale;
                if (Number.isFinite(size) && size > 0) img.setAttribute(key, String(size));
              }
              if (typeof attrs.caption === 'string') label.className = 'lr-media-caption';
            }
            img.addEventListener('error',() => {
              img.remove();
              label.textContent = tag === 'whiteboard' ? '白板预览缓存不可用，原始引用已保留。' : `${current.attrs.label || '图片'}（本地缓存不可用）`;
            });
            img.src = assetURL(path); dom.prepend(img);
          }
        }
        const refresh = ({transaction}: {transaction: import('@tiptap/pm/state').Transaction}) => { if (transaction.getMeta(RESOURCE_REFRESH)) render(); };
        editor.on('transaction',refresh);
        render();
        return { dom, ignoreMutation: () => true,
          update(next) { if (next.type !== current.type) return false; if (next !== current) { current = next; render(); } return true; },
          destroy() { editor.off('transaction',refresh); destroyPreview?.(); },
        };
      };
    },
  });
}

/** No DocxXML is inserted as HTML; only schema-owned DOM and safe local image URLs are rendered. */
export function xmlExtensions(assetURL?: (path: string) => string, resolveResource?: ResourceResolver, loadResource?: ResourceTextLoader, onComponentSelect?: (from:number,target:AnchorTarget)=>void): Extensions {
  return [
    StarterKit.configure({ heading: false, codeBlock: false, trailingNode: false, link: { openOnClick: false, autolink: false, linkOnPaste: false, HTMLAttributes: { target: null, rel: 'noopener noreferrer' } } }),
    TableKit.configure({ table: { resizable: false } }),
    XMLMetadata, XMLHeading, XMLTitle, XMLCheckbox, XMLCallout, XMLSpan, XMLCodeBlock, XMLGrid, XMLColumn, latexContent(false), latexContent(true),
    protectedContent(false, assetURL, resolveResource, loadResource,onComponentSelect), protectedContent(true, assetURL, resolveResource, loadResource,onComponentSelect),
  ];
}
