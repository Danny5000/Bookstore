import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '$lib/server/config/read-setting';
import { loadBootstrapAdminConfig } from './bootstrap-config';

const valid = {
  BOOTSTRAP_ADMIN_EMAIL: '  Owner@Example.COM ',
  BOOTSTRAP_ADMIN_NAME: '  Store Owner  ',
  BOOTSTRAP_ADMIN_PASSWORD: 'A-secure-bootstrap-password'
};

describe('loadBootstrapAdminConfig', () => {
  it('normalizes only the narrow bootstrap settings', () => {
    expect(loadBootstrapAdminConfig(valid)).toEqual({
      email: 'owner@example.com',
      name: 'Store Owner',
      password: 'A-secure-bootstrap-password'
    });
  });

  it('supports a password secret file', () => {
    expect(
      loadBootstrapAdminConfig(
        {
          BOOTSTRAP_ADMIN_EMAIL: 'owner@example.com',
          BOOTSTRAP_ADMIN_NAME: 'Owner',
          BOOTSTRAP_ADMIN_PASSWORD_FILE: '/run/secrets/bootstrap-password'
        },
        () => 'A-file-bootstrap-password\n'
      )
    ).toEqual({
      email: 'owner@example.com',
      name: 'Owner',
      password: 'A-file-bootstrap-password'
    });
  });

  it('rejects direct and file password settings together', () => {
    expect(() =>
      loadBootstrapAdminConfig({
        ...valid,
        BOOTSTRAP_ADMIN_PASSWORD_FILE: '/run/secrets/bootstrap-password'
      })
    ).toThrow(ConfigurationError);
  });

  it.each(['short', 'x'.repeat(129)])('rejects an invalid password length', (password) => {
    expect(() =>
      loadBootstrapAdminConfig({ ...valid, BOOTSTRAP_ADMIN_PASSWORD: password })
    ).toThrow(/password/i);
  });

  it.each([
    { ...valid, BOOTSTRAP_ADMIN_EMAIL: 'invalid' },
    { ...valid, BOOTSTRAP_ADMIN_NAME: '   ' }
  ])('rejects invalid identity input', (source) => {
    expect(() => loadBootstrapAdminConfig(source)).toThrow(ConfigurationError);
  });
});
