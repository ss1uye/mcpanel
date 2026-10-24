import { describe, expect, it } from 'vitest';
import { buildPlayerCommand, parsePlayerList } from '../../src/services/players-service';

describe('parsePlayerList', () => {
  it('parses the vanilla list output', () => {
    expect(parsePlayerList('There are 2 of a max of 20 players online: Steve, Alex')).toEqual({
      online: ['Steve', 'Alex'],
      max: 20,
      warning: null,
    });
  });

  it('parses the legacy slash form and tolerates empty lists', () => {
    expect(parsePlayerList('There are 0/10 players online:')).toEqual({ online: [], max: 10, warning: null });
  });

  it('filters invalid names and warns on unknown output', () => {
    expect(parsePlayerList('There are 1 of a max of 20 players online: Steve, <not a name>').online).toEqual(['Steve']);
    expect(parsePlayerList('Unknown command').warning).toContain('无法解析');
  });
});

describe('buildPlayerCommand', () => {
  it('uses fixed templates for every action', () => {
    expect(buildPlayerCommand({ action: 'op', player: 'Steve' })).toBe('op Steve');
    expect(buildPlayerCommand({ action: 'kick', player: 'Steve', reason: '挂机' })).toBe('kick Steve 挂机');
    expect(buildPlayerCommand({ action: 'ban', player: 'Steve', reason: '' })).toBe('ban Steve');
    expect(buildPlayerCommand({ action: 'gamemode', player: 'Alex', mode: 'creative' })).toBe('gamemode creative Alex');
    expect(buildPlayerCommand({ action: 'broadcast', message: '维护中' })).toBe('say 维护中');
    expect(buildPlayerCommand({ action: 'whitelist_off' })).toBe('whitelist off');
  });
});
