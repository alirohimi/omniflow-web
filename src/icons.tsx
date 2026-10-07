// ============================================================================
// OmniFlow — icon set. Clean 24px line icons (stroke = currentColor) used in
// place of emoji chrome so the UI reads as a designed product, not a template.
// Keep them minimal; they inherit size from CSS (.ico) and color from context.
// ============================================================================

import type { ReactNode } from 'react';

type P = { size?: number; className?: string; strokeWidth?: number };

const S = ({
  children,
  size = 20,
  className = 'ico',
  strokeWidth = 1.7,
}: P & { children: ReactNode }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

// ---- navigation -------------------------------------------------------
export const IHome = (p: P) => (
  <S {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
  </S>
);

export const IWallet = (p: P) => (
  <S {...p}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 16.5v-9Z" />
    <path d="M4 9.5h16" />
    <path d="M15 14.5h3" />
  </S>
);

export const ITrend = (p: P) => (
  <S {...p}>
    <path d="M3 17.5 9 11l4 4 6.5-7" />
    <path d="M16.5 8h3v3" />
  </S>
);

export const IGear = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1 5.3 5.3" />
  </S>
);

// ---- actions / state --------------------------------------------------
export const IPlus = (p: P) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
);

export const IRefresh = (p: P) => (
  <S {...p}>
    <path d="M4.5 12a7.5 7.5 0 0 1 12.7-5.3L20 9" />
    <path d="M20 4.5V9h-4.5" />
    <path d="M19.5 12a7.5 7.5 0 0 1-12.7 5.3L4 15" />
    <path d="M4 19.5V15h4.5" />
  </S>
);

export const IPencil = (p: P) => (
  <S {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7.5 16.5 4 17.5 5 14z" />
  </S>
);

export const IX = (p: P) => (
  <S {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </S>
);

export const IShield = (p: P) => (
  <S {...p} size={p.size ?? 40}>
    <path d="M12 3 5 6v6c0 4.2 2.9 7.5 7 9 4.1-1.5 7-4.8 7-9V6l-7-3Z" />
    <path d="M9.2 12.3 11.3 14.4l3.6-4" />
  </S>
);

export const IScan = (p: P) => (
  <S {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M4 12h16" />
  </S>
);

export const IReceipt = (p: P) => (
  <S {...p}>
    <path d="M6 3.5h12v16l-2.4-1.4L13 20.5 11 19.1l-2.6 1.4-2.4-1.4V3.5Z" />
    <path d="M9 8h6M9 11.5h6M9 15h4" />
  </S>
);

export const IChevron = (p: P) => (
  <S {...p}>
    <path d="M9 6l6 6-6 6" />
  </S>
);

export const IClose = (p: P) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </S>
);

export const ILock = (p: P) => (
  <S {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <path d="M12 14.5v2" />
  </S>
);

export const IUser = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5 19.5a7 7 0 0 1 14 0" />
  </S>
);
