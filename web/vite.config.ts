import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Backend default port is assumed to be 4000 (no docs/SETUP.md exists yet).
// Override with VITE_API_PROXY in web/.env.local, e.g. VITE_API_PROXY=http://localhost:3000
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_PROXY || 'http://localhost:4000'
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/api': { target, changeOrigin: true },

      },
    },
  }
})
