import type { InstanceState } from '@mcpanel/shared';

export type InstanceAction =
  | 'start_requested'
  | 'startup_complete'
  | 'process_exited'
  | 'stop_requested'
  | 'kill_requested'
  | 'orphan_detected'
  | 'unmanageable'
  | 'mark_stopped'
  | 'recovered_stopped'
  | 'recovered_crashed';

const TABLE: Record<InstanceState, Partial<Record<InstanceAction, InstanceState>>> = {
  stopped: { start_requested: 'starting', recovered_stopped: 'stopped' },
  starting: {
    startup_complete: 'running',
    process_exited: 'crashed',
    stop_requested: 'stopping',
    kill_requested: 'stopping',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  running: {
    stop_requested: 'stopping',
    kill_requested: 'stopping',
    process_exited: 'crashed',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  stopping: {
    process_exited: 'stopped',
    kill_requested: 'stopping',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  crashed: {
    start_requested: 'starting',
    mark_stopped: 'stopped',
    kill_requested: 'stopped',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  orphaned: {
    stop_requested: 'stopping',
    kill_requested: 'stopped',
    unmanageable: 'unknown',
    orphan_detected: 'orphaned',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
  unknown: {
    kill_requested: 'stopped',
    mark_stopped: 'stopped',
    orphan_detected: 'orphaned',
    recovered_crashed: 'crashed',
    recovered_stopped: 'stopped',
  },
};

export function transition(current: InstanceState, action: InstanceAction): InstanceState | null {
  return TABLE[current][action] ?? null;
}

export function canTransition(current: InstanceState, action: InstanceAction): boolean {
  return transition(current, action) !== null;
}
