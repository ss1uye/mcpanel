export interface DesktopIpcTarget {
  send?: unknown;
  on(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown;
}

/**
 * Registers the optional IPC lifecycle used when the server is spawned by the
 * Electron shell. Outside Electron (npm start) process.send is undefined.
 */
export function registerDesktopIpc(
  shutdown: (reason: string) => void,
  target: DesktopIpcTarget = process as unknown as DesktopIpcTarget,
): boolean {
  if (typeof target.send !== 'function') return false;
  target.on('message', (message) => {
    if (message === 'shutdown') shutdown('desktop');
  });
  target.on('disconnect', () => shutdown('desktop-disconnect'));
  return true;
}
