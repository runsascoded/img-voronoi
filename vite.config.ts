import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5184,
    host: true,
    allowedHosts,
  },

  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
