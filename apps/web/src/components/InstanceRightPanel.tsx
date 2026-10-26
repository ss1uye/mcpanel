import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import type { InstanceInfo, InstanceStatusSnapshot, PlayersResponse } from '@mcpanel/shared';
import { api } from '../api/client';
import { StatusBadge } from './StatusBadge';
import { PlayerAvatar } from './PlayerAvatar';
import { RCON_LABELS } from '../utils/labels';
import { shouldPollPlayers } from '../utils/polling';

export function InstanceRightPanel({
  instance,
  status,
}: {
  instance: InstanceInfo;
  status: InstanceStatusSnapshot;
}) {
  const location = useLocation();
  const players = useQuery({
    queryKey: ['players', instance.id],
    queryFn: () => api.get<PlayersResponse>(`/instances/${instance.id}/players`),
    refetchInterval: shouldPollPlayers(status.state, location.pathname.endsWith('/players')) ? 15_000 : false,
  });
  const online = players.data?.online ?? [];

  return (
    <div className="sticky top-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
      <div className="font-medium">运行状态</div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>状态</span>
        <StatusBadge state={status.state} />
      </div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>PID</span>
        <span className="tabular-nums">{status.pid ?? '—'}</span>
      </div>
      <div className="flex justify-between gap-3 text-[var(--muted)]">
        <span>RCON</span>
        <span>{RCON_LABELS[players.data?.rconStatus ?? instance.rconStatus]}</span>
      </div>

      <div className="border-t border-[var(--border)] pt-3">
        <div className="flex items-center justify-between text-[var(--muted)]">
          <span>在线玩家</span>
          <span className="tabular-nums">
            {online.length} / {players.data?.max ?? 0}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {online.slice(0, 8).map((name) => (
            <div key={name} className="flex items-center gap-2">
              <PlayerAvatar name={name} size={20} />
              <span className="truncate">{name}</span>
            </div>
          ))}
          {online.length === 0 && (
            <span className="text-xs text-[var(--muted)]">{players.isLoading ? '加载中…' : '暂无在线玩家'}</span>
          )}
        </div>
      </div>

      {status.error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-[var(--danger)]">{status.error}</div>}

      <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <Link to="players" className="text-[var(--primary)] hover:underline">
          玩家管理 →
        </Link>
        <Link to="console" className="text-[var(--primary)] hover:underline">
          打开控制台 →
        </Link>
      </div>
    </div>
  );
}
