import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Base is auto-detected: for GitHub Pages the base is the repo name; we set it
// explicitly to '/' and let CI rewrite it if needed. For a subpath deploy
// (alirohimi.github.io/omniflow-web) set BASE in CI or run with --base.
export default defineConfig({
  base: process.env.BASE_URL || '/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // CI runners are slow: the async vault tests (store-extended, vault-race)
    // use real timers + polling; the default 5s testTimeout can be exceeded on
    // a cold runner even with 10s internal waits. 30s absorbs the slack.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  build: {
    sourcemap: false,
    target: 'es2020',
  },
});
