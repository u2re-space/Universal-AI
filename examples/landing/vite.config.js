import { defineConfig } from 'vite';

// Chrome 157 Beta is the only target. esnext keeps the ES2026 syntax intact.
export default defineConfig({
    build: {
        target: 'esnext',
        cssTarget: 'chrome157',
    },
});
