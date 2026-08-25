import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    environment: 'node',
    include: ['tests/service/financial-restore-witness.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true
  }
});
