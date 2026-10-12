import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'test' ? [vue()] : [])],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
      },
    },
  },
  test: {
    environment: 'jsdom',
    maxWorkers: 4,
    include: [
      'src/tests/**/*.spec.ts',
      'src/react/**/*.test.{ts,tsx}',
      'src/react/**/*.spec.{ts,tsx}',
    ],
  },
}))
