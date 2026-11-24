import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In http mode the dev server proxies /api/* (REST, media, WebSocket) to the backend (VITE_BACKEND_URL), stripping the prefix.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_BACKEND_URL || 'http://localhost:8000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // the backend has no /api prefix; the frontend always calls /api/... and the proxy strips it (REST, /media and /ws)
        '/api': { target, ws: true, rewrite: (p) => p.replace(/^\/api/, '') },
      },
    },
  };
});
