import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { ReviewProject } from '../core/projects';
import './project-picker.css';

interface Props {
  projects: ReviewProject[];
  active?: ReviewProject;
  disabled: boolean;
  onSwitch(id: string): void;
}
interface Position { top: number; left: number; width: number; maxHeight: number; }

export function ProjectPicker({ projects, active, disabled, onSwitch }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>(active?.id);
  const [position, setPosition] = useState<Position | null>(null);
  const highlightedIndex = projects.findIndex(project => project.id === highlighted);
  const optionId = (index: number) => id + '-option-' + index;

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    if (disabled || !projects.length) return;
    setHighlighted(projects.find(project => project.id === active?.id)?.id || projects[0]?.id);
    setOpen(true);
  }
  function choose(projectId: string) {
    if (disabled || !projects.some(project => project.id === projectId)) return;
    close(true);
    // The title remains controlled by the accepted active project. A rejected
    // switch must never make the picker claim another document is open.
    onSwitch(projectId);
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    if (event.key === 'Tab') {
      if (popup.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      close();
      return;
    }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close(true); }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && highlighted) choose(highlighted); else show();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) {
        show();
        if (event.key === 'Home') setHighlighted(projects[0]?.id);
        if (event.key === 'End') setHighlighted(projects.at(-1)?.id);
        return;
      }
      if (!projects.length) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? projects.length - 1 :
        Math.max(0, Math.min(projects.length - 1, highlightedIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setHighlighted(projects[next].id);
    }
  }
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => { close(); }, [active?.id]);
  useEffect(() => {
    if (open && !projects.some(project => project.id === highlighted))
      setHighlighted(projects.find(project => project.id === active?.id)?.id || projects[0]?.id);
  }, [open, projects, highlighted, active?.id]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const measure = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.max(0, Math.min(Math.max(320, rect.width), window.innerWidth - 24));
      const next = { top: rect.bottom + 5, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        width, maxHeight: Math.max(0, Math.min(320, window.innerHeight - rect.bottom - 17)) };
      setPosition(previous => previous && Object.keys(next).every(key => previous[key as keyof Position] === next[key as keyof Position]) ? previous : next);
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(trigger.current);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); observer?.disconnect(); };
  }, [open]);
  useLayoutEffect(() => {
    if (open && position && highlightedIndex >= 0)
      popup.current?.children[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, !!position, highlightedIndex]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.current?.contains(target) || popup.current?.contains(target));
    const pointerDown = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const focusIn = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('focusin', focusIn);
    return () => { document.removeEventListener('pointerdown', pointerDown, true); document.removeEventListener('focusin', focusIn); };
  }, [open]);

  return <div className="project-picker">
    <button ref={trigger} type="button" className="project-picker-trigger" role="combobox" aria-label="当前项目" aria-describedby={id + '-value'}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id + '-list' : undefined}
      aria-activedescendant={open && highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined}
      disabled={disabled || !projects.length}
      onClick={() => open ? close() : show()} onKeyDown={keyDown}>
      <span className="project-picker-name" id={id + '-value'}>{active?.name || '选择项目'}</span>
      <span className="project-picker-action" aria-hidden="true">切换项目<ChevronDown size={14}/></span>
    </button>
    {open && position && createPortal(<div ref={popup} id={id + '-list'} className="project-picker-list" role="listbox" aria-label="项目列表"
      tabIndex={-1} style={position} onKeyDown={keyDown}>
      {projects.map((project, index) => <button key={project.id} id={optionId(index)} type="button" role="option" tabIndex={-1}
        aria-label={project.name} aria-describedby={optionId(index) + '-path'} aria-selected={project.id === active?.id}
        className={'project-picker-option' + (project.id === highlighted ? ' highlighted' : '')}
        onPointerMove={() => setHighlighted(project.id)} onMouseDown={event => event.preventDefault()} onClick={() => choose(project.id)}>
        <span className="project-picker-option-text"><span className="project-picker-option-name">{project.name}</span>
          <span className="project-picker-option-path" id={optionId(index) + '-path'} title={project.localPath}>{project.localPath}</span></span>
        {project.id === active?.id && <span className="project-picker-current" aria-hidden="true"><Check size={14}/>当前</span>}
      </button>)}
    </div>, document.body)}
  </div>;
}
