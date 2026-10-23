import { describe, expect, it } from 'vitest';
import { CONSOLE_BUFFER_SIZE } from '@mcpanel/shared';
import { ConsoleBuffer, classifyLevel } from '../../src/services/console-buffer';

const ESC = String.fromCharCode(27);

describe('ConsoleBuffer', () => {
  it('increments sequence numbers and trims to capacity', () => {
    const buffer = new ConsoleBuffer(3);
    for (const text of ['a', 'b', 'c', 'd']) buffer.append({ stream: 'stdout', level: 'info', text });
    expect(buffer.snapshot().map((line) => [line.seq, line.text])).toEqual([
      [2, 'b'],
      [3, 'c'],
      [4, 'd'],
    ]);
  });

  it('defaults to the shared 5000 line capacity', () => {
    expect(new ConsoleBuffer().capacity).toBe(CONSOLE_BUFFER_SIZE);
  });

  it('returns append when sinceSeq is covered and snapshot with gap otherwise', () => {
    const buffer = new ConsoleBuffer(2);
    buffer.append({ stream: 'stdout', level: 'info', text: 'a' });
    buffer.append({ stream: 'stdout', level: 'info', text: 'b' });
    expect(buffer.since(1)).toMatchObject({ mode: 'append', lines: [expect.objectContaining({ text: 'b' })] });
    expect(buffer.since(0)).toMatchObject({ mode: 'snapshot', gap: false });
    buffer.append({ stream: 'stdout', level: 'info', text: 'c' });
    expect(buffer.since(0)).toMatchObject({ mode: 'snapshot', gap: true });
  });

  it('strips ANSI sequences when appending', () => {
    const buffer = new ConsoleBuffer();
    const line = buffer.append({
      stream: 'stdout',
      level: 'info',
      text: `${ESC}[32m[Server thread/INFO]${ESC}[0m Done`,
    });
    expect(line.text).toBe('[Server thread/INFO] Done');
  });

  it('classifies levels', () => {
    expect(classifyLevel('[Server thread/ERROR]: boom')).toBe('error');
    expect(classifyLevel('[Server thread/WARN]: careful')).toBe('warn');
    expect(classifyLevel('[Server thread/INFO]: ok')).toBe('info');
  });
});
