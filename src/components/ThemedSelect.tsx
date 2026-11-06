// ============================================================================
// OmniFlow — ThemedSelect: the app's one custom dropdown control.
//
// Replaces every native <select> (Task 010 P2 #9: 21 instances). Native
// selects are OS-chromed, not themed — the whole point of this component is
// a glass-styled trigger + a bottom-anchored option card that matches the
// rest of the app's design language.
//
// API mirrors the native element's value/onChange contract so every call
// site is a drop-in swap:
//   <ThemedSelect value="USD" onChange={(v) => setCur(v)} options={[...]} />
//
// Options are passed as data (not children) so the component can render
// its own rows, manage open/close, click-outside, and Escape — none of
// which a native <select> lets you style.
//
// Keyboard: Enter/Space open, ArrowUp/Down move the highlight, Enter
// selects the highlighted option, Escape closes. Rows are >=44px (HIG).
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ICheck } from '../icons';

export interface ThemedOption {
  value: string;
  /** Visible label. `node` wins when provided (e.g. icon + name). */
  label: string;
  node?: ReactNode;
  disabled?: boolean;
}

export interface ThemedSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ThemedOption[];
  /** Visible text on the trigger when value has no matching option
   *  (e.g. empty-string placeholder). */
  placeholder?: string;
  /** Compact variant for dense table rows (Expense Import): smaller trigger
   *  that does NOT force the 48px form-field min-height. */
  compact?: boolean;
  'aria-label'?: string;
  disabled?: boolean;
}

/** Find the label to show on the trigger for the current value. */
function triggerLabel(options: ThemedOption[], value: string, placeholder?: string): string {
  if (value === '' && placeholder) return placeholder;
  const opt = options.find((o) => o.value === value);
  return opt ? opt.label : (value || placeholder || 'Select…');
}

export function ThemedSelect({
  value,
  onChange,
  options,
  placeholder,
  compact = false,
  disabled,
  'aria-label': ariaLabel,
}: ThemedSelectProps) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0); // highlighted option index (keyboard)
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));

  // Reset highlight to the selected option whenever the dropdown opens.
  useEffect(() => {
    if (open) setHi(selectedIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click-outside + Escape close. One document listener, removed on close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (o: ThemedOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[hi];
      if (o) pick(o);
    }
  };

  const showLabel = triggerLabel(options, value, placeholder);

  return (
    <div
      ref={rootRef}
      className={`tsel${compact ? ' tsel-compact' : ''}${open ? ' tsel-open' : ''}`}
      style={compact ? { width: '100%', maxWidth: compact ? 110 : undefined } : undefined}
    >
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        className="tsel-trigger"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="tsel-value" data-empty={showLabel === (placeholder || 'Select…') ? '' : undefined}>
          {showLabel}
        </span>
        <span className="tsel-caret" aria-hidden="true">
          <svg width="11" height="7" viewBox="0 0 12 8" fill="none" aria-hidden="true">
            <path d="M1 1.5l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <ul role="listbox" className="tsel-menu" aria-label={ariaLabel}>
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isHi = i === hi;
            return (
              <li
                key={o.value || `i${i}`}
                role="option"
                aria-selected={isSel}
                className={`tsel-opt${isHi ? ' hi' : ''}${isSel ? ' sel' : ''}${o.disabled ? ' dis' : ''}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o)}
              >
                <span className="tsel-opt-lbl">
                  {o.node ?? o.label}
                </span>
                {isSel && <ICheck size={14} className="tsel-opt-check" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ThemedSelect;
