import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const workerHealthInput = {
  'worker-health': resolve(import.meta.dirname, 'src/worker-health.ts')
};

const serviceInputs = {
  'bootstrap-admin': resolve(import.meta.dirname, 'src/bootstrap-admin.ts'),
  'cleanup-storage': resolve(import.meta.dirname, 'src/cleanup-storage.ts'),
  migrate: resolve(import.meta.dirname, 'src/migrate.ts'),
  'provision-database-roles': resolve(
    import.meta.dirname,
    'src/provision-database-roles.ts'
  ),
  'storage-volume-migration-helper': resolve(
    import.meta.dirname,
    'src/storage-volume-migration-entry.ts'
  ),
  'storage-volume-backup-helper': resolve(
    import.meta.dirname,
    'src/storage-volume-backup-entry.ts'
  ),
  worker: resolve(import.meta.dirname, 'src/worker.ts')
};

export default defineConfig(({ mode }) => {
  const workerHealthBuild = mode === 'worker-health';

  return {
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
      emptyOutDir: !workerHealthBuild,
      copyPublicDir: false,
      sourcemap: true,
      rolldownOptions: {
        input: workerHealthBuild ? workerHealthInput : serviceInputs,
        output: {
          codeSplitting: !workerHealthBuild,
          entryFileNames: '[name].js'
        }
      }
    }
  };
});
