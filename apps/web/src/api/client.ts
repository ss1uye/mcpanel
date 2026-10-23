import type { ApiErrorBody } from '@mcpanel/shared';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const UNAUTHORIZED_EVENT = 'mcpanel:unauthorized';

let csrfToken: string | null = null;

/** The token is bound to the session server-side, so it must be dropped on login/logout. */
export function clearCsrfToken(): void {
  csrfToken = null;
}

async function refreshCsrf(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('INTERNAL', '无法获取 CSRF token', response.status);
  const body = (await response.json()) as { token: string };
  csrfToken = body.token;
  return csrfToken;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  retryCsrf?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken ?? (await refreshCsrf());

  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const code = data?.error.code ?? 'INTERNAL';
    if (response.status === 403 && code === 'CSRF_INVALID' && options.retryCsrf !== false) {
      clearCsrfToken();
      return apiRequest<T>(path, { ...options, retryCsrf: false });
    }
    if (response.status === 401 && !path.startsWith('/auth/')) {
      clearCsrfToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(code, data?.error.message ?? `请求失败（HTTP ${response.status}）`, response.status, data?.error.details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};
