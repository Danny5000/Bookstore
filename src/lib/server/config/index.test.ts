import { describe, expect, it } from 'vitest';
import { loadApplicationConfig } from './index';
import { ConfigurationError, type EnvironmentValues } from './read-setting';

const VALID_DEVELOPMENT_ENVIRONMENT: EnvironmentValues = {
  APP_ENV: 'development',
  APPLICATION_MODE: 'prototype',
  ORIGIN: 'http://localhost:5173',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'pale_orbit',
  DATABASE_USER: 'pale_orbit',
  DATABASE_PASSWORD: 'development-only'
};

describe('loadApplicationConfig', () => {
  it('returns a typed configuration from direct development values', () => {
    expect(loadApplicationConfig(VALID_DEVELOPMENT_ENVIRONMENT)).toEqual({
      environment: 'development',
      applicationMode: 'prototype',
      origin: 'http://localhost:5173',
      database: {
        host: 'localhost',
        port: 5432,
        name: 'pale_orbit',
        user: 'pale_orbit',
        password: 'development-only'
      }
    });
  });

  it('loads the database password from a production secret file', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'maintenance',
      ORIGIN: 'https://books.example.com',
      DATABASE_HOST: 'postgres',
      DATABASE_PASSWORD: undefined,
      DATABASE_PASSWORD_FILE: '/run/secrets/database_password'
    };

    const config = loadApplicationConfig(source, (path) => {
      expect(path).toBe('/run/secrets/database_password');
      return 'production-secret\n';
    });

    expect(config.environment).toBe('production');
    expect(config.applicationMode).toBe('maintenance');
    expect(config.database.password).toBe('production-secret');
  });

  it('rejects prototype mode in production', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      APP_ENV: 'production',
      APPLICATION_MODE: 'prototype',
      ORIGIN: 'https://books.example.com'
    };

    expect(() => loadApplicationConfig(source)).toThrow(
      /APPLICATION_MODE: production must use maintenance mode/
    );
  });

  it.each([
    ['ORIGIN', 'ftp://books.example.com'],
    ['DATABASE_PORT', '0'],
    ['DATABASE_PORT', 'not-a-port']
  ])('rejects invalid %s values', (key, value) => {
    expect(() =>
      loadApplicationConfig({ ...VALID_DEVELOPMENT_ENVIRONMENT, [key]: value })
    ).toThrow(ConfigurationError);
  });

  it('does not include the database password in validation errors', () => {
    const source: EnvironmentValues = {
      ...VALID_DEVELOPMENT_ENVIRONMENT,
      DATABASE_PORT: 'invalid',
      DATABASE_PASSWORD: 'must-never-appear-in-an-error'
    };

    let thrown: unknown;
    try {
      loadApplicationConfig(source);
    } catch (cause: unknown) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).not.toContain('must-never-appear-in-an-error');
  });
});
