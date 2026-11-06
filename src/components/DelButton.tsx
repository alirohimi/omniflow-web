// ============================================================================
// DelButton — two-tap destructive action (mobile-first confirmation).
// First tap arms the button (turns red, "tap again to confirm"); a second
// tap within 2.5s confirms. Avoids native confirm() dialogs while protecting
// against accidental deletes. Replaces the old one-tap delete affordance.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { IClose } from '../icons';

export function DelButton({
  onConfirm,
  label,
}: {
  onConfirm: () => void;
  label: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 2500);
    return () => window.clearTimeout(timer.current);
  }, [armed]);

  return (
    <button
      className={`del${armed ? ' armed' : ''}`}
      title={armed ? 'Tap again to confirm' : label}
      aria-label={armed ? `Confirm: ${label}` : label}
      onClick={() => {
        if (armed) onConfirm();
        else setArmed(true);
      }}
    >
      <IClose size={16} />
    </button>
  );
}
