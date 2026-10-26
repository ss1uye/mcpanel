import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../src/components/ui';
import {
  disconnectRealtime,
  subscribeChannel,
  unsubscribeChannel,
  useRealtime,
} from '../src/stores/realtime';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  framesOf(type: string): string[] {
    return this.sent.filter((frame) => JSON.parse(frame).type === type);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  disconnectRealtime();
  vi.unstubAllGlobals();
});

describe('realtime channel references', () => {
  it('opens one socket and re-subscribes every referenced channel', () => {
    subscribeChannel('instance:a:console');
    subscribeChannel('instance:a:console');
    subscribeChannel('system:metrics');

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.framesOf('subscribe')).toHaveLength(2);
    expect(socket.url.endsWith('/api/ws')).toBe(true);
  });

  it('keeps the channel subscribed until every holder releases it', () => {
    subscribeChannel('instance:a:console');
    subscribeChannel('instance:a:console');
    const socket = FakeWebSocket.instances[0]!;

    unsubscribeChannel('instance:a:console');
    expect(socket.framesOf('unsubscribe')).toHaveLength(0);

    unsubscribeChannel('instance:a:console');
    expect(socket.framesOf('unsubscribe')).toHaveLength(1);
  });

  it('drops buffered data on logout so the next session starts clean', () => {
    const socket = (subscribeChannel('instance:a:console'), FakeWebSocket.instances[0]!);
    socket.emit('message', {
      data: JSON.stringify({
        type: 'console.snapshot',
        channel: 'instance:a:console',
        lines: [{ seq: 1, ts: '2026-10-24T00:00:00.000Z', stream: 'stdout', level: 'info', text: 'secret line' }],
        lastSeq: 1,
        gap: false,
      }),
    });
    expect(useRealtime.getState().console['a']?.lines).toHaveLength(1);

    disconnectRealtime();

    const after = useRealtime.getState();
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(after.connection).toBe('closed');
    expect(after.console).toEqual({});
    expect(after.states).toEqual({});
    expect(after.systemMetrics).toEqual([]);
    expect(after.instanceMetrics).toEqual({});
  });

  it('marks the store as subscribed only while a channel is held', () => {
    expect(useRealtime.getState().subscribed).toBe(false);
    subscribeChannel('instance:a:console');
    expect(useRealtime.getState().subscribed).toBe(true);
    unsubscribeChannel('instance:a:console');
    expect(useRealtime.getState().subscribed).toBe(false);
  });

  it('surfaces server notifications as toasts instead of dropping them', () => {
    subscribeChannel('instance:a:console');
    const socket = FakeWebSocket.instances[0]!;

    socket.emit('message', {
      data: JSON.stringify({ type: 'notification', level: 'warning', message: '进程未被面板接管' }),
    });

    expect(useToastStore.getState().items.map((item) => item.message)).toContain('进程未被面板接管');
  });

  it('closes a connection that stops receiving heartbeats', () => {
    vi.useFakeTimers();
    try {
      subscribeChannel('system:metrics');
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open', {});
      vi.advanceTimersByTime(80_000);
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the connection while server messages keep arriving', () => {
    vi.useFakeTimers();
    try {
      subscribeChannel('system:metrics');
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open', {});
      vi.advanceTimersByTime(60_000);
      socket.emit('message', { data: JSON.stringify({ type: 'pong' }) });
      vi.advanceTimersByTime(30_000);
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late close from a superseded socket', () => {
    subscribeChannel('instance:a:console');
    const stale = FakeWebSocket.instances[0]!;
    disconnectRealtime();

    subscribeChannel('instance:a:console');
    const current = FakeWebSocket.instances[1]!;
    stale.emit('close', {});

    expect(useRealtime.getState().connection).not.toBe('closed');
    expect(current.readyState).toBe(FakeWebSocket.OPEN);
  });
});
