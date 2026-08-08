import { describe, expect, it } from 'vitest';
import { isRequestAvailable } from './application-mode';

describe('isRequestAvailable', () => {
  it.each(['/', '/catalog', '/api/checkout', '/read/vector'])(
    'allows %s in prototype mode',
    (path) => {
      expect(isRequestAvailable('prototype', path)).toBe(true);
    }
  );

  it.each(['/health/live', '/health/ready'])(
    'allows %s in maintenance mode',
    (path) => {
      expect(isRequestAvailable('maintenance', path)).toBe(true);
    }
  );

  it.each(['/', '/catalog', '/api/checkout', '/health/private'])(
    'blocks %s in maintenance mode',
    (path) => {
      expect(isRequestAvailable('maintenance', path)).toBe(false);
    }
  );
});
