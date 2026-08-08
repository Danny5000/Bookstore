import { readFileSync } from 'node:fs';

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;
export type SecretFileReader = (path: string) => string;

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

const readUtf8File: SecretFileReader = (path) => readFileSync(path, 'utf8');

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export function readRequiredSetting(
  source: EnvironmentValues,
  name: string,
  readSecretFile: SecretFileReader = readUtf8File
): string {
  const directValue = source[name];
  const fileName = `${name}_FILE`;
  const secretPath = source[fileName];

  if (directValue !== undefined && secretPath !== undefined) {
    throw new ConfigurationError(`${name} and ${fileName} cannot both be set`);
  }

  if (directValue !== undefined) {
    if (directValue.length === 0) {
      throw new ConfigurationError(`${name} cannot be empty`);
    }
    return directValue;
  }

  if (secretPath === undefined) {
    throw new ConfigurationError(`${name} or ${fileName} is required`);
  }

  if (secretPath.trim().length === 0) {
    throw new ConfigurationError(`${fileName} cannot be empty`);
  }

  let value: string;
  try {
    value = removeOneTrailingLineEnding(readSecretFile(secretPath.trim()));
  } catch (cause: unknown) {
    throw new ConfigurationError(`Could not read the secret file configured for ${fileName}`, {
      cause
    });
  }

  if (value.length === 0) {
    throw new ConfigurationError(`${name} cannot be empty`);
  }

  return value;
}
