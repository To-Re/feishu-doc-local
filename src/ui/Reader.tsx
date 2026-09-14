import { useEffect, useRef, useState } from 'react';
import { Extension, type Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { EditorState, NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { parseDocxXML } from '../core/docxml';
import { captureAnchor, captureWhiteboardComponentAnchor, mapAnchor, mapComments } from '../core/anchors';
import type { Anchor, Review, ReviewComment } from '../core/types';
import { xmlExtensions, WHITEBOARD_COMPONENT_SELECTION } from './xml-extensions';
import { resolveResource, RESOURCE_REFRESH } from '../core/resources';
import { localResourcePath } from '../core/project-files';
import type { Node as PMNode } from '@tiptap/pm/model';
import { applyWhiteboardComponentHighlights } from './whiteboard-comments';
import { SourceDraftRecovery, useSourceDrafts, type SourceDraftSnapshot } from './source-drafts';

/** Reuse the already-open document session; never fetch the raw XML token or a
 * remote SVG URL. The resource endpoint returns inert, listed-file text. */
export async function readWhiteboardResource(assetURL: (path: string) => string, path: string, signal: AbortSignal): Promise<string> {
  const normalized = localResourcePath(path);
  if (!normalized || !/\.svg$/i.test(normalized)) throw new Error('白板预览需要文章内的 SVG 文件。');
  const url = new URL(assetURL(normalized),window.location.href);
  if (url.origin !== window.location.origin || url.pathname !== '/api/asset' || url.hash || url.username || url.password ||
    !url.searchParams.get('id') || url.searchParams.get('path') !== normalized) throw new Error('白板预览未关联当前文档会话。');
  url.pathname = '/api/resource';
  const response = await fetch(url.pathname+url.search,{signal,redirect:'error'});
  const data: unknown = await response.json();
  if (!response.ok) throw new Error('无法读取白板预览文件。');
  if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string' || !('path' in data) || data.path !== normalized)
    throw new Error('白板预览文件响应不匹配。');
  return data.text;
}

interface Props {
  xml: string;
  readOnly: boolean;
  assetURL: (path: string) => string;
  /** Optional storage adapter for hosts without the local HTTP server. */
  readResourceText?: (path: string, signal: AbortSignal) => Promise<string>;
  comments: ReviewComment[];
  /** Keep body marks consistent with the comments visible in the sidebar. */
  showResolved?: boolean;
  getReview: () => Review;
  getDraft: () => Anchor | null;
  onEdit: (xml: string, comments: ReviewComment[], draft: Anchor | null) => void;
  onSelection: (anchor: Anchor | null) => void;
  onReady: (editor: Editor) => void;
  onError: (message: string) => void;
}

function readFormulaSource(node: PMNode) {
  if (!['xmlInlineLatex','xmlBlockLatex'].includes(node.type.name) || typeof node.attrs.lrSource !== 'string') return null;
  const source = String(node.attrs.expression || '');
  return { id: node.type.name + ':' + node.attrs.lrSource, source, revision: source };
}

export function FormulaEditor({editor,readOnly,onDraftChange,persistence}:{editor:Editor|null;readOnly:boolean;onDraftChange?:(dirty:boolean)=>void;persistence?:{initial?:SourceDraftSnapshot;onChange?:(value:SourceDraftSnapshot)=>void}}) {
  const drafts = useSourceDrafts(editor, readFormulaSource, onDraftChange,persistence);
  const {selected,value,changed,conflict,ambiguous} = drafts;
  if(!editor)return null;
  return <>
    <SourceDraftRecovery kind="公式" drafts={drafts.recovery} onDiscard={drafts.discard}/>
    {drafts.count>drafts.recovery.length&&(readOnly||!selected)&&<p role="status">有未应用的公式修改。{readOnly?'切回编辑模式后，':''}选中原公式可继续编辑。</p>}
    {!readOnly&&selected&&<form className="formula-editor" onSubmit={event=>{
    event.preventDefault();
    if(!changed || conflict || ambiguous || !editor.isEditable)return;
    const node=editor.state.doc.nodeAt(selected.position);
    const live=node?readFormulaSource(node):null;
    if(!live || live.id!==selected.source.id || live.revision!==selected.source.revision)return;
    // Attribute steps retain this formula's identity for attached comments.
    editor.view.dispatch(editor.state.tr.setNodeAttribute(selected.position,'expression',value));
  }}><label htmlFor="formula-expression">公式表达式</label><textarea id="formula-expression" data-review-draft={changed?true:undefined} value={value} onChange={event=>drafts.setValue(event.target.value)}/>
    {conflict&&<p role="status">原公式已改变，草稿已保留。请复制草稿或还原为当前公式后继续。</p>}
    <div><button type="button" onClick={()=>drafts.discard(selected.source.id)} disabled={!changed}>还原</button><button className="small-primary" disabled={!changed||conflict||ambiguous}>应用公式</button></div></form>}
  </>;
}

export function Reader(props: Props) {
  const latest = useRef(props); latest.current = props;
  const adapter = useRef<ReturnType<typeof parseDocxXML> | null>(null);
  if (!adapter.current) adapter.current = parseDocxXML(props.xml);
  const liveEditor = useRef<Editor|null>(null);
  const lastXML = useRef(props.xml);
  const loading = useRef(false);
  const resourceSignature = JSON.stringify(props.getReview().resources || null);
  const [warnings, setWarnings] = useState(adapter.current.warnings);
  const editor:Editor|null = useEditor({
    extensions: [
      ...xmlExtensions(props.assetURL, (tag, attrs) => resolveResource(latest.current.getReview().resources, tag, attrs),
        (path,signal) => latest.current.readResourceText ? latest.current.readResourceText(path,signal) : readWhiteboardResource(latest.current.assetURL,path,signal),
        (from,target)=>{const active=liveEditor.current;if(active)latest.current.onSelection(captureWhiteboardComponentAnchor(active.state.doc,from,target));}),
      Extension.create({
        name: 'reviewHighlights',
        addProseMirrorPlugins() {
          return [new Plugin({key:new PluginKey('reviewHighlights'),props:{decorations(state) {
            const marks = latest.current.getReview().comments
              .filter(c => (c.status === 'open' || latest.current.showResolved) && c.anchor.state === 'attached' && !c.anchor.target)
              .filter(c => c.anchor.from >= 0 && c.anchor.to <= state.doc.content.size && c.anchor.to > c.anchor.from)
              .map(c => {
                const node=state.doc.nodeAt(c.anchor.from);
                const attrs={'class':'comment-highlight','data-comment-id':c.id};
                return node?.isAtom && !node.isText && c.anchor.to===c.anchor.from+node.nodeSize
                  ? Decoration.node(c.anchor.from,c.anchor.to,attrs)
                  : Decoration.inline(c.anchor.from,c.anchor.to,attrs);
              });
            return DecorationSet.create(state.doc,marks);
          }}})];
        },
      }),
    ],
    content: adapter.current.content,
    editable: !props.readOnly,
    editorProps: {attributes: {'aria-label':'文章正文',class:'document-content',tabindex:'0'}},
    onCreate: ({editor}) => {liveEditor.current=editor;latest.current.onReady(editor);},
    onSelectionUpdate: ({editor,transaction}) => {
      if(transaction.getMeta(WHITEBOARD_COMPONENT_SELECTION))return;
      latest.current.onSelection(captureAnchor(editor.state.doc,editor.state.selection.from,editor.state.selection.to));
    },
    onTransaction: ({editor,transaction,appendedTransactions}) => {
      const transactions = [transaction,...appendedTransactions];
      if (loading.current || !transactions.some(change => change.docChanged)) return;
      try {
        const xml = adapter.current!.serialize(editor.getJSON());
        let comments = latest.current.getReview().comments;
        let pending = latest.current.getDraft();
        // Paste rules and table repairs can append edits after the initial transaction.
        for (const change of transactions) {
          comments = mapComments(comments,change);
          if (pending) pending = mapAnchor(pending,change);
        }
        lastXML.current = xml;
        latest.current.onEdit(xml,comments,pending);
      } catch (error) { latest.current.onError(error instanceof Error ? error.message : String(error)); }
    },
  });
  useEffect(() => { editor?.setEditable(!props.readOnly); },[editor,props.readOnly]);
  useEffect(() => {
    if (!editor || props.xml === lastXML.current) return;
    try {
      const next = parseDocxXML(props.xml);
      loading.current = true;
      // A new external revision starts fresh history; undo must never write the previous
      // document back over it. Reinitialize plugin state without emitting a local edit.
      editor.view.updateState(EditorState.create({
        schema: editor.schema,
        doc: editor.schema.nodeFromJSON(next.content),
        plugins: editor.state.plugins,
      }));
      adapter.current = next;
      lastXML.current = props.xml;
      setWarnings(next.warnings);
      latest.current.onSelection(null);
    } catch (error) { latest.current.onError(error instanceof Error ? error.message : String(error)); }
    finally { loading.current = false; }
  },[props.xml,editor]);
  useEffect(() => {
    if (!editor) return;
    const refresh=()=>applyWhiteboardComponentHighlights(editor,latest.current.getReview().comments,latest.current.showResolved);
    editor.view.dispatch(editor.state.tr.setMeta('reviewRefresh',true));
    refresh();
    editor.view.dom.addEventListener('whiteboard-preview-ready',refresh);
    editor.on('transaction',refresh);
    return()=>{editor.view.dom.removeEventListener('whiteboard-preview-ready',refresh);editor.off('transaction',refresh);};
  },[props.comments,props.showResolved,editor]);
  // Refresh only resource node views. A cache update is not an XML edit or reload.
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta(RESOURCE_REFRESH,true).setMeta('addToHistory',false)); },[resourceSignature,editor]);
  return <>
    {warnings.length > 0 && <details className="format-notice"><summary>部分内容以保留原稿的方式展示 · {warnings.length} 项</summary><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
    <EditorContent editor={editor}/>
  </>;
}
