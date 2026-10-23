import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import type { InstanceInfo, LogEncoding } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { Button, ConfirmDialog, ErrorState, Field, Input, Notice, Select, toast } from '../../components/ui';

interface FormState {
  name: string;
  startCommand: string;
  javaPath: string;
  stopTimeoutSec: number;
  logEncoding: LogEncoding;
  rconHost: string;
}

function toForm(instance: InstanceInfo): FormState {
  return {
    name: instance.name,
    startCommand: instance.startCommand,
    javaPath: instance.javaPath ?? '',
    stopTimeoutSec: instance.stopTimeoutSec,
    logEncoding: instance.logEncoding,
    rconHost: instance.rconHost ?? '',
  };
}

export function InstanceSettingsTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const [form, setForm] = useState<FormState>(() => toForm(instance));
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const save = useMutation({
    mutationFn: () =>
      api.patch<InstanceInfo>(`/instances/${instance.id}`, {
        name: form.name.trim(),
        startCommand: form.startCommand.trim(),
        javaPath: form.javaPath.trim() || null,
        stopTimeoutSec: form.stopTimeoutSec,
        logEncoding: form.logEncoding,
        rconHost: form.rconHost.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      setError(null);
      toast('设置已保存', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '保存失败'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/instances/${instance.id}`, { confirmName }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('实例已删除（服务器目录保留）', 'success');
      navigate('/instances', { replace: true });
    },
    onError: (cause) => {
      setDeleteOpen(false);
      toast(cause instanceof ApiError ? cause.message : '删除失败', 'error');
    },
  });

  const submit = () => {
    setError(null);
    if (!form.name.trim()) {
      setError('请填写实例名称');
      return;
    }
    if (!form.startCommand.trim()) {
      setError('请填写启动命令');
      return;
    }
    if (!Number.isInteger(form.stopTimeoutSec) || form.stopTimeoutSec < 10 || form.stopTimeoutSec > 300) {
      setError('停止超时需在 10 到 300 秒之间');
      return;
    }
    save.mutate();
  };

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(instance));
  const running = instance.state === 'running' || instance.state === 'orphaned' || instance.state === 'starting';

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 className="font-semibold">实例设置</h2>
        <Field label="实例名称">
          <Input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="根目录" hint="纳管后不可修改，需要换目录请删除实例后重新纳管">
          <Input value={instance.rootPath} readOnly disabled />
        </Field>
        <Field label="启动命令" hint="在服务端目录内以面板进程权限执行">
          <Input
            className="console-font"
            value={form.startCommand}
            onChange={(event) => setForm({ ...form, startCommand: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Java 路径" hint="留空使用 PATH 中的 java">
            <Input value={form.javaPath} onChange={(event) => setForm({ ...form, javaPath: event.target.value })} />
          </Field>
          <Field label="RCON 主机" hint="留空从 server.properties 推导">
            <Input value={form.rconHost} onChange={(event) => setForm({ ...form, rconHost: event.target.value })} />
          </Field>
          <Field label="停止超时（秒）">
            <Input
              type="number"
              min={10}
              max={300}
              value={form.stopTimeoutSec}
              onChange={(event) => setForm({ ...form, stopTimeoutSec: Math.trunc(Number(event.target.value)) })}
            />
          </Field>
          <Field label="日志编码" hint="修改后对当前会话的实时输出立即生效">
            <Select
              value={form.logEncoding}
              onChange={(event) => setForm({ ...form, logEncoding: event.target.value as LogEncoding })}
            >
              <option value="utf-8">UTF-8</option>
              <option value="gbk">GBK</option>
            </Select>
          </Field>
        </div>
        {running && <Notice tone="info">实例正在运行，修改启动命令与 Java 路径会在下次启动时生效。</Notice>}
        {error && <ErrorState message={error} />}
        <div className="flex items-center gap-2">
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            保存设置
          </Button>
          {dirty && (
            <Button type="button" variant="secondary" onClick={() => setForm(toForm(instance))}>
              还原
            </Button>
          )}
        </div>
      </form>

      <div className="rounded-xl border border-[var(--danger)]/30 bg-[var(--danger-soft)]/40 p-5">
        <h2 className="font-semibold text-[var(--danger)]">删除实例</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">只删除面板中的注册信息，不会删除服务器目录。请先停止服务器。</p>
        <Button variant="danger" className="mt-4" onClick={() => setDeleteOpen(true)}>
          删除实例
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next);
          if (!next) setConfirmName('');
        }}
        title="删除实例"
        description={`输入实例名称“${instance.name}”以确认。服务器目录会被保留。`}
        confirmLabel="删除"
        danger
        confirmDisabled={confirmName !== instance.name}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        <Field label="确认实例名称">
          <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={instance.name} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
