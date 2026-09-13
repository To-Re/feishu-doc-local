import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';

export interface SourceValue { id: string; source: string; revision: string; }
export interface SourceDraft { value: string; revision: string; }
export type SourceDraftSnapshot = Array<[string, SourceDraft]>;
type Selected<T> = { position: number; source: T };

/** Draft identity belongs to a source node, never its current document offset. */
export function useSourceDrafts<T extends SourceValue>(editor: Editor | null, readSource: (node: PMNode) => T | null,
  onDraftChange?: (dirty: boolean) => void, persistence?: {initial?:SourceDraftSnapshot;onChange?:(value:SourceDraftSnapshot)=>void}) {
  const drafts = useRef(new Map<string, SourceDraft>(persistence?.initial));
  const persisted = useRef(persistence);persisted.current=persistence;
  const callback = useRef(onDraftChange); callback.current = onDraftChange;
  const [view, setView] = useState<{ selected: Selected<T> | null; nodes: Map<string, Selected<T>[]> }>({ selected: null, nodes: new Map() });
  const [, update] = useState(0);
  function notify() { callback.current?.(drafts.current.size > 0); persisted.current?.onChange?.([...drafts.current]); update(value => value + 1); }
  useEffect(() => {
    drafts.current=new Map(persisted.current?.initial); callback.current?.(drafts.current.size>0);
    if (!editor) { setView({ selected: null, nodes: new Map() }); return; }
    const sync = () => {
      const nodes = new Map<string, Selected<T>[]>();
      editor.state.doc.descendants((node, position) => {
        const source = readSource(node);
        if (source) nodes.set(source.id, [...(nodes.get(source.id) || []), { position, source }]);
      });
      for (const [id, draft] of drafts.current) {
        const matches = nodes.get(id);
        // Applying a draft (including undo/redo) goes through the normal document transaction.
        if (matches?.length === 1 && matches[0].source.source === draft.value) drafts.current.delete(id);
      }
      const selection = editor.state.selection;
      const source = selection instanceof NodeSelection ? readSource(selection.node) : null;
      setView({ nodes, selected: source ? { position: selection.from, source } : null });
      callback.current?.(drafts.current.size > 0);
      persisted.current?.onChange?.([...drafts.current]);
    };
    editor.on('transaction', sync); sync();
    return () => { editor.off('transaction', sync); callback.current?.(false); };
  }, [editor, readSource]);

  const selected = view.selected;
  const stored = selected ? drafts.current.get(selected.source.id) : undefined;
  const ambiguous = !!selected && view.nodes.get(selected.source.id)?.length !== 1;
  const conflict = !!stored && stored.revision !== selected?.source.revision;
  const recovery = [...drafts.current].filter(([id]) => view.nodes.get(id)?.length !== 1)
    .map(([id, draft]) => ({ id, value: draft.value, ambiguous: (view.nodes.get(id)?.length || 0) > 1 }));
  return {
    selected, value: stored?.value ?? selected?.source.source ?? '', changed: !!stored, conflict, ambiguous,
    count: drafts.current.size, recovery,
    setValue(value: string) {
      if (!selected) return;
      if (value === selected.source.source) drafts.current.delete(selected.source.id);
      else drafts.current.set(selected.source.id, { value, revision: stored?.revision ?? selected.source.revision });
      notify();
    },
    discard(id: string) { drafts.current.delete(id); notify(); },
  };
}

export function SourceDraftRecovery({ kind, drafts, onDiscard }: {
  kind: string; drafts: Array<{ id: string; value: string; ambiguous: boolean }>; onDiscard: (id: string) => void;
}) {
  return <>{drafts.map(draft => <div className="source-draft-recovery" key={draft.id} role="status">
    <p>{draft.ambiguous ? `原${kind}的身份不唯一，已暂停应用。` : `原${kind}已不在正文中，可撤销删除后继续。`}未应用草稿已保留。</p>
    <textarea aria-label={`${kind}保留的草稿`} readOnly value={draft.value}/>
    <button type="button" onClick={() => onDiscard(draft.id)}>丢弃{kind}草稿</button>
  </div>)}</>;
}
