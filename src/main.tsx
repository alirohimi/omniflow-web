// ============================================================================
// OmniFlow — entry point.
// ============================================================================

import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <App />,
);

// Service worker: offline app-shell (prod only; dev has no sw.js at root).
// sw.js lives at the deploy root (Vite copies public/), not in assets/ —
// so resolve it from BASE_URL, not from this module's own URL.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const swUrl = new URL(import.meta.env.BASE_URL.replace(/\/$/, '') + '/sw.js', window.location.href);
    navigator.serviceWorker
      .register(swUrl)
      .catch(() => {
        /* offline caching is a bonus, never block the app */
      });
    // Self-heal: the SW (skipWaiting + clients.claim) takes control the
    // moment a newer deploy activates. Force one reload so the running
    // page drops stale cached hashed assets and re-fetches the new
    // bundle. Without this, a device can keep serving an old build.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  });
}
