import { defineConfig } from 'vite';

// Chromium 156 based browser is the only target. esnext keeps the ES2026 syntax intact.
export default defineConfig({
    build: {
        target: 'esnext',
        cssTarget: 'chrome156',
    },
});
