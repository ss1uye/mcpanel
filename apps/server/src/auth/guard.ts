import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '@mcpanel/shared';
import type { SessionService } from '../auth/session';
import { AppError } from '../utils/errors';

const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

export class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  assertAllowed(ip: string): void {
    const entry = this.entries.get(ip);
    if (!entry?.lockedUntil) return;
    if (entry.lockedUntil > this.now()) {
      const minutes = Math.max(1, Math.ceil((entry.lockedUntil - this.now()) / 60_000));
      throw new AppError('LOGIN_RATE_LIMITED', `登录失败次数过多，请 ${minutes} 分钟后重试`);
    }
    this.entries.delete(ip);
  }

  recordFailure(ip: string): void {
    const entry = this.entries.get(ip) ?? { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) {
      entry.failures = 0;
      entry.lockedUntil = this.now() + LOCK_MS;
    }
    this.entries.set(ip, entry);
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }
}

export function csrfUserInfo(request: FastifyRequest): string {
  return request.cookies[SESSION_COOKIE] ?? 'anonymous';
}

// URL normalises away the default port, so "http://host:80" and "host" are the
// same authority. Compare both sides through URL to avoid false rejections.
export function isSameAuthority(source: string, requestHost: string): boolean {
  try {
    const origin = new URL(source);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    return origin.host === new URL(`http://${requestHost}`).host;
  } catch {
    return false;
  }
}

export function createGuards(sessions: SessionService) {
  const requireAuth = async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? sessions.resolve(token) : null;
    if (!token || !resolved) {
      throw new AppError('AUTH_REQUIRED', '请先登录');
    }
    request.user = resolved.user;
    request.sessionToken = token;
  };

  const requireOrigin = async (request: FastifyRequest): Promise<void> => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const source = request.headers.origin ?? request.headers.referer;
    if (!source) throw new AppError('FORBIDDEN', '缺少来源信息');
    if (!isSameAuthority(source, request.headers.host ?? '')) throw new AppError('FORBIDDEN', '来源校验失败');
  };

  const setSessionCookie = (reply: FastifyReply, token: string, secure: boolean): void => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: SESSION_MAX_AGE_SEC,
    });
  };

  const clearSessionCookie = (reply: FastifyReply): void => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  };

  return { requireAuth, requireOrigin, setSessionCookie, clearSessionCookie };
}
