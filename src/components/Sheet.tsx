import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

// ============================================================================
// Modal — themed overlay + bottom sheet (auto) or centered card (desktop).
// ============================================================================

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Focus management + Escape + body scroll lock while open.
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => headRef.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-wrap"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3 ref={headRef} tabIndex={-1}>{title}</h3>
          <button type="button" className="btn ghost sm modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
