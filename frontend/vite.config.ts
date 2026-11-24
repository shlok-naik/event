import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In http mode the dev server proxies /api, /uploads and /ws to the backend (VITE_BACKEND_URL).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_BACKEND_URL || 'http://localhost:4000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': target,
        '/uploads': target,
        '/ws': { target, ws: true },
      },
    },
  };
});
