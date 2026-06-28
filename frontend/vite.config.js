import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Important: Ensures relative paths in the iframe build
  build: {
    outDir: 'assets',
    emptyOutDir: false, // Don't delete source assets if we run build repeatedly
    rollupOptions: {
      input: {
        iframe: resolve(__dirname, 'iframe.html')
      },
      output: {
        // Flatten output folder to avoid nested assets/assets/ directories
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    }
  },
  server: {
    port: 3000,
    cors: true
  }
});
