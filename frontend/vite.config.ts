import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Production build is served by FastAPI from backend/app/static.
// In dev (`npm run dev`), API calls are proxied to the backend on :8000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../backend/app/static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
})
