import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server must listen on the LAN; proxy API + WebSocket to the Rust backend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8088',
      '/ws': { target: 'http://127.0.0.1:8088', ws: true },
    },
  },
});
