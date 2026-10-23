import { Link, useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { MetricsSparkline } from '../../components/MetricsSparkline';
import { useInstanceConsole, useInstanceMetrics } from '../../stores/realtime';
import { RCON_LABELS } from '../../utils/labels';
import { formatBytes, formatDuration } from '../../utils/format';

function Card({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-2 truncate text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-1 truncate text-xs text-[var(--muted)]">{detail}</div>}
    </div>
  );
}

export function OverviewTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const metrics = useInstanceMetrics(instance.id);
  const consoleState = useInstanceConsole(instance.id);
  const running = status.state === 'running' || status.state === 'orphaned';
  const uptime =
    running && status.startedAt ? Math.max(0, (Date.now() - new Date(status.startedAt).getTime()) / 1000) : null;
  const latest = metrics.at(-1);
  const recentLines = consoleState.lines.slice(-20);

  return (
    <div className="flex flex-col gap-4">
      {status.error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
          {status.error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card
          label="PID / 运行时长"
          value={status.pid ? String(status.pid) : '—'}
          detail={uptime !== null ? formatDuration(uptime) : '未运行'}
        />
        <Card
          label="CPU / 内存"
          value={latest ? `${latest.cpu.toFixed(1)}%` : '—'}
          detail={latest ? formatBytes(latest.memBytes) : '等待采样'}
        />
        <Card label="RCON" value={RCON_LABELS[instance.rconStatus]} detail="玩家管理在阶段 2 提供" />
        <Card label="日志编码" value={instance.logEncoding.toUpperCase()} detail={`停止超时 ${instance.stopTimeoutSec} 秒`} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">CPU 采样</span>
          <span className="text-xs text-[var(--muted)]">最近 {metrics.length} 个样本</span>
        </div>
        <MetricsSparkline values={metrics.map((sample) => sample.cpu)} height={60} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3 text-sm">
          <span className="font-medium">最近控制台</span>
          <Link to="../console" className="text-[var(--primary)] hover:underline">
            打开控制台 →
          </Link>
        </div>
        <pre className="console-font max-h-64 overflow-auto p-4 text-xs leading-5 text-[var(--muted)]">
          {recentLines.map((line) => `${line.text}\n`).join('') || '暂无日志'}
        </pre>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <div className="mb-3 font-medium">实例信息</div>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--muted)]">根目录</dt>
            <dd className="truncate" title={instance.rootPath}>
              {instance.rootPath}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--muted)]">Java</dt>
            <dd className="truncate" title={instance.javaPath ?? undefined}>
              {instance.javaPath ?? '自动探测'}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--muted)]">启动命令</dt>
            <dd className="console-font truncate" title={instance.startCommand}>
              {instance.startCommand}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-[var(--muted)]">RCON 主机</dt>
            <dd className="truncate">{instance.rconHost ?? '自动'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
