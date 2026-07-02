import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8211,
    proxy: {
      '/api': 'http://localhost:8210',
    },
  },
  build: {
    outDir: 'dist',
  },
});
