import net from 'node:net';

export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try {
      server.listen({ port, host });
    } catch {
      resolve(false);
    }
  });
}
