import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './source-editor.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  error?: string;
}

export function SourceEditor({ value, onChange, readOnly = false, error }: Props) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const characterCount = useMemo(() => Array.from(value).length, [value]);

  function updatePosition(element: HTMLTextAreaElement) {
    const offset = element.selectionDirection === 'backward' ? element.selectionStart : element.selectionEnd;
    const before = element.value.slice(0, offset);
    const lines = before.split('\n');
    const next = { line: lines.length, column: Array.from(lines.at(-1) || '').length + 1 };
    setPosition(previous => previous.line === next.line && previous.column === next.column ? previous : next);
  }
  useLayoutEffect(() => { if (textarea.current) updatePosition(textarea.current); }, [value]);

  return <div className="source-editor">
    {error && <p id={id + '-error'} className="source-editor-error" role="alert">{error}</p>}
    <textarea ref={textarea} aria-label="文档源码" aria-invalid={!!error}
      aria-describedby={error ? id + '-error' : undefined} value={value} readOnly={readOnly}
      wrap="soft" spellCheck={false} autoCapitalize="off" autoCorrect="off"
      onChange={event => {
        if (readOnly || event.currentTarget.matches(':disabled')) return;
        onChange(event.currentTarget.value);
        updatePosition(event.currentTarget);
      }}
      onSelect={event => updatePosition(event.currentTarget)} onClick={event => updatePosition(event.currentTarget)}
      onKeyUp={event => updatePosition(event.currentTarget)} onFocus={event => updatePosition(event.currentTarget)}/>
    <div className="source-editor-status">
      <span>第 {position.line} 行，第 {position.column} 列</span>
      <span>{characterCount.toLocaleString('zh-CN')} 字符</span>
    </div>
  </div>;
}
