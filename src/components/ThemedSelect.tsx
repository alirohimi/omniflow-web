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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuPos, setMenuPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));

  // Reset highlight to the selected option whenever the dropdown opens.
  useEffect(() => {
    if (open) setHi(selectedIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Position the ported menu above or below the trigger based on available
  // viewport space, clamping width/left/maxHeight so the last option is
  // always reachable via scroll on both desktop and mobile viewports.
  useLayoutEffect(() => {
    if (!open || !rootRef.current) { setMenuPos(null); return; }
    const updatePos = () => {
      if (!rootRef.current) return;
      const trigger = rootRef.current.querySelector<HTMLButtonElement>('.tsel-trigger');
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 12;
      const gap = 6;
      const width = Math.min(Math.max(r.width, 180), vw - 16);
      const left = Math.max(8, Math.min(r.left, vw - width - 8));
      const spaceBelow = vh - r.bottom - pad - gap;
      const spaceAbove = r.top - pad - gap;
      const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
      const available = openUp ? spaceAbove : spaceBelow;
      const maxHeight = Math.max(120, Math.min(280, Math.floor(available)));
      setMenuPos(
        openUp
          ? { left, bottom: vh - r.top + gap, width, maxHeight }
          : { left, top: r.bottom + gap, width, maxHeight },
      );
    };
    updatePos();
    window.addEventListener('scroll', updatePos, { passive: true, capture: true });
    window.addEventListener('resize', updatePos, { passive: true });
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open]);

  // Scroll the currently selected option into view when opening.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current.querySelectorAll<HTMLElement>('.tsel-opt')[selectedIdx];
    el?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click/tap-outside + Escape close. Uses pointerdown so touch taps on
  // mobile close the menu immediately without waiting for mouse compatibility.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (rootRef.current && rootRef.current.contains(target)) return;
      if (target.closest?.('[data-tsel-menu]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
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

  const menu = open ? (
    <ul
      ref={menuRef}
      role="listbox"
      data-tsel-menu=""
      className="tsel-menu"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        left: menuPos?.left ?? 0,
        top: menuPos?.top,
        bottom: menuPos?.bottom,
        width: menuPos?.width ?? 240,
        maxHeight: menuPos?.maxHeight ?? 280,
      }}
    >
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
  ) : null;

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
      {/* Portal the menu to document.body so it floats above every other
          section/card regardless of surrounding stacking contexts — this is
          what fixes the strategy dropdown bleeding over the "Accounts"
          disclosure and other content below it. */}
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export default ThemedSelect;
