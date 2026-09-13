import './segmented-control.css';

interface Choice<T extends string> { value: T; label: string; disabled?: boolean }
interface Props<T extends string> {
  label: string;
  value: T;
  options: readonly Choice<NoInfer<T>>[];
  disabled?: boolean;
  onChange(value: NoInfer<T>): void;
}

export const syncDirectionOptions = [
  { value: 'pull', label: '飞书 → 本地' },
  { value: 'push', label: '本地 → 飞书' },
] as const;

export function SegmentedControl<T extends string>({ label, value, options, disabled, onChange }: Props<T>) {
  return <div className="mode-switch segmented-control" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button"
      className={value === option.value ? 'selected' : ''} aria-pressed={value === option.value}
      disabled={disabled || option.disabled} onClick={() => { if (value !== option.value) onChange(option.value); }}>
      {option.label}
    </button>)}
  </div>;
}
