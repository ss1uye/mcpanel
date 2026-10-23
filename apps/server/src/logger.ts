import path from 'node:path';
import pino, { type Logger } from 'pino';

const redactPaths = [
  'sessionSecret',
  'config.sessionSecret',
  '*.sessionSecret',
  'password',
  '*.password',
  '*.*.password',
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  'token',
  '*.token',
  '*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
];

export function createLogger(dataDir: string, level: string, pretty: boolean): Logger {
  const options = { level, redact: { paths: redactPaths, censor: '[redacted]' } };
  if (pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
    });
  }
  return pino(
    options,
    pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(dataDir, 'logs', 'panel'),
        size: '10m',
        limit: { count: 5 },
        mkdir: true,
      },
    }),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
