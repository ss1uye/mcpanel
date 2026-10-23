import { CONSOLE_BUFFER_SIZE, type ConsoleLine } from '@mcpanel/shared';
import { stripAnsi } from '../utils/ansi';

export function classifyLevel(text: string): ConsoleLine['level'] {
  if (/\b(ERROR|SEVERE|FATAL)\b/.test(text)) return 'error';
  if (/\b(WARN|WARNING)\b/.test(text)) return 'warn';
  return 'info';
}

export { stripAnsi };

export type ConsoleSnapshot =
  | { mode: 'append'; lines: ConsoleLine[] }
  | { mode: 'snapshot'; lines: ConsoleLine[]; gap: boolean };

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private seq = 0;

  constructor(readonly capacity = CONSOLE_BUFFER_SIZE) {}

  append(input: Omit<ConsoleLine, 'seq' | 'ts'> & { ts?: string }): ConsoleLine {
    const line: ConsoleLine = {
      seq: ++this.seq,
      ts: input.ts ?? new Date().toISOString(),
      stream: input.stream,
      level: input.level,
      text: stripAnsi(input.text),
    };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    return line;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.lines.length;
  }

  snapshot(): ConsoleLine[] {
    return [...this.lines];
  }

  since(sinceSeq: number | undefined): ConsoleSnapshot {
    const first = this.lines[0]?.seq ?? this.seq + 1;
    if (sinceSeq !== undefined && sinceSeq > 0 && sinceSeq >= first - 1 && sinceSeq <= this.seq) {
      return { mode: 'append', lines: this.lines.filter((line) => line.seq > sinceSeq) };
    }
    return { mode: 'snapshot', lines: this.snapshot(), gap: this.lines.length > 0 && first > 1 };
  }
}
