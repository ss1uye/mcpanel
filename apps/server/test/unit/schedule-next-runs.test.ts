import { describe, expect, it } from 'vitest';
import { nextRunsFor } from '../../src/services/schedule-service';

describe('nextRunsFor', () => {
  it('returns the next three runs as UTC ISO strings', () => {
    const runs = nextRunsFor('0 4 * * *', 'Asia/Shanghai');
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatch(/T20:00:00\.000Z$/);
    expect(Date.parse(runs[1]!)).toBeGreaterThan(Date.parse(runs[0]!));
    expect(Date.parse(runs[2]!)).toBeGreaterThan(Date.parse(runs[1]!));
  });

  it('returns an empty array for an invalid cron or timezone', () => {
    expect(nextRunsFor('every day', 'Asia/Shanghai')).toEqual([]);
    expect(nextRunsFor('0 4 * * *', 'Mars/Base')).toEqual([]);
  });
});
