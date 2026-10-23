import { describe, expect, it } from 'vitest';
import { transition } from '../../src/services/state-machine';

describe('instance state machine', () => {
  it('covers the legal transitions from the spec table', () => {
    expect(transition('stopped', 'start_requested')).toBe('starting');
    expect(transition('crashed', 'start_requested')).toBe('starting');
    expect(transition('starting', 'startup_complete')).toBe('running');
    expect(transition('starting', 'process_exited')).toBe('crashed');
    expect(transition('running', 'stop_requested')).toBe('stopping');
    expect(transition('running', 'process_exited')).toBe('crashed');
    expect(transition('stopping', 'process_exited')).toBe('stopped');
    expect(transition('orphaned', 'stop_requested')).toBe('stopping');
    expect(transition('orphaned', 'kill_requested')).toBe('stopped');
    expect(transition('orphaned', 'unmanageable')).toBe('unknown');
    expect(transition('unknown', 'mark_stopped')).toBe('stopped');
    expect(transition('unknown', 'kill_requested')).toBe('stopped');
  });

  it('allows killing a managed process in every live state', () => {
    expect(transition('starting', 'kill_requested')).toBe('stopping');
    expect(transition('running', 'kill_requested')).toBe('stopping');
    expect(transition('stopping', 'kill_requested')).toBe('stopping');
  });

  it('rejects illegal transitions instead of guessing a state', () => {
    expect(transition('stopped', 'process_exited')).toBeNull();
    expect(transition('stopped', 'stop_requested')).toBeNull();
    expect(transition('running', 'start_requested')).toBeNull();
    expect(transition('stopping', 'start_requested')).toBeNull();
    expect(transition('stopping', 'startup_complete')).toBeNull();
    expect(transition('unknown', 'start_requested')).toBeNull();
    expect(transition('orphaned', 'start_requested')).toBeNull();
    expect(transition('crashed', 'stop_requested')).toBeNull();
    expect(transition('running', 'mark_stopped')).toBeNull();
  });

  it('keeps recovered states stable when re-applying recovery', () => {
    expect(transition('crashed', 'recovered_crashed')).toBe('crashed');
    expect(transition('orphaned', 'orphan_detected')).toBe('orphaned');
    expect(transition('unknown', 'orphan_detected')).toBe('orphaned');
  });
});
