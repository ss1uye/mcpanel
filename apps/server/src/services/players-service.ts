import fs from 'node:fs/promises';
import type { InstanceState, PlayerActionInput, PlayerListsResponse, PlayersResponse } from '@mcpanel/shared';
import type { InstanceRow } from '../db/schema';
import type { PathSandbox } from '../nodes/path-sandbox';
import { AppError } from '../utils/errors';
import type { RconService } from './rcon-service';

const LIST_PATTERNS = [
  /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i,
  /There are (\d+)\/(\d+) players online:?\s*(.*)/i,
];
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export function parsePlayerList(output: string): { online: string[]; max: number; warning: string | null } {
  for (const pattern of LIST_PATTERNS) {
    const match = pattern.exec(output);
    if (!match) continue;
    const names = (match[3] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => PLAYER_NAME.test(name));
    return { online: names, max: Number(match[2]), warning: null };
  }
  return { online: [], max: 0, warning: '无法解析服务器返回的玩家列表' };
}

export function buildPlayerCommand(input: PlayerActionInput): string {
  switch (input.action) {
    case 'op':
      return `op ${input.player}`;
    case 'deop':
      return `deop ${input.player}`;
    case 'whitelist_add':
      return `whitelist add ${input.player}`;
    case 'whitelist_remove':
      return `whitelist remove ${input.player}`;
    case 'pardon':
      return `pardon ${input.player}`;
    case 'kick':
      return `kick ${input.player} ${input.reason}`.trim();
    case 'ban':
      return `ban ${input.player} ${input.reason}`.trim();
    case 'gamemode':
      return `gamemode ${input.mode} ${input.player}`;
    case 'broadcast':
      return `say ${input.message}`;
    case 'whitelist_on':
      return 'whitelist on';
    case 'whitelist_off':
      return 'whitelist off';
  }
}

async function readNameList(
  sandbox: PathSandbox,
  root: string,
  file: string,
  pick: 'name' | 'ip',
): Promise<string[]> {
  const target = await sandbox.resolve(root, file).catch(() => null);
  if (!target) return [];
  const raw = await fs.readFile(target, 'utf8').catch(() => null);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[pick] : undefined))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

export class PlayersService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly rcon: RconService,
    private readonly getState: (instanceId: string) => InstanceState,
  ) {}

  async online(row: InstanceRow): Promise<PlayersResponse> {
    const state = this.getState(row.id);
    const rconStatus = await this.rcon.statusFor(row);
    if (state !== 'running' && state !== 'orphaned') {
      return { online: [], max: 0, warning: '服务器未运行', rconStatus, state };
    }
    if (rconStatus === 'disabled') {
      return { online: [], max: 0, warning: 'RCON 未启用，无法查询玩家', rconStatus, state };
    }
    try {
      const output = await this.rcon.send(row, 'list');
      return { ...parsePlayerList(output), rconStatus: 'connected', state };
    } catch (error) {
      return {
        online: [],
        max: 0,
        warning: error instanceof AppError ? error.message : 'RCON 查询失败',
        rconStatus: 'unreachable',
        state,
      };
    }
  }

  async lists(row: InstanceRow): Promise<PlayerListsResponse> {
    const [whitelist, ops, banned, bannedIps] = await Promise.all([
      readNameList(this.sandbox, row.rootPath, 'whitelist.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'ops.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'banned-players.json', 'name'),
      readNameList(this.sandbox, row.rootPath, 'banned-ips.json', 'ip'),
    ]);
    return { whitelist, ops, banned, bannedIps };
  }

  async act(row: InstanceRow, input: PlayerActionInput): Promise<{ command: string }> {
    const state = this.getState(row.id);
    if (state !== 'running' && state !== 'orphaned') {
      throw new AppError('INVALID_STATE', '服务器未运行，无法执行玩家操作');
    }
    const command = buildPlayerCommand(input);
    await this.rcon.send(row, command);
    return { command };
  }
}
