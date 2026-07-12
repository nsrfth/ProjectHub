import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // v2.5.56: SELF-DESTROYING service worker. A very old cached worker (from
      // before /api was NetworkOnly) was intercepting /api/* and returning empty
      // documents — blanking the dashboard / teams list — and normal SW updates
      // (autoUpdate, then prompt) failed to evict it. `selfDestroying` generates a
      // worker that unregisters itself and wipes its caches on the next visit,
      // cleaning every client automatically with no manual cache-clearing. This
      // disables offline/installability (not needed for this internal tool) and
      // removes the whole stale-SW bug class: with no worker, browsers just fetch
      // fresh assets (index.html is Cache-Control: no-cache via Caddy). A
      // properly-tested PWA can be reintroduced later if ever wanted.
      selfDestroying: true,
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'ProjectHub',
        short_name: 'ProjectHub',
        description: 'Team task management — projects, kanban, and collaboration.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#ffffff',
        theme_color: '#6366f1',
        lang: 'en',
        dir: 'ltr',
        icons: [
          {
            src: 'icons/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'PUT',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'PATCH',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'DELETE',
          },
          {
            urlPattern: ({ request }) => request.destination === 'script' || request.destination === 'style',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'taskhub-static',
              expiration: { maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: ({ request }) =>
              request.destination === 'font' || request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'taskhub-assets',
              expiration: { maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev convenience: proxy /api to the backend so we don't need CORS in dev.
      '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
