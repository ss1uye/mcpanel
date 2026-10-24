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
    const code = data?.error?.code ?? 'INTERNAL';
    if (response.status === 403 && code === 'CSRF_INVALID' && options.retryCsrf !== false) {
      clearCsrfToken();
      return apiRequest<T>(path, { ...options, retryCsrf: false });
    }
    if (response.status === 401 && !path.startsWith('/auth/')) {
      clearCsrfToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(code, data?.error?.message ?? `请求失败（HTTP ${response.status}）`, response.status, data?.error?.details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<WritableStream<Uint8Array>>;
  }>;
};

/**
 * Downloads via fetch so an expired session yields a handled 401 instead of a
 * JSON page replacing the SPA. Large bodies (multi-GB backups) stream straight
 * to disk when the File System Access API is available; buffering them into a
 * blob would freeze the tab.
 */
export async function downloadFile(path: string, filename: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', signal });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401) {
      clearCsrfToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(
      data?.error?.code ?? 'INTERNAL',
      data?.error?.message ?? `下载失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  const body = response.body;
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (body && picker) {
    let streaming = false;
    try {
      const file = await picker({ suggestedName: filename });
      const writable = await file.createWritable();
      streaming = true;
      await body.pipeTo(writable, { signal });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // User dismissed the save dialog or cancelled the download; discard the stream.
        await body.cancel().catch(() => undefined);
        return;
      }
      if (streaming) throw error;
      // Picker unusable before any data flowed (e.g. lost user activation) — fall through.
    }
  }

  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'DELETE', body }),
};

export async function uploadFile<T>(path: string, formData: FormData): Promise<T> {
  const send = (token: string) =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': token },
      body: formData,
    });

  let response = await send(csrfToken ?? (await refreshCsrf()));
  if (response.status === 403) {
    const probe = (await response.clone().json().catch(() => null)) as ApiErrorBody | null;
    if (probe?.error?.code === 'CSRF_INVALID') {
      clearCsrfToken();
      response = await send(await refreshCsrf());
    }
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      data?.error?.code ?? 'INTERNAL',
      data?.error?.message ?? `上传失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return (await response.json()) as T;
}
