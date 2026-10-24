import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { BackupInfo } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError, downloadFile } from '../../api/client';
import { BackupList } from '../../components/BackupList';
import { TaskProgress } from '../../components/TaskProgress';
import { Button, ConfirmDialog, EmptyState, ErrorState, Notice, Spinner, toast } from '../../components/ui';
import { useTask } from '../../stores/realtime';
import { formatDateTime } from '../../utils/format';

export function BackupsTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);
  const task = useTask(activeTaskId);

  const list = useQuery({
    queryKey: ['backups', instance.id],
    queryFn: () => api.get<{ items: BackupInfo[] }>(`/instances/${instance.id}/backups`),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((item) => item.status === 'creating' || item.status === 'restoring') ? 2000 : false;
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['backups', instance.id] });

  const create = useMutation({
    mutationFn: () => api.post<{ taskId: string; backupId: string }>(`/instances/${instance.id}/backups`),
    onSuccess: (result) => {
      setActiveTaskId(result.taskId);
      void refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '创建备份失败', 'error'),
  });

  const remove = useMutation({
    mutationFn: (backup: BackupInfo) => api.del(`/instances/${instance.id}/backups/${backup.id}`),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
      toast('备份已删除', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '删除失败', 'error'),
  });

  const restore = useMutation({
    mutationFn: (backup: BackupInfo) =>
      api.post<{ taskId: string }>(`/instances/${instance.id}/backups/${backup.id}/restore`, { confirm: true }),
    onSuccess: (result) => {
      setRestoreTarget(null);
      setActiveTaskId(result.taskId);
      void refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '恢复失败', 'error'),
  });

  const running = status.state === 'running' || status.state === 'orphaned';
  const stopped = status.state === 'stopped';
  const backups = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">
          共 {backups.length} 个备份 · 保留 {instance.backupKeep} 个
        </div>
        <Button loading={create.isPending} onClick={() => create.mutate()}>
          立即备份
        </Button>
      </div>

      {running && (
        <Notice tone="info">
          运行中备份需要 RCON 可用：面板会先 <code className="console-font">save-off</code>、
          <code className="console-font">save-all flush</code>，确认写入磁盘后再打包，并在结束后
          <code className="console-font">save-on</code>。
        </Notice>
      )}
      {status.state !== 'stopped' && <Notice tone="warning">恢复需要先停止服务器。</Notice>}

      {task && <TaskProgress task={task} />}

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState message="备份列表加载失败" />
      ) : backups.length === 0 ? (
        <EmptyState title="还没有备份" description="手动创建一次，或到「计划」页签配置自动备份。" />
      ) : (
        <BackupList
          backups={backups}
          canRestore={stopped}
          busy={create.isPending || restore.isPending || remove.isPending}
          onDownload={(backup) => {
            void downloadFile(`/instances/${instance.id}/backups/${backup.id}/download`, backup.filename).catch(
              (cause: unknown) => toast(cause instanceof ApiError ? cause.message : '下载失败', 'error'),
            );
          }}
          onRestore={(backup) => setRestoreTarget(backup)}
          onDelete={(backup) => setDeleteTarget(backup)}
        />
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => (!open ? setRestoreTarget(null) : undefined)}
        title="恢复备份"
        description="恢复前会自动创建一个恢复前备份；现有的世界与配置会被替换，未包含在备份中的路径保持不变。"
        confirmLabel="确认恢复"
        danger
        loading={restore.isPending}
        onConfirm={() => restoreTarget && restore.mutate(restoreTarget)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}
        title="删除备份"
        description={deleteTarget ? `${formatDateTime(deleteTarget.createdAt)} 的备份将被永久删除。` : ''}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
