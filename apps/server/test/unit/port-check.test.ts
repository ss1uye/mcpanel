import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isPortFree } from '../../src/nodes/port-check';

describe('isPortFree', () => {
  it('detects an occupied port and a free one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    expect(await isPortFree(address.port, '127.0.0.1')).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortFree(address.port, '127.0.0.1')).toBe(true);
  });
});
