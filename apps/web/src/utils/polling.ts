import type { InstanceState } from '@mcpanel/shared';

export function shouldPollPlayers(state: InstanceState, onPlayersPage = false): boolean {
  if (onPlayersPage) return false;
  return state === 'running' || state === 'orphaned';
}
