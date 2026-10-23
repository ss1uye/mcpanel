import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api, ApiError, clearCsrfToken } from '../api/client';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';

export function LoginPage() {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: () => api.get<AuthStatus>('/auth/status') });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => api.post('/auth/login', { username, password }),
    onSuccess: async () => {
      clearCsrfToken();
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      const next = params.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '登录失败'),
  });

  if (status.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (status.data?.authenticated) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  };

  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold">登录 MC Panel</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">管理本机 Minecraft 服务器</p>
        <div className="mt-6 flex flex-col gap-4">
          <Field label="用户名">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <ErrorState message={error} />}
          <Button type="submit" loading={mutation.isPending}>
            登录
          </Button>
        </div>
      </form>
    </div>
  );
}
