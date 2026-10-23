import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, clearCsrfToken, downloadFile } from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearCsrfToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('fetches a CSRF token before the first mutating request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: 'abc' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(api.post('/auth/login', { username: 'admin' })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe('/api/auth/csrf');
    expect(calls[1]?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'abc' });
    expect(calls[1]?.[1]?.credentials).toBe('same-origin');
  });

  it('refreshes the token once when the server reports CSRF_INVALID', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: 'stale' }))
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { code: 'CSRF_INVALID', message: 'CSRF token 缺失或无效' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { token: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(api.post('/auth/logout')).resolves.toEqual({ ok: true });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[3]?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'fresh' });
  });

  it('throws ApiError with the server code and notifies on 401', async () => {
    const listener = vi.fn();
    window.addEventListener('mcpanel:unauthorized', listener);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }));

    const error = await api.get('/instances').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AUTH_REQUIRED');
    expect((error as ApiError).status).toBe(401);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('mcpanel:unauthorized', listener);
  });

  it('returns undefined for 204 responses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: 'abc' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.del('/instances/x', { confirmName: 'x' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports API errors from downloads without navigating the page', async () => {
    const listener = vi.fn();
    window.addEventListener('mcpanel:unauthorized', listener);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } }));

    const error = await downloadFile('/instances/x/logs/download', 'latest.log').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AUTH_REQUIRED');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('mcpanel:unauthorized', listener);
  });

  it('downloads a successful response through a blob link', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => 'blob:download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    fetchMock.mockResolvedValueOnce(new Response('log text', { status: 200 }));

    await downloadFile('/instances/x/logs/download', 'latest.log');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
    vi.unstubAllGlobals();
    click.mockRestore();
  });
});
