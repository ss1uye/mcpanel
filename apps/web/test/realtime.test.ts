import { describe, expect, it } from 'vitest';
import type { ConsoleLine, ServerWsMessage } from '@mcpanel/shared';
import { emptyRealtime, reduceRealtime } from '../src/stores/realtime';

const id = '11111111-1111-4111-8111-111111111111';
const channel = `instance:${id}:console`;

function line(seq: number, text = `t${seq}`): ConsoleLine {
  return { seq, ts: '2026-10-23T00:00:00.000Z', stream: 'stdout', level: 'info', text };
}

describe('reduceRealtime', () => {
  it('stores a snapshot and appends new lines without duplicates', () => {
    const snapshot: ServerWsMessage = {
      type: 'console.snapshot',
      channel,
      lines: [line(1)],
      lastSeq: 1,
      gap: false,
    };
    let state = reduceRealtime(emptyRealtime, snapshot);
    state = reduceRealtime(state, { type: 'console.append', channel, lines: [line(2), line(2)] });
    const consoleState = state.console[id];
    expect(consoleState?.lines.map((entry) => entry.text)).toEqual(['t1', 't2']);
    expect(consoleState?.lastSeq).toBe(2);
  });

  it('marks gaps and never keeps more than 5000 lines', () => {
    const lines = Array.from({ length: 5001 }, (_value, index) => line(index + 1));
    let state = reduceRealtime(emptyRealtime, { type: 'console.snapshot', channel, lines, lastSeq: 5001, gap: false });
    expect(state.console[id]?.lines).toHaveLength(5000);
    expect(state.console[id]?.lastSeq).toBe(5001);
    state = reduceRealtime(state, { type: 'console.gap', channel, dropped: 5 });
    expect(state.console[id]?.gap).toBe(true);
  });

  it('merges instance state, system and instance metrics samples', () => {
    let state = reduceRealtime(emptyRealtime, {
      type: 'instance.state',
      instanceId: id,
      state: 'running',
      pid: 12,
      startedAt: null,
      error: null,
    });
    expect(state.console[id]).toBeUndefined();
    expect(state.states[id]?.state).toBe('running');

    const system = { ts: 'now', cpuPercent: 1, memUsedBytes: 2, memTotalBytes: 3, diskFreeBytes: 4, diskTotalBytes: 5, uptimeSec: 6, platform: 'win32', arch: 'x64', nodeVersion: 'v24', panelVersion: '0.1.0' } as const;
    state = reduceRealtime(state, { type: 'metrics.sample', target: 'system', ts: system.ts, sample: system });
    expect(state.systemMetrics).toHaveLength(1);

    const process = { ts: 'now', cpu: 5, memBytes: 100, diskFreeBytes: 200 };
    for (let index = 0; index < 70; index += 1) {
      state = reduceRealtime(state, { type: 'metrics.sample', target: 'instance', instanceId: id, ts: `t${index}`, sample: process });
    }
    expect(state.instanceMetrics[id]).toHaveLength(60);
  });

  it('ignores unrelated frames', () => {
    const state = reduceRealtime(emptyRealtime, { type: 'pong' });
    expect(state).toEqual(emptyRealtime);
  });
});
