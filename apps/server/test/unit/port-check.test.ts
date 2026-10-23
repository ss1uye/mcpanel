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

  it('treats invalid, non-integer and out-of-range ports as not free', async () => {
    expect(await isPortFree(0)).toBe(false);
    expect(await isPortFree(65536)).toBe(false);
    expect(await isPortFree(70000)).toBe(false);
    expect(await isPortFree(25565.5)).toBe(false);
    expect(await isPortFree(Number.NaN)).toBe(false);
    expect(await isPortFree(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
