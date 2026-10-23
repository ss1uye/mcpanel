import path from 'node:path';
import pino, { type Logger } from 'pino';

export function createLogger(dataDir: string, level: string, pretty: boolean): Logger {
  if (pretty) {
    return pino({
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
    });
  }
  return pino(
    { level },
    pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(dataDir, 'logs', 'panel'),
        size: '10m',
        limit: { count: 5 },
        mkdir: true,
        dateFormat: 'yyyy-MM-dd',
      },
    }),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
