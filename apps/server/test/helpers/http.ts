import type { LightMyRequestResponse } from 'fastify';

export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(response: LightMyRequestResponse): void {
    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const cookie of cookies) {
      const pair = cookie.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) this.jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  header(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

export const TEST_ORIGIN = 'http://localhost:80';
