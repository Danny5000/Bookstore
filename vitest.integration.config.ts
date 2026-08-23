import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/financial-migration.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true
  }
});
