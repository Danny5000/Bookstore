import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  ssr: {
    external: true
  },
  build: {
    ssr: true,
    target: 'node26',
    outDir: 'build/services',
    emptyOutDir: true,
    copyPublicDir: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        'bootstrap-admin': resolve(import.meta.dirname, 'src/bootstrap-admin.ts'),
        migrate: resolve(import.meta.dirname, 'src/migrate.ts'),
        worker: resolve(import.meta.dirname, 'src/worker.ts')
      },
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
});
