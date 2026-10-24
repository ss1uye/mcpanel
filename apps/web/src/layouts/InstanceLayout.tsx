import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PanelRight, Play, RotateCw, Skull, Square, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import type { InstanceInfo, InstanceStatusSnapshot, RconStatus } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { Button, ConfirmDialog, ErrorState, Spinner, toast } from '../components/ui';
import { useInstanceStatus } from '../stores/realtime';
import { cn } from '../utils/cn';
import { RCON_LABELS } from '../utils/labels';

export interface InstanceOutletContext {
  instance: InstanceInfo;
  status: InstanceStatusSnapshot;
}

type InstanceAction = 'start' | 'stop' | 'restart' | 'kill';

const ACTION_LABELS: Record<InstanceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  kill: '强制结束',
};

const RIGHT_PANEL_KEY = 'mcpanel:right-panel';

const tabs = [
  { to: 'overview', label: '概览' },
  { to: 'console', label: '控制台' },
  { to: 'players', label: '玩家' },
  { to: 'settings', label: '设置' },
];

function rconLabel(status: RconStatus): string {
  return RCON_LABELS[status];
}

export function InstanceLayout() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const live = useInstanceStatus(id);
  const query = useQuery({
    queryKey: ['instances', id],
    queryFn: () => api.get<InstanceInfo>(`/instances/${id}`),
    enabled: Boolean(id),
  });
  const [rightOpen, setRightOpen] = useState(
    () => localStorage.getItem(RIGHT_PANEL_KEY) !== 'closed' && window.innerWidth >= 1024,
  );
  const [killOpen, setKillOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['instances'] });

  const action = useMutation({
    mutationFn: (name: InstanceAction) => api.post<{ state: string }>(`/instances/${id}/actions/${name}`),
    onSuccess: async (_data, name) => {
      await invalidate();
      toast(`已执行${ACTION_LABELS[name]}`, 'success');
      setKillOpen(false);
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const markStopped = useMutation({
    mutationFn: () => api.post<{ state: string }>(`/instances/${id}/actions/mark-stopped`, { confirm: true }),
    onSuccess: async () => {
      await invalidate();
      toast('已标记为停止', 'success');
      setMarkOpen(false);
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  if (query.isLoading) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }
  if (query.isError || !query.data) return <div className="p-8"><ErrorState message="实例加载失败或不存在" /></div>;

  const instance = query.data;
  const status: InstanceStatusSnapshot = live ?? {
    instanceId: instance.id,
    state: instance.state,
    pid: instance.pid,
    startedAt: instance.startedAt,
    exitCode: instance.exitCode,
    error: instance.lastError,
  };
  const state = status.state;
  const busy = state === 'starting' || state === 'stopping' || action.isPending;
  const canRestart = state === 'running' || state === 'orphaned' || state === 'stopped' || state === 'crashed';

  const toggleRight = () => {
    const next = !rightOpen;
    setRightOpen(next);
    localStorage.setItem(RIGHT_PANEL_KEY, next ? 'open' : 'closed');
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/instances" className="text-xs text-[var(--muted)] hover:text-[var(--primary)]">
            ← 全部实例
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold">{instance.name}</h1>
            <StatusBadge state={state} />
          </div>
          <div className="mt-1 truncate text-xs text-[var(--muted)]">{instance.rootPath}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state === 'stopped' || state === 'crashed' ? (
            <Button
              loading={action.isPending && action.variables === 'start'}
              disabled={busy}
              onClick={() => action.mutate('start')}
            >
              <Play className="h-4 w-4" />
              启动
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={action.isPending && action.variables === 'stop'}
              disabled={busy || state === 'unknown'}
              onClick={() => action.mutate('stop')}
            >
              <Square className="h-4 w-4" />
              停止
            </Button>
          )}
          <Button variant="secondary" disabled={busy || !canRestart} onClick={() => action.mutate('restart')}>
            <RotateCw className="h-4 w-4" />
            重启
          </Button>
          <Button variant="secondary" disabled={!status.pid || state === 'stopped'} onClick={() => setKillOpen(true)}>
            <Skull className="h-4 w-4" />
            强制结束
          </Button>
          {state === 'unknown' && (
            <Button variant="secondary" onClick={() => setMarkOpen(true)}>
              <Wrench className="h-4 w-4" />
              标记已停止
            </Button>
          )}
          <Button variant="ghost" onClick={toggleRight} aria-label="切换右侧面板">
            <PanelRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'whitespace-nowrap border-b-2 px-4 py-2 text-sm transition',
                isActive
                  ? 'border-[var(--primary)] text-[var(--primary)]'
                  : 'border-transparent text-[var(--muted)] hover:text-[var(--fg)]',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      <div className="flex min-w-0 gap-5">
        <div className="min-w-0 flex-1">
          <Outlet context={{ instance, status } satisfies InstanceOutletContext} />
        </div>
        {rightOpen && (
          <aside className="hidden w-72 shrink-0 lg:block">
            <div className="sticky top-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
              <div className="font-medium">运行状态</div>
              <div className="flex justify-between gap-3 text-[var(--muted)]">
                <span>状态</span>
                <StatusBadge state={state} />
              </div>
              <div className="flex justify-between gap-3 text-[var(--muted)]">
                <span>PID</span>
                <span className="tabular-nums">{status.pid ?? '—'}</span>
              </div>
              <div className="flex justify-between gap-3 text-[var(--muted)]">
                <span>RCON</span>
                <span>{rconLabel(instance.rconStatus)}</span>
              </div>
              <div className="flex justify-between gap-3 text-[var(--muted)]">
                <span>启动命令</span>
                <span className="console-font max-w-[60%] truncate" title={instance.startCommand}>
                  {instance.startCommand}
                </span>
              </div>
              {status.error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-[var(--danger)]">{status.error}</div>}
              <Link
                to="console"
                className="inline-flex h-9 w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-sm"
              >
                打开控制台
              </Link>
            </div>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title="强制结束进程树"
        description="这会立即杀死服务器及其子进程，可能造成存档未保存。确定继续？"
        confirmLabel="强制结束"
        danger
        loading={action.isPending && action.variables === 'kill'}
        onConfirm={() => action.mutate('kill')}
      />
      <ConfirmDialog
        open={markOpen}
        onOpenChange={setMarkOpen}
        title="标记为已停止"
        description="仅在确认操作系统中的进程已经不存在时使用，否则会丢失对该进程的跟踪。"
        confirmLabel="确认已停止"
        danger
        loading={markStopped.isPending}
        onConfirm={() => markStopped.mutate()}
      />
    </div>
  );
}
