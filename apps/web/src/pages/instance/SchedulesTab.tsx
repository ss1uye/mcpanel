import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PanelSettings, ScheduleInfo, ScheduleRunInfo } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { ScheduleForm, type ScheduleFormValue } from '../../components/ScheduleForm';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Spinner, toast } from '../../components/ui';
import { formatDateTime } from '../../utils/format';

const ACTION_LABELS: Record<ScheduleInfo['actionType'], string> = {
  backup: '备份',
  start: '启动',
  stop: '停止',
  restart: '重启',
  command: '命令',
  broadcast: '广播',
};

const RUN_STATUS_LABELS: Record<ScheduleRunInfo['status'], string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
};

export function SchedulesTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleInfo | null>(null);
  const [runsFor, setRunsFor] = useState<ScheduleInfo | null>(null);

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const schedules = useQuery({
    queryKey: ['schedules', instance.id],
    queryFn: () => api.get<{ items: ScheduleInfo[] }>(`/instances/${instance.id}/schedules`),
  });
  const runs = useQuery({
    queryKey: ['schedule-runs', instance.id, runsFor?.id],
    queryFn: () =>
      api.get<{ items: ScheduleRunInfo[] }>(`/instances/${instance.id}/schedules/${runsFor?.id}/runs`),
    enabled: Boolean(runsFor),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['schedules', instance.id] });

  const save = useMutation({
    mutationFn: (value: ScheduleFormValue) =>
      editing
        ? api.patch(`/instances/${instance.id}/schedules/${editing.id}`, value)
        : api.post(`/instances/${instance.id}/schedules`, value),
    onSuccess: async () => {
      setFormOpen(false);
      setEditing(null);
      await refresh();
      toast('计划已保存', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '保存失败', 'error'),
  });

  const toggle = useMutation({
    mutationFn: (schedule: ScheduleInfo) =>
      api.patch(`/instances/${instance.id}/schedules/${schedule.id}`, { enabled: !schedule.enabled }),
    onSuccess: async () => {
      await refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const runNow = useMutation({
    mutationFn: (schedule: ScheduleInfo) =>
      api.post<ScheduleRunInfo>(`/instances/${instance.id}/schedules/${schedule.id}/run`),
    onSuccess: async (run) => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs', instance.id, run.scheduleId] });
      if (run.status === 'failed') toast(run.message ?? '运行失败', 'error');
      else toast(run.status === 'success' ? '运行成功' : '已跳过', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '运行失败', 'error'),
  });

  const remove = useMutation({
    mutationFn: (schedule: ScheduleInfo) => api.del(`/instances/${instance.id}/schedules/${schedule.id}`),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '删除失败', 'error'),
  });

  const items = schedules.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">按 cron 自动执行备份、启停、重启、命令或广播。</div>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          新建计划
        </Button>
      </div>

      {schedules.isLoading ? (
        <Spinner />
      ) : schedules.isError ? (
        <ErrorState message="计划加载失败" />
      ) : items.length === 0 ? (
        <EmptyState title="还没有计划" description="创建每日备份或定时重启，减少手工操作。" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {items.map((schedule) => (
            <div
              key={schedule.id}
              className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{schedule.name}</span>
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">
                    {ACTION_LABELS[schedule.actionType]}
                  </span>
                  {!schedule.enabled && <span className="text-xs text-[var(--muted)]">已停用</span>}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  {schedule.cron} · {schedule.timezone} · 下次 {formatDateTime(schedule.nextRunAt)} · 上次{' '}
                  {formatDateTime(schedule.lastRunAt)}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" onClick={() => toggle.mutate(schedule)}>
                  {schedule.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  variant="secondary"
                  loading={runNow.isPending && runNow.variables?.id === schedule.id}
                  onClick={() => runNow.mutate(schedule)}
                >
                  立即运行
                </Button>
                <Button variant="secondary" onClick={() => setRunsFor(schedule)}>
                  记录
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditing(schedule);
                    setFormOpen(true);
                  }}
                >
                  编辑
                </Button>
                <Button variant="danger" onClick={() => setDeleteTarget(schedule)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleForm
        key={`${editing?.id ?? 'new'}-${formOpen}`}
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        timezone={settings.data?.defaultTimezone ?? 'Asia/Shanghai'}
        initial={editing ?? undefined}
        onSubmit={(value) => save.mutate(value)}
      />

      <Dialog
        open={runsFor !== null}
        onOpenChange={(open) => (!open ? setRunsFor(null) : undefined)}
        title="运行记录"
        description={runsFor?.name}
        wide
      >
        {runs.isLoading ? (
          <Spinner />
        ) : (runs.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-[var(--muted)]">暂无运行记录</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            {runs.data?.items.map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] py-2 text-sm last:border-0"
              >
                <span>{formatDateTime(run.startedAt)}</span>
                <span className="text-xs text-[var(--muted)]">{run.trigger === 'manual' ? '手动' : '定时'}</span>
                <span className={run.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}>
                  {RUN_STATUS_LABELS[run.status]}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--muted)]" title={run.message ?? ''}>
                  {run.message ?? ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}
        title="删除计划"
        description={deleteTarget ? `计划「${deleteTarget.name}」及其运行记录会被删除。` : ''}
        confirmLabel="删除"
        danger
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}
