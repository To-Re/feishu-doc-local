import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { readWhiteboardSource, replaceWhiteboardSource } from '../core/whiteboard-source';
import { attachWhiteboardPreview, type WhiteboardPreviewState } from './whiteboard-preview';
import { SourceDraftRecovery, useSourceDrafts, type SourceDraftSnapshot } from './source-drafts';

function readBoardSource(node: PMNode) {
  if (node.attrs.lrTag !== 'whiteboard' || !['protectedBlock', 'protectedInline'].includes(node.type.name) || typeof node.attrs.lrSource !== 'string') return null;
  const board = readWhiteboardSource(node.attrs.rawXML);
  if (!board) return null;
  return { id: node.type.name + ':' + node.attrs.lrSource, source: board.source, revision: String(node.attrs.rawXML), board };
}

/** Selection-only controls; applying source uses the normal document/history/save transaction. */
export function WhiteboardEditor({ editor, readOnly, onDraftChange, persistence }: { editor: Editor | null; readOnly: boolean; onDraftChange?: (dirty: boolean) => void; persistence?:{initial?:SourceDraftSnapshot;onChange?:(value:SourceDraftSnapshot)=>void} }) {
  const drafts = useSourceDrafts(editor, readBoardSource, onDraftChange, persistence);
  const { selected, value, changed, conflict, ambiguous } = drafts;
  const [preview, setPreview] = useState<{ xml: string; state: WhiteboardPreviewState } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const inputID = useId();
  const draft = useMemo(() => {
    if (!selected) return { xml: null, error: '' };
    try { return { xml: replaceWhiteboardSource(selected.source.revision, value), error: '' }; }
    catch (error) { return { xml: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [selected, value]);
  useEffect(() => {
    if (readOnly || !draft.xml || !container.current) return;
    const target = container.current;
    let dispose: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      dispose = attachWhiteboardPreview(target, draft.xml!, state => setPreview({ xml: draft.xml!, state }));
    }, 200);
    return () => { window.clearTimeout(timer); dispose?.(); };
  }, [draft.xml, readOnly]);
  if (!editor) return null;
  const ready = !!draft.xml && preview?.xml === draft.xml && preview.state === 'ready';
  return <>
    <SourceDraftRecovery kind="白板" drafts={drafts.recovery} onDiscard={drafts.discard}/>
    {drafts.count > drafts.recovery.length && (readOnly || !selected) && <p role="status">有未应用的白板修改。{readOnly ? '切回编辑模式后，' : ''}选中原白板可继续编辑。</p>}
    {!readOnly && selected && <form className="whiteboard-editor" onSubmit={event => {
    event.preventDefault();
    if (!changed || conflict || ambiguous || !ready || !draft.xml || !editor.isEditable) return;
    const selection = editor.state.selection;
    const live = selection instanceof NodeSelection ? readBoardSource(selection.node) : null;
    if (!(selection instanceof NodeSelection) || selection.from !== selected.position ||
      live?.id !== selected.source.id || live?.revision !== selected.source.revision) return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(selected.position, 'rawXML', draft.xml));
  }}>
    <label htmlFor={inputID}>{selected.source.board.type === 'mermaid' ? 'Mermaid 图源' : 'SVG 图源'}</label>
    <textarea id={inputID} spellCheck={false} data-review-draft={changed ? true : undefined} value={value} onChange={event => drafts.setValue(event.target.value)}/>
    <div className="whiteboard-editor-preview" ref={container} aria-label="白板修改预览"/>
    {draft.error && <p className="whiteboard-editor-error" role="status">{draft.error}</p>}
    {conflict && <p role="status">原白板已改变，草稿已保留。请复制草稿或还原为当前图源后继续。</p>}
    <div className="whiteboard-editor-actions"><button type="button" disabled={!changed} onClick={() => drafts.discard(selected.source.id)}>还原</button><button className="small-primary" disabled={!changed || conflict || ambiguous || !ready}>应用白板</button></div>
  </form>}</>;
}
