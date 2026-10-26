import { describe, expect, it } from 'vitest';
import { shouldPollPlayers } from '../src/utils/polling';

describe('shouldPollPlayers', () => {
  it('polls only while the server can answer RCON', () => {
    expect(shouldPollPlayers('running')).toBe(true);
    expect(shouldPollPlayers('orphaned')).toBe(true);
    expect(shouldPollPlayers('stopped')).toBe(false);
    expect(shouldPollPlayers('starting')).toBe(false);
    expect(shouldPollPlayers('stopping')).toBe(false);
    expect(shouldPollPlayers('crashed')).toBe(false);
    expect(shouldPollPlayers('unknown')).toBe(false);
  });

  it('lets the players page own polling while it is open', () => {
    expect(shouldPollPlayers('running', true)).toBe(false);
    expect(shouldPollPlayers('orphaned', true)).toBe(false);
  });
});
