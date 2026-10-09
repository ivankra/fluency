import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Just enough typing for process.env, to avoid pulling in all of @types/node.
declare const process: { env: Record<string, string | undefined> }

// URL prefix the app is served under. Defaults to the site root; the Pages deploy sets
// BASE_PATH=/fluency/ (see .github/workflows/deploy.yml).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Fluency',
        short_name: 'Fluency',
        description: 'Fluency',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
