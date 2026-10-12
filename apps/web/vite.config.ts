import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // sqlite-wasm finds its .wasm beside its module, which pre-bundling would break.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  server: { port: 5173 },
});
