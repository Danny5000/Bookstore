import { expect, test } from '@playwright/test';

test('liveness reports the running web process', async ({ request }) => {
  const response = await request.get('/health/live');

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('readiness reports validated application configuration', async ({ request }) => {
  const response = await request.get('/health/ready');

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ready' });
});
