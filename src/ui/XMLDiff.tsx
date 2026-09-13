import { useEffect, useMemo, useRef, useState } from 'react';
import { buildXMLDiff } from '../core/xml-diff';
import './xml-diff.css';

interface Props { before: string; after: string; beforeLabel: string; afterLabel: string; }
type Result = ReturnType<typeof buildXMLDiff>;
type Line = NonNullable<Result['rows'][number]['before']>;
type Mode = 'split' | 'unified';
type Entry = { kind: 'row'; index: number } | { kind: 'fold'; start: number; end: number };
const PAGE_SIZE = 400;
const CONTEXT = 3;
const NO_EXPANDED = new Set<string>();

function changedPart(text: string, key: number) {
  if (!text || !/^[ \t\r\n]+$/.test(text)) return <mark key={key}>{text}</mark>;
  const names = [[' ', '空格'], ['\t', '制表符'], ['\r', '回车'], ['\n', '换行']] as const;
  const description = '空白改动：' + names.map(([character, name]) => {
    const count = text.split(character).length - 1;
    return count ? `${name} × ${count}` : '';
  }).filter(Boolean).join('，');
  const symbols: Record<string, string> = { ' ': '·', '\t': '⇥', '\r': '␍', '\n': '↵' };
  const preview = Array.from(text.slice(0, 24), character => symbols[character]).join('') + (text.length > 24 ? '…' : '');
  return <mark key={key} className="xml-diff-whitespace" data-whitespace={preview} aria-label={description} title={description}>
    <span className="xml-diff-whitespace-source">{text}</span>
  </mark>;
}

function visibleEntries(result: Result, expanded: Set<string>): Entry[] {
  const entries: Entry[] = [];
  for (let index = 0; index < result.rows.length;) {
    if (result.rows[index].kind !== 'equal') { entries.push({ kind: 'row', index: index++ }); continue; }
    const start = index;
    while (index < result.rows.length && result.rows[index].kind === 'equal') index++;
    const end = index;
    if (end - start <= CONTEXT * 2 || expanded.has(start + ':' + end)) {
      for (let row = start; row < end; row++) entries.push({ kind: 'row', index: row });
    } else {
      for (let row = start; row < start + CONTEXT; row++) entries.push({ kind: 'row', index: row });
      entries.push({ kind: 'fold', start, end });
      for (let row = end - CONTEXT; row < end; row++) entries.push({ kind: 'row', index: row });
    }
  }
  return entries;
}

function Cell({ line, kind, unified = false, beforeNumber, afterNumber }: {
  line?: Line; kind: 'equal' | 'removed' | 'added' | 'empty'; unified?: boolean; beforeNumber?: number; afterNumber?: number;
}) {
  const sign = kind === 'removed' ? '-' : kind === 'added' ? '+' : '';
  return <div className={'xml-diff-line xml-diff-' + kind + (unified ? ' xml-diff-unified-line' : '')}>
    <span className="xml-diff-number" aria-hidden="true" title="按 XML 块分行">{unified ? beforeNumber : line?.number}</span>
    {unified && <span className="xml-diff-number" aria-hidden="true" title="按 XML 块分行">{afterNumber}</span>}
    <span className="xml-diff-sign" aria-label={kind === 'removed' ? '删除' : kind === 'added' ? '新增' : undefined}>{sign}</span>
    <code>{line?.parts.map((part, index) => part.changed && kind !== 'equal'
      ? changedPart(part.text, index) : <span key={index}>{part.text}</span>)}</code>
  </div>;
}

export function XMLDiff({ before, after, beforeLabel, afterLabel }: Props) {
  const result = useMemo(() => buildXMLDiff(before, after), [before, after]);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720);
  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const mode = chosenMode || (narrow ? 'unified' : 'split');
  const [view, setView] = useState<{ result: Result; expanded: Set<string>; page: number }>(() => ({ result, expanded: new Set(), page: 0 }));
  // A fresh comparison starts collapsed on page one; it must not inherit row indexes from the previous document.
  const expanded = view.result === result ? view.expanded : NO_EXPANDED;
  const entries = useMemo(() => visibleEntries(result, expanded), [result, expanded]);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = view.result === result ? Math.min(view.page, pages - 1) : 0;
  const rows = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [result, page]);
  function expand(entry: Extract<Entry, { kind: 'fold' }>) {
    setView({ result, expanded: new Set(expanded).add(entry.start + ':' + entry.end), page });
    scroll.current?.focus({ preventScroll: true });
  }
  function goTo(next: number) {
    setView({ result, expanded, page: next });
    scroll.current?.scrollIntoView?.({ block: 'start' });
    scroll.current?.focus({ preventScroll: true });
  }
  const labels = <div className="xml-diff-labels"><strong>{mode === 'unified' && '- '}{beforeLabel}</strong><strong>{mode === 'unified' && '+ '}{afterLabel}</strong></div>;

  return <section className={'xml-diff xml-diff-' + mode} aria-label="XML 正文差异">
    <div className="xml-diff-toolbar">
      <div className="xml-diff-modes" role="group" aria-label="差异显示方式">
        <button type="button" aria-pressed={mode === 'split'} onClick={() => setChosenMode('split')}>左右</button>
        <button type="button" aria-pressed={mode === 'unified'} onClick={() => setChosenMode('unified')}>合并</button>
      </div>
      {!(result.limited && !result.rows.length) && <div className="xml-diff-counts" aria-label="改动行数">
        <span className="xml-diff-added-count">+{result.added} 新增</span><span className="xml-diff-removed-count">-{result.removed} 删除</span>
        <small>按 XML 块分行</small>
      </div>}
    </div>
    {(!result.rows.length || result.identical) && labels}
    {result.limited && <p className="xml-diff-notice" role="status">{result.notice || '差异计算已达到处理上限，请展开「查看完整原文」。'}</p>}
    {result.identical ? <p className="xml-diff-identical" role="status">正文内容相同</p> : result.rows.length > 0 && <>
      <div className="xml-diff-scroll" ref={scroll} tabIndex={0} role="region" aria-label="可滚动的正文差异">
        {labels}
        {rows.map(entry => {
          if (entry.kind === 'fold') return <div className="xml-diff-fold" key={'fold:' + entry.start}>
            <button type="button" onClick={() => expand(entry)}>展开 {entry.end - entry.start - CONTEXT * 2} 行相同内容</button>
          </div>;
          const row = result.rows[entry.index];
          return <div className="xml-diff-row" key={entry.index} data-diff-row={entry.index} data-kind={row.kind}>
            {mode === 'split' ? <>
              <Cell line={row.before} kind={!row.before ? 'empty' : row.kind === 'equal' ? 'equal' : 'removed'}/>
              <Cell line={row.after} kind={!row.after ? 'empty' : row.kind === 'equal' ? 'equal' : 'added'}/>
            </> : row.kind === 'equal'
              ? <Cell line={row.after || row.before} kind="equal" unified beforeNumber={row.before?.number} afterNumber={row.after?.number}/>
              : <>{row.before && <Cell line={row.before} kind="removed" unified beforeNumber={row.before.number}/>}
                {row.after && <Cell line={row.after} kind="added" unified afterNumber={row.after.number}/>}</>}
          </div>;
        })}
      </div>
      {pages > 1 && <nav className="xml-diff-pages" aria-label="差异分段">
        <button type="button" disabled={page === 0} onClick={() => goTo(page - 1)}>上一段</button>
        <span>第 {page + 1} / {pages} 段 · 每段最多 {PAGE_SIZE} 行</span>
        <button type="button" disabled={page === pages - 1} onClick={() => goTo(page + 1)}>下一段</button>
      </nav>}
    </>}
  </section>;
}
