import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],

  server: {
    port: 8076,
    host: true,
    allowedHosts,
  },

  resolve: {
    alias: {
      '@': '/src',
      'voronoi-wasm': '/cli/voronoi-wasm/pkg',
    },
  },
})
