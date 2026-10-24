import type { BackupInfo } from '@mcpanel/shared';
import { formatBytes, formatDateTime } from '../utils/format';
import { Button } from './ui';

const KIND_LABELS: Record<BackupInfo['kind'], string> = {
  manual: '手动',
  scheduled: '定时',
  pre_restore: '恢复前',
};

const STATUS_LABELS: Record<BackupInfo['status'], string> = {
  creating: '创建中',
  ready: '可用',
  failed: '失败',
  restoring: '恢复中',
};

export function BackupList({
  backups,
  canRestore,
  onRestore,
  onDownload,
  onDelete,
  busy,
}: {
  backups: BackupInfo[];
  canRestore: boolean;
  onRestore: (backup: BackupInfo) => void;
  onDownload: (backup: BackupInfo) => void;
  onDelete: (backup: BackupInfo) => void;
  busy: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {backups.map((backup) => (
        <div
          key={backup.id}
          className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 last:border-0"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{KIND_LABELS[backup.kind]}</span>
              <span className="text-xs text-[var(--muted)]">{STATUS_LABELS[backup.status]}</span>
              {backup.error && <span className="truncate text-xs text-[var(--danger)]">{backup.error}</span>}
            </div>
            <div className="text-xs text-[var(--muted)]">
              {formatDateTime(backup.createdAt)} · {backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" disabled={backup.status !== 'ready'} onClick={() => onDownload(backup)}>
              下载
            </Button>
            <Button
              variant="secondary"
              disabled={!canRestore || backup.status !== 'ready' || busy}
              onClick={() => onRestore(backup)}
            >
              恢复
            </Button>
            <Button variant="danger" disabled={backup.status !== 'ready' || busy} onClick={() => onDelete(backup)}>
              删除
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
