import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Cpu, HardDrive, MemoryStick, Server, Timer } from 'lucide-react';
import type { AuditEntry, InstanceInfo, Paginated, SystemMetricsSample } from '@mcpanel/shared';
import { api } from '../api/client';
import { MetricsSparkline } from '../components/MetricsSparkline';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { useInstanceMetrics, useInstanceStatus, useRealtime, useSystemMetrics } from '../stores/realtime';
import { formatBytes, formatDateTime, formatDuration } from '../utils/format';

function MetricCard({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-1 text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}

function InstanceCard({ instance }: { instance: InstanceInfo }) {
  const samples = useInstanceMetrics(instance.id);
  const live = useInstanceStatus(instance.id);
  const last = samples.at(-1);
  const state = live?.state ?? instance.state;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/instances/${instance.id}/overview`} className="block truncate font-medium hover:text-[var(--primary)]">
            {instance.name}
          </Link>
          <div className="mt-1 truncate text-xs text-[var(--muted)]">{instance.rootPath}</div>
        </div>
        <StatusBadge state={state} />
      </div>
      <div className="mt-3">
        <MetricsSparkline values={samples.map((sample) => sample.cpu)} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>{last ? `CPU ${last.cpu.toFixed(1)}% · ${formatBytes(last.memBytes)}` : '暂无采样'}</span>
        <Link to={`/instances/${instance.id}/console`} className="text-[var(--primary)] hover:underline">
          控制台
        </Link>
      </div>
      {instance.lastError && <div className="mt-2 truncate text-xs text-[var(--danger)]">{instance.lastError}</div>}
    </div>
  );
}

export function DashboardPage() {
  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: () => api.get<SystemMetricsSample>('/system/overview'),
    refetchInterval: 15_000,
  });
  const instances = useQuery({ queryKey: ['instances'], queryFn: () => api.get<{ items: InstanceInfo[] }>('/instances') });
  const audit = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => api.get<Paginated<AuditEntry>>('/audit?page=1&pageSize=10'),
  });
  const liveSystem = useSystemMetrics();
  const liveStates = useRealtime((state) => state.states);
  const latest = liveSystem.at(-1) ?? overview.data;
  const items = instances.data?.items ?? [];

  const warnings: string[] = [];
  for (const instance of items) {
    const state = liveStates[instance.id]?.state ?? instance.state;
    if (state === 'unknown') warnings.push(`${instance.name}：状态未知，请检查进程`);
    if (state === 'orphaned') warnings.push(`${instance.name}：进程未接管，可通过 RCON 停止`);
    if (state === 'crashed') warnings.push(`${instance.name}：上次运行异常退出`);
    if (state !== 'stopped' && instance.rconStatus === 'disabled') warnings.push(`${instance.name}：未启用 RCON`);
  }
  if (latest && latest.diskTotalBytes > 0 && latest.diskFreeBytes / latest.diskTotalBytes < 0.1) {
    warnings.push('磁盘剩余空间低于 10%');
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">总览</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">系统状态与服务器概况</p>
      </div>

      {overview.isError && <ErrorState message="系统指标加载失败" />}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Cpu} label="CPU" value={latest ? `${latest.cpuPercent.toFixed(1)}%` : '—'} />
        <MetricCard
          icon={MemoryStick}
          label="内存"
          value={latest ? formatBytes(latest.memUsedBytes) : '—'}
          detail={latest ? `共 ${formatBytes(latest.memTotalBytes)}` : undefined}
        />
        <MetricCard
          icon={HardDrive}
          label="数据盘剩余"
          value={latest ? formatBytes(latest.diskFreeBytes) : '—'}
          detail={latest ? `共 ${formatBytes(latest.diskTotalBytes)}` : undefined}
        />
        <MetricCard
          icon={Timer}
          label="系统运行"
          value={latest ? formatDuration(latest.uptimeSec) : '—'}
          detail={latest ? `Node ${latest.nodeVersion}` : undefined}
        />
      </div>

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[var(--warn)]">
          <div className="font-medium">需要注意</div>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {warnings.slice(0, 5).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Server className="h-4 w-4" />
            实例
          </h2>
          <Link to="/instances" className="text-sm text-[var(--primary)] hover:underline">
            全部实例 →
          </Link>
        </div>
        {instances.isLoading ? (
          <Spinner />
        ) : instances.isError ? (
          <ErrorState message="实例列表加载失败" />
        ) : items.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((instance) => (
              <InstanceCard key={instance.id} instance={instance} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="还没有纳管实例"
            description="纳管一个已经安装好的 Fabric / Forge / NeoForge 服务器目录，面板不会移动或覆盖你的文件。"
            action={
              <Link
                to="/instances"
                className="inline-flex h-9 items-center rounded-lg bg-[var(--primary)] px-3 text-sm font-medium text-[#07130b]"
              >
                纳管第一个实例
              </Link>
            }
          />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">最近活动</h2>
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {audit.data?.items.length ? (
            audit.data.items.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-2 text-sm last:border-0"
              >
                <span className="truncate">{entry.action}</span>
                <span className="shrink-0 text-xs text-[var(--muted)]">{formatDateTime(entry.createdAt)}</span>
              </div>
            ))
          ) : (
            <div className="px-4 py-6 text-sm text-[var(--muted)]">暂无活动</div>
          )}
        </div>
      </section>
    </div>
  );
}
