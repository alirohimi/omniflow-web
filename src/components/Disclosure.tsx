// ============================================================================
// Disclosure — mobile-first collapsible section.
//
// On coarse-pointer (phone) widths the body is collapsed behind a themed
// disclosure button, so dense config sections (create account, reserve
// lines/target, add holding) no longer stack five same-looking form blocks
// down the page. On fine pointers (desktop) it renders expanded with the
// toggle hidden — desktop keeps the full one-glance view.
// The open state is remembered per `id` in sessionStorage so a user who
// expanded a section gets it expanded again on the next visit.
//
// `forceOpen` (a number that changes) forces the body open + persists it,
// without resetting it closed later — used by "Edit" flows that must reveal
// a form the user may have manually collapsed.
// ============================================================================

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export function Disclosure({
  id,
  title,
  defaultOpen,
  forceOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  /** Bump this (e.g. a counter) to force the body open from outside. */
  forceOpen?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = sessionStorage.getItem(`disclosure:${id}`);
      if (v === '1' || v === '0') return v === '1';
    } catch { /* private mode / SSR: fall through */ }
    return !!defaultOpen;
  });

  useEffect(() => {
    if (forceOpen === undefined) return;
    setOpen(true);
    try { sessionStorage.setItem(`disclosure:${id}`, '1'); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { sessionStorage.setItem(`disclosure:${id}`, next ? '1' : '0'); } catch { /* ignore */ }
  };

  return (
    <section className="disclosure">
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{title}</span>
        <span className="disclosure-chev" aria-hidden="true" />
      </button>
      <div className="disclosure-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
