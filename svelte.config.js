import adapter from '@sveltejs/adapter-node';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/** @param {string} left @param {string} right */
function sameResolvedPath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** @param {NodeJS.ProcessEnv} [environment] */
export function e2eEnvironmentDirectory(environment = process.env) {
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

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    ...(emptyE2EEnvironmentDirectory === undefined
      ? {}
      : { env: { dir: emptyE2EEnvironmentDirectory } })
  }
};

export default config;
