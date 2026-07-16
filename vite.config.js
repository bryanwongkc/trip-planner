import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
        globIgnores: ['**/fonts/**'],
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.filter(
              (entry) => !/(?:jspdf|html2canvas|purify)\b/i.test(entry.url),
            ),
            warnings: [],
          }),
        ],
      },
    }),
  ],
})
