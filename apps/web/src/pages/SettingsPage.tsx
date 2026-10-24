import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { PanelSettings } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner, toast } from '../components/ui';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const [form, setForm] = useState<PanelSettings | null>(null);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const current = form ?? settings.data ?? null;

  const save = useMutation({
    mutationFn: (patch: PanelSettings) => api.patch<PanelSettings>('/settings', patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(['settings'], next);
      setForm(null);
      toast('面板设置已保存', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '保存失败', 'error'),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/password', { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '', confirm: '' });
      setPasswordError(null);
      toast('密码已修改，其他会话已退出', 'success');
    },
    onError: (cause) => setPasswordError(cause instanceof ApiError ? cause.message : '修改失败'),
  });

  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    if (passwords.newPassword.length < 12) {
      setPasswordError('新密码至少 12 个字符');
      return;
    }
    if (passwords.newPassword !== passwords.confirm) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    changePassword.mutate();
  };

  if (settings.isError) {
    return (
      <div className="p-8">
        <ErrorState message="面板设置加载失败" />
      </div>
    );
  }
  if (settings.isLoading || !current) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">面板设置</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">面板名称、时区与审计保留策略</p>
      </div>

      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(current);
        }}
      >
        <Field label="面板名称">
          <Input
            value={current.panelName}
            maxLength={60}
            onChange={(event) => setForm({ ...current, panelName: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="默认时区" hint="例如 Asia/Shanghai">
            <Input
              value={current.defaultTimezone}
              onChange={(event) => setForm({ ...current, defaultTimezone: event.target.value })}
            />
          </Field>
          <Field label="审计保留天数" hint="1 到 3650 天；清理任务在阶段 3 接入">
            <Input
              type="number"
              min={1}
              max={3650}
              value={current.auditRetentionDays}
              onChange={(event) => setForm({ ...current, auditRetentionDays: Math.trunc(Number(event.target.value)) })}
            />
          </Field>
        </div>
        <div>
          <Button type="submit" loading={save.isPending}>
            保存面板设置
          </Button>
        </div>
      </form>

      <form
        className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={submitPassword}
      >
        <h2 className="font-semibold">修改密码</h2>
        <Field label="当前密码">
          <Input
            type="password"
            autoComplete="current-password"
            value={passwords.currentPassword}
            onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="新密码" hint="至少 12 个字符">
            <Input
              type="password"
              autoComplete="new-password"
              value={passwords.newPassword}
              onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })}
            />
          </Field>
          <Field label="确认新密码">
            <Input
              type="password"
              autoComplete="new-password"
              value={passwords.confirm}
              onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })}
            />
          </Field>
        </div>
        {passwordError && <ErrorState message={passwordError} />}
        <div>
          <Button
            type="submit"
            loading={changePassword.isPending}
            disabled={!passwords.currentPassword || !passwords.newPassword}
          >
            修改密码
          </Button>
        </div>
      </form>
    </div>
  );
}
