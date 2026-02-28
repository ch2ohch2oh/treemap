import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // When deploying to GitHub Pages, set VITE_BASE_URL to /<repo-name>/
  base: process.env.VITE_BASE_URL ?? '/',
})
