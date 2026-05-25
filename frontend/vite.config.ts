import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/app-assets/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Split the largest deps into their own chunks so the dashboard bundle
    // shrinks. recharts (~250kb) and leaflet (~150kb) are dashboard-only.
    rollupOptions: {
      output: {
        manualChunks: {
          recharts: ['recharts'],
          leaflet: ['leaflet', 'react-leaflet'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
