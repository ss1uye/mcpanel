import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerDesktopIpc } from '../../src/desktop-ipc';

function target() {
  return Object.assign(new EventEmitter(), { send: () => undefined });
}

describe('registerDesktopIpc', () => {
  it('ignores processes without an IPC channel', () => {
    expect(registerDesktopIpc(vi.fn(), new EventEmitter())).toBe(false);
  });

  it('shuts down on the desktop message and on parent disconnect', () => {
    const emitter = target();
    const shutdown = vi.fn();
    expect(registerDesktopIpc(shutdown, emitter)).toBe(true);

    emitter.emit('message', 'shutdown');
    expect(shutdown).toHaveBeenCalledWith('desktop');

    emitter.emit('disconnect');
    expect(shutdown).toHaveBeenCalledWith('desktop-disconnect');
  });

  it('ignores unrelated messages', () => {
    const emitter = target();
    const shutdown = vi.fn();
    registerDesktopIpc(shutdown, emitter);
    emitter.emit('message', 'ping');
    expect(shutdown).not.toHaveBeenCalled();
  });
});
