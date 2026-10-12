import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the API/WebSocket live on the local Worker (npm run dev:worker).
const worker = process.env.MDW_WORKER_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: worker, ws: true, changeOrigin: false } } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'node' },
});
