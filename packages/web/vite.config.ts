import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const pkg = (name: string): string => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@rd/protocol': pkg('protocol'),
      '@rd/crypto': pkg('crypto'),
      '@rd/p2p': pkg('p2p'),
      '@rd/library': pkg('library'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Yjs и крипто-разбор меняются редко и весят больше всего. Выносим их
        // в отдельные чанки: правка UI не должна заставлять заново качать
        // полмегабайта синхронизации.
        manualChunks: {
          yjs: ['yjs', 'y-protocols/sync', 'y-protocols/awareness', 'lib0/encoding', 'lib0/decoding'],
          crypto: ['@rd/crypto'],
          books: ['fflate', 'fast-xml-parser'],
        },
      },
    },
  },
});
