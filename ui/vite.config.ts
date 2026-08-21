/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
      // Account-scoped UI state -> nixre-sync service (Vite matches the
      // more specific /api/sync prefix before the generic /api route).
      '/api/sync': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/git': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
