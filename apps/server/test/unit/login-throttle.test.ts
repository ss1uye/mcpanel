import { describe, expect, it } from 'vitest';
import { LoginThrottle } from '../../src/auth/guard';

describe('LoginThrottle', () => {
  it('locks for 15 minutes after 10 failures and resets on success', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);

    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect(() => throttle.assertAllowed('1.2.3.4')).not.toThrow();
      throttle.recordFailure('1.2.3.4');
    }
    throttle.assertAllowed('1.2.3.4');
    throttle.recordFailure('1.2.3.4');

    expect(() => throttle.assertAllowed('1.2.3.4')).toThrow(/15/);
    expect(() => throttle.assertAllowed('9.9.9.9')).not.toThrow();

    now += 15 * 60 * 1000 + 1;
    expect(() => throttle.assertAllowed('1.2.3.4')).not.toThrow();

    throttle.recordFailure('5.6.7.8');
    throttle.recordSuccess('5.6.7.8');
    for (let attempt = 0; attempt < 9; attempt += 1) throttle.recordFailure('5.6.7.8');
    expect(() => throttle.assertAllowed('5.6.7.8')).not.toThrow();
  });

  it('expires the lock automatically and clears stale counters', () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    for (let attempt = 0; attempt < 10; attempt += 1) throttle.recordFailure('42.42.42.42');
    now += 20 * 60 * 1000;
    throttle.assertAllowed('42.42.42.42');
    throttle.recordFailure('42.42.42.42');
    expect(() => throttle.assertAllowed('42.42.42.42')).not.toThrow();
  });
});
