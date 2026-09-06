/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` rather than the CJS `__dirname`: Vite 8's native
// config loader cannot evaluate the latter and warns on every run.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
  server: {
    port: 5173,
    proxy: {
      // All API traffic flows through nixre-core (auth + sync owned there;
      // not-yet-migrated endpoints are proxied by core to Gitness).
      '/api': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
      '/git': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
