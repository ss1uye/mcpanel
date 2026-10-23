import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api, ApiError, clearCsrfToken } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';

export function SetupPage() {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: () => api.get<AuthStatus>('/auth/status') });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.post('/auth/setup', { username, password }),
    onSuccess: async () => {
      clearCsrfToken();
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      navigate('/', { replace: true });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '初始化失败'),
  });

  if (status.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (status.data && !status.data.setupRequired) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('密码至少 12 个字符');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    mutation.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold">初始化面板</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">创建唯一的本机管理员账号。密码至少 12 个字符。</p>
        <div className="mt-6 flex flex-col gap-4">
          <Field label="用户名">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="确认密码">
            <Input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          {error && <ErrorState message={error} />}
          <Button type="submit" loading={mutation.isPending}>
            创建管理员
          </Button>
        </div>
      </form>
    </div>
  );
}
