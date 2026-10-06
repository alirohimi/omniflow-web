// ============================================================================
// Toast — lightweight action feedback (saved / deleted / account ops).
// Stacks above the tab bar, auto-dismisses, aria-live for screen readers.
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Kind = 'ok' | 'err';
interface Item { id: number; msg: string; kind: Kind }

const Ctx = createContext<{ toast: (msg: string, kind?: Kind) => void }>({
  toast: () => {},
});

export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((msg: string, kind: Kind = 'ok') => {
    const id = ++idRef.current;
    setItems((p) => [...p, { id, msg, kind }]);
    window.setTimeout(
      () => setItems((p) => p.filter((t) => t.id !== id)),
      2400,
    );
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
