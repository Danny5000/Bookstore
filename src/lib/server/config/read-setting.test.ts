import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  readOptionalSetting,
  readRequiredSetting,
  type EnvironmentValues
} from './read-setting';

describe('readRequiredSetting', () => {
  it('returns a direct environment value without reading a file', () => {
    const source: EnvironmentValues = { DATABASE_PASSWORD: 'direct-secret' };

    const value = readRequiredSetting(source, 'DATABASE_PASSWORD', () => {
      throw new Error('the file reader must not run');
    });

    expect(value).toBe('direct-secret');
  });

  it('reads a Docker-style secret file and removes one trailing line ending', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    const value = readRequiredSetting(source, 'DATABASE_PASSWORD', (path) => {
      expect(path).toBe('/run/secrets/database_password');
      return 'file-secret\r\n';
    });

    expect(value).toBe('file-secret');
  });

  it('rejects ambiguous direct and file-backed values', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD: 'direct-secret',
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    expect(() => readRequiredSetting(source, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD and DATABASE_PASSWORD_FILE cannot both be set/
    );
  });

  it('rejects a missing required setting', () => {
    expect(() => readRequiredSetting({}, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD or DATABASE_PASSWORD_FILE is required/
    );
  });

  it('rejects empty direct and file-backed values', () => {
    expect(() => readRequiredSetting({ DATABASE_PASSWORD: '' }, 'DATABASE_PASSWORD')).toThrow(
      /DATABASE_PASSWORD cannot be empty/
    );

    expect(() =>
      readRequiredSetting(
        { DATABASE_PASSWORD_FILE: '/run/secrets/database_password' },
        'DATABASE_PASSWORD',
        () => '\n'
      )
    ).toThrow(/DATABASE_PASSWORD cannot be empty/);
  });

  it('redacts the file path and underlying read error', () => {
    const source: EnvironmentValues = {
      DATABASE_PASSWORD_FILE: 'C:\\private\\database_password'
    };

    let thrown: unknown;
    try {
      readRequiredSetting(source, 'DATABASE_PASSWORD', () => {
        throw new Error('access denied for C:\\private\\database_password');
      });
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).toBe(
      'Could not read the secret file configured for DATABASE_PASSWORD_FILE'
    );
  });
});

describe('readOptionalSetting', () => {
  it('returns undefined when neither direct nor file-backed value is present', () => {
    expect(readOptionalSetting({}, 'SMTP_USER', () => '')).toBeUndefined();
  });

  it('returns a trimmed direct value', () => {
    expect(readOptionalSetting({ SMTP_USER: ' mailer ' }, 'SMTP_USER', () => '')).toBe(
      'mailer'
    );
  });

  it('reads and trims a file-backed value', () => {
    expect(
      readOptionalSetting(
        { SMTP_PASSWORD_FILE: '/run/secrets/smtp' },
        'SMTP_PASSWORD',
        () => ' secret\n'
      )
    ).toBe('secret');
  });

  it('rejects ambiguous direct and file-backed values', () => {
    expect(() =>
      readOptionalSetting(
        { SMTP_PASSWORD: 'direct', SMTP_PASSWORD_FILE: '/run/secrets/smtp' },
        'SMTP_PASSWORD'
      )
    ).toThrow(/SMTP_PASSWORD and SMTP_PASSWORD_FILE cannot both be set/);
  });

  it('normalizes empty direct and file-backed values to undefined', () => {
    expect(readOptionalSetting({ SMTP_USER: '  ' }, 'SMTP_USER')).toBeUndefined();
    expect(
      readOptionalSetting({ SMTP_USER_FILE: '/run/secrets/user' }, 'SMTP_USER', () => '\n')
    ).toBeUndefined();
  });
});
