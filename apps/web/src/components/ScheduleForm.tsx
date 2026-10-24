import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ScheduleActionType, ScheduleInfo } from '@mcpanel/shared';
import { api } from '../api/client';
import { formatDateTime } from '../utils/format';
import { Button, Dialog, Field, Input, Select } from './ui';

const PRESETS = [
  { value: '0 4 * * *', label: '每天 04:00' },
  { value: '0 4 * * 0', label: '每周日 04:00' },
  { value: '0 * * * *', label: '每小时整点' },
  { value: 'custom', label: '自定义 cron' },
];

const ACTIONS: Array<{ value: ScheduleActionType; label: string }> = [
  { value: 'backup', label: '备份' },
  { value: 'start', label: '启动' },
  { value: 'stop', label: '停止' },
  { value: 'restart', label: '重启' },
  { value: 'command', label: '发送命令' },
  { value: 'broadcast', label: '广播' },
];

export interface ScheduleFormValue {
  name: string;
  cron: string;
  timezone: string;
  actionType: ScheduleActionType;
  command?: string;
  message?: string;
  enabled: boolean;
}

export function ScheduleForm({
  instanceId,
  open,
  onOpenChange,
  timezone,
  initial,
  onSubmit,
}: {
  instanceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timezone: string;
  initial?: ScheduleInfo;
  onSubmit: (value: ScheduleFormValue) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [zone, setZone] = useState(initial?.timezone ?? timezone);
  const [preset, setPreset] = useState(
    initial && PRESETS.some((item) => item.value === initial.cron) ? initial.cron : initial ? 'custom' : '0 4 * * *',
  );
  const [cron, setCron] = useState(initial?.cron ?? '0 4 * * *');
  const [actionType, setActionType] = useState<ScheduleActionType>(initial?.actionType ?? 'backup');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [message, setMessage] = useState(initial?.message ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [debounced, setDebounced] = useState({ cron, zone });
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ cron, zone }), 300);
    return () => clearTimeout(timer);
  }, [cron, zone]);

  const preview = useQuery({
    queryKey: ['schedule-preview', instanceId, debounced.cron, debounced.zone],
    queryFn: () =>
      api.get<{ nextRuns: string[] }>(
        `/instances/${instanceId}/schedules/preview?cron=${encodeURIComponent(debounced.cron)}&timezone=${encodeURIComponent(debounced.zone)}`,
      ),
    enabled: open && debounced.cron.trim().length > 0 && debounced.zone.trim().length > 0,
    retry: false,
  });

  const missingPayload =
    (actionType === 'command' && command.trim().length === 0) ||
    (actionType === 'broadcast' && message.trim().length === 0);
  const invalid = name.trim().length === 0 || cron.trim().length === 0 || zone.trim().length === 0 || missingPayload;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? '编辑计划' : '新建计划'}
      description="每个计划可以使用独立时区；面板离线期间错过的任务不会补跑。"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={invalid}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                cron: cron.trim(),
                timezone: zone.trim(),
                actionType,
                command: actionType === 'command' ? command.trim() : undefined,
                message: actionType === 'broadcast' ? message.trim() : undefined,
                enabled,
              })
            }
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称">
          <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="动作">
            <Select value={actionType} onChange={(event) => setActionType(event.target.value as ScheduleActionType)}>
              {ACTIONS.map((action) => (
                <option key={action.value} value={action.value}>
                  {action.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="执行频率">
            <Select
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value !== 'custom') setCron(event.target.value);
              }}
            >
              {PRESETS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="时区" hint={`面板默认：${timezone}`}>
          <Input value={zone} maxLength={64} onChange={(event) => setZone(event.target.value)} />
        </Field>
        <Field label="cron 表达式" hint="分 时 日 月 周，例如 0 4 * * *">
          <Input value={cron} readOnly={preset !== 'custom'} onChange={(event) => setCron(event.target.value)} />
        </Field>
        {debounced.cron.trim().length > 0 && debounced.zone.trim().length > 0 && (
          <div className="text-xs text-[var(--muted)]" aria-live="polite">
            {preview.isError
              ? 'cron 表达式或时区无效'
              : preview.data
                ? `未来 3 次：${preview.data.nextRuns.map((iso) => formatDateTime(iso)).join(' · ')}`
                : '正在计算未来运行时间…'}
          </div>
        )}
        {actionType === 'command' && (
          <Field label="命令">
            <Input value={command} maxLength={1000} onChange={(event) => setCommand(event.target.value)} />
          </Field>
        )}
        {actionType === 'broadcast' && (
          <Field label="广播内容">
            <Input value={message} maxLength={256} onChange={(event) => setMessage(event.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用
        </label>
      </div>
    </Dialog>
  );
}
