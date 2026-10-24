import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from '../components/ui';
import type {
  ConsoleLine,
  InstanceStatusSnapshot,
  ProcessMetricsSample,
  ServerWsMessage,
  SystemMetricsSample,
  TaskInfo,
} from '@mcpanel/shared';

const MAX_LINES = 5000;
const MAX_SAMPLES = 60;
const PING_INTERVAL_MS = 30_000;

export interface ConsoleState {
  lines: ConsoleLine[];
  lastSeq: number;
  gap: boolean;
}

export interface RealtimeState {
  connection: 'closed' | 'connecting' | 'open';
  subscribed: boolean;
  console: Record<string, ConsoleState>;
  states: Record<string, InstanceStatusSnapshot>;
  systemMetrics: SystemMetricsSample[];
  instanceMetrics: Record<string, ProcessMetricsSample[]>;
  tasks: Record<string, TaskInfo>;
}

export const EMPTY_CONSOLE: ConsoleState = { lines: [], lastSeq: 0, gap: false };
export const EMPTY_METRICS: ProcessMetricsSample[] = [];

export const emptyRealtime: RealtimeState = {
  connection: 'closed',
  subscribed: false,
  console: {},
  states: {},
  systemMetrics: [],
  instanceMetrics: {},
  tasks: {},
};

function channelInstance(channel: string): string | undefined {
  const [kind, id] = channel.split(':');
  return kind === 'instance' ? id : undefined;
}

export function reduceRealtime(state: RealtimeState, message: ServerWsMessage): RealtimeState {
  switch (message.type) {
    case 'console.snapshot': {
      const id = channelInstance(message.channel);
      if (!id) return state;
      return {
        ...state,
        console: {
          ...state.console,
          [id]: {
            lines: message.lines.slice(-MAX_LINES),
            lastSeq: message.lines.at(-1)?.seq ?? message.lastSeq,
            gap: message.gap,
          },
        },
      };
    }
    case 'console.append': {
      const id = channelInstance(message.channel);
      if (!id) return state;
      const previous = state.console[id] ?? EMPTY_CONSOLE;
      const seen = new Set(previous.lines.map((line) => line.seq));
      const additions: ConsoleLine[] = [];
      for (const line of message.lines) {
        if (seen.has(line.seq)) continue;
        seen.add(line.seq);
        additions.push(line);
      }
      const merged = [...previous.lines, ...additions].slice(-MAX_LINES);
      return {
        ...state,
        console: {
          ...state.console,
          [id]: { lines: merged, lastSeq: merged.at(-1)?.seq ?? previous.lastSeq, gap: previous.gap },
        },
      };
    }
    case 'console.gap': {
      const id = channelInstance(message.channel);
      if (!id) return state;
      const previous = state.console[id] ?? EMPTY_CONSOLE;
      return { ...state, console: { ...state.console, [id]: { ...previous, gap: true } } };
    }
    case 'instance.state':
      return {
        ...state,
        states: {
          ...state.states,
          [message.instanceId]: {
            instanceId: message.instanceId,
            state: message.state,
            pid: message.pid,
            startedAt: message.startedAt,
            exitCode: state.states[message.instanceId]?.exitCode ?? null,
            error: message.error,
          },
        },
      };
    case 'metrics.sample':
      if (message.target === 'system') {
        return { ...state, systemMetrics: [...state.systemMetrics, message.sample].slice(-MAX_SAMPLES) };
      }
      return {
        ...state,
        instanceMetrics: {
          ...state.instanceMetrics,
          [message.instanceId]: [...(state.instanceMetrics[message.instanceId] ?? []), message.sample].slice(-MAX_SAMPLES),
        },
      };
    case 'task.update':
      return { ...state, tasks: { ...state.tasks, [message.task.id]: message.task } };
    default:
      return state;
  }
}

interface RealtimeStore extends RealtimeState {
  apply: (message: ServerWsMessage) => void;
  setConnection: (connection: RealtimeState['connection']) => void;
}

export const useRealtime = create<RealtimeStore>((set) => ({
  ...emptyRealtime,
  apply: (message) => {
    if (message.type === 'notification') {
      toast(message.message, message.level === 'error' ? 'error' : message.level === 'warning' ? 'info' : 'info');
    }
    set((state) => reduceRealtime(state, message));
  },
  setConnection: (connection) => set({ connection }),
}));

const references = new Map<string, number>();
let socket: WebSocket | null = null;
let pingTimer: number | null = null;
let reconnectTimer: number | null = null;
let attempts = 0;
let intentionallyClosed = false;

function lastSeqFor(channel: string): number | undefined {
  const id = channelInstance(channel);
  if (!id || !channel.endsWith(':console')) return undefined;
  return useRealtime.getState().console[id]?.lastSeq;
}

function post(message: { type: string; channel?: string; sinceSeq?: number }): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function ensureSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  intentionallyClosed = false;
  useRealtime.getState().setConnection('connecting');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
  socket = current;

  current.addEventListener('open', () => {
    attempts = 0;
    useRealtime.getState().setConnection('open');
    for (const channel of references.keys()) {
      post({ type: 'subscribe', channel, sinceSeq: lastSeqFor(channel) });
    }
    pingTimer = window.setInterval(() => post({ type: 'ping' }), PING_INTERVAL_MS);
  });

  current.addEventListener('message', (event) => {
    try {
      useRealtime.getState().apply(JSON.parse(String(event.data)) as ServerWsMessage);
    } catch {
      // ignore malformed frames
    }
  });

  current.addEventListener('close', () => {
    // A late close from a superseded socket must not tear down the replacement connection.
    if (socket !== current) return;
    useRealtime.getState().setConnection('closed');
    if (pingTimer !== null) window.clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    if (!intentionallyClosed && references.size > 0) scheduleReconnect();
  });

  current.addEventListener('error', () => {
    current.close();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(30_000, 1000 * 2 ** attempts);
  attempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (references.size > 0) ensureSocket();
  }, delay);
}

function syncSubscribed(): void {
  useRealtime.setState({ subscribed: references.size > 0 });
}

export function subscribeChannel(channel: string): void {
  const next = (references.get(channel) ?? 0) + 1;
  references.set(channel, next);
  syncSubscribed();
  if (next === 1) {
    ensureSocket();
    post({ type: 'subscribe', channel, sinceSeq: lastSeqFor(channel) });
  }
}

export function unsubscribeChannel(channel: string): void {
  const next = Math.max(0, (references.get(channel) ?? 0) - 1);
  if (next === 0) {
    references.delete(channel);
    post({ type: 'unsubscribe', channel });
  } else {
    references.set(channel, next);
  }
  syncSubscribed();
}

export function disconnectRealtime(): void {
  intentionallyClosed = true;
  references.clear();
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (pingTimer !== null) window.clearInterval(pingTimer);
  pingTimer = null;
  socket?.close();
  socket = null;
  // Logged-out operators must not see the previous session's console lines until fresh snapshots arrive.
  useRealtime.setState({ ...emptyRealtime, connection: 'closed' });
}

export function useConnectionState(): RealtimeState['connection'] {
  return useRealtime((state) => state.connection);
}

export function useInstanceStatus(instanceId: string): InstanceStatusSnapshot | null {
  const status = useRealtime((state) => state.states[instanceId] ?? null);
  useEffect(() => {
    const channel = `instance:${instanceId}:status`;
    subscribeChannel(channel);
    return () => unsubscribeChannel(channel);
  }, [instanceId]);
  return status;
}

export function useInstanceConsole(instanceId: string): ConsoleState {
  const state = useRealtime((store) => store.console[instanceId] ?? EMPTY_CONSOLE);
  useEffect(() => {
    const channel = `instance:${instanceId}:console`;
    subscribeChannel(channel);
    return () => unsubscribeChannel(channel);
  }, [instanceId]);
  return state;
}

export function useInstanceMetrics(instanceId: string): ProcessMetricsSample[] {
  const samples = useRealtime((state) => state.instanceMetrics[instanceId] ?? EMPTY_METRICS);
  useEffect(() => {
    const channel = `instance:${instanceId}:metrics`;
    subscribeChannel(channel);
    return () => unsubscribeChannel(channel);
  }, [instanceId]);
  return samples;
}

export function useSystemMetrics(): SystemMetricsSample[] {
  const samples = useRealtime((state) => state.systemMetrics);
  useEffect(() => {
    subscribeChannel('system:metrics');
    return () => unsubscribeChannel('system:metrics');
  }, []);
  return samples;
}

export function useTask(taskId: string | null): TaskInfo | undefined {
  const task = useRealtime((state) => (taskId ? state.tasks[taskId] : undefined));
  useEffect(() => {
    if (!taskId) return;
    const channel = `task:${taskId}`;
    subscribeChannel(channel);
    return () => unsubscribeChannel(channel);
  }, [taskId]);
  return task;
}
