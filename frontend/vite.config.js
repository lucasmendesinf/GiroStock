import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // A loja virtual (pre-visualizacao e arquivos dela) nao e o sistema: o service worker nao responde por ela.
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/loja-previa\//, /^\/loja\//, /^\/loja-assets\//] },
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'GiroStock',
        short_name: 'GiroStock',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f0e10',
        theme_color: '#0f0e10',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
