import { describe, expect, it } from 'vitest';
import type { ConsoleLine } from '@mcpanel/shared';
import { filterConsoleLines } from '../src/components/ConsoleViewer';

const lines: ConsoleLine[] = [
  { seq: 1, ts: '', stream: 'stdout', level: 'info', text: 'Done (12.4s)!' },
  { seq: 2, ts: '', stream: 'stdout', level: 'warn', text: "Can't keep up" },
  { seq: 3, ts: '', stream: 'stderr', level: 'error', text: 'Address already in use' },
];

describe('filterConsoleLines', () => {
  it('filters by level and case-insensitive search', () => {
    expect(filterConsoleLines(lines, 'error', '').map((line) => line.seq)).toEqual([3]);
    expect(filterConsoleLines(lines, 'all', 'ADDRESS').map((line) => line.seq)).toEqual([3]);
    expect(filterConsoleLines(lines, 'all', '')).toHaveLength(3);
  });

  it('combines level and search without dropping order', () => {
    expect(filterConsoleLines(lines, 'warn', 'keep').map((line) => line.seq)).toEqual([2]);
    expect(filterConsoleLines(lines, 'info', 'nothing')).toEqual([]);
  });
});
