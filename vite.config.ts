import { sveltekit } from '@sveltejs/kit/vite';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { defineConfig } from 'vite';

function sameResolvedPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function e2eEnvironmentDirectory(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const isolation = environment.PALE_ORBIT_E2E_ENV_ISOLATION;
  const configuredDirectory = environment.PALE_ORBIT_E2E_EMPTY_ENV_DIR;
  if (isolation === undefined && configuredDirectory === undefined) {
    return undefined;
  }
  if (
    isolation !== '1' ||
    configuredDirectory === undefined ||
    !isAbsolute(configuredDirectory)
  ) {
    throw new Error('Invalid E2E environment isolation configuration');
  }

  const directory = resolve(configuredDirectory);
  const ownedRoot = dirname(directory);
  const temporaryRoot = resolve(tmpdir());
  if (
    !sameResolvedPath(directory, configuredDirectory) ||
    basename(directory) !== 'dotenv-empty' ||
    !sameResolvedPath(dirname(ownedRoot), temporaryRoot) ||
    !/^pale-orbit-test-storage-[A-Za-z0-9-]+$/u.test(basename(ownedRoot))
  ) {
    throw new Error('Invalid E2E environment isolation configuration');
  }

  const ownedRootStatus = lstatSync(ownedRoot);
  const directoryStatus = lstatSync(directory);
  if (
    !ownedRootStatus.isDirectory() ||
    ownedRootStatus.isSymbolicLink() ||
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    !sameResolvedPath(resolve(realpathSync(ownedRoot)), ownedRoot) ||
    !sameResolvedPath(resolve(realpathSync(directory)), directory) ||
    readdirSync(directory).length !== 0
  ) {
    throw new Error('Invalid E2E environment isolation configuration');
  }
  return directory;
}

const emptyE2EEnvironmentDirectory = e2eEnvironmentDirectory();

export default defineConfig({
  ...(emptyE2EEnvironmentDirectory === undefined
    ? {}
    : { envDir: emptyE2EEnvironmentDirectory }),
  plugins: [sveltekit()]
});
