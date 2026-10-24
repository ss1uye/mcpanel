import type { TaskInfo } from '@mcpanel/shared';
import { cn } from '../utils/cn';

export function TaskProgress({ task }: { task: TaskInfo }) {
  const percent = Math.round(task.progress * 100);
  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        task.status === 'failed'
          ? 'border-[var(--danger)]/40 bg-red-500/10 text-[var(--danger)]'
          : task.status === 'success'
            ? 'border-[var(--primary)]/40 bg-[var(--primary-soft)] text-[var(--primary)]'
            : 'border-[var(--border)] bg-[var(--surface-2)]',
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <span>
          {task.kind === 'backup' ? '备份' : '恢复'}：
          {task.message ?? (task.status === 'running' ? '进行中…' : '')}
        </span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-[var(--border)]">
        <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
