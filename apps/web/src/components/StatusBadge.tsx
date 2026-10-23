import type { InstanceState } from '@mcpanel/shared';
import { Badge } from './ui';

const STATES: Record<InstanceState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  stopped: { label: '已停止', tone: 'neutral' },
  starting: { label: '启动中', tone: 'warning' },
  running: { label: '运行中', tone: 'success' },
  stopping: { label: '停止中', tone: 'warning' },
  crashed: { label: '已崩溃', tone: 'danger' },
  orphaned: { label: '未接管', tone: 'warning' },
  unknown: { label: '状态未知', tone: 'danger' },
};

export function StatusBadge({ state }: { state: InstanceState }) {
  const item = STATES[state];
  return (
    <Badge tone={item.tone}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {item.label}
    </Badge>
  );
}
