# MC Panel Electron Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MC Panel 0.4.0 as a Windows Electron desktop app that starts the existing Fastify panel as a child process and opens it in a native window.

**Architecture:** Electron main process owns the window, tray and lifecycle. The existing Node 24 server payload (from the portable build) runs as an IPC-connected child process on `127.0.0.1:<random port>`; Electron loads that URL in a sandboxed BrowserWindow. electron-builder produces an NSIS installer and a portable exe. No server API or database changes.

**Tech Stack:** Electron 45, electron-builder 26, Node 24 child process, Fastify 5 (existing), React 19 (existing), TypeScript, tsup, Vitest, Playwright Electron, GitHub Actions.

---

## File map

```text
apps/desktop/
├─ package.json                  # new workspace
├─ tsconfig.json
├─ tsup.config.ts                # main.cjs + preload.cjs
├─ vitest.config.ts
├─ electron-builder.yml
├─ src/
│  ├─ main.ts                    # app lifecycle, window, IPC, data import
│  ├─ preload.ts                 # contextBridge API
│  ├─ server-process.ts          # port, spawn, health, IPC shutdown
│  ├─ preferences.ts             # desktop.json
│  ├─ runtime.ts                 # runtime.json + orphan detection
│  ├─ paths.ts                   # userData/data/log paths
│  ├─ data-import.ts             # import existing portable data
│  └─ tray.ts                    # tray menu
├─ test/
│  ├─ preferences.test.ts
│  ├─ runtime.test.ts
│  ├─ paths.test.ts
│  ├─ data-import.test.ts
│  └─ server-process.test.ts
└─ build/                        # gitignored: server payload + icons

apps/server/
├─ src/desktop-ipc.ts            # new
├─ src/index.ts                  # modify: register IPC
└─ test/unit/desktop-ipc.test.ts # new

apps/web/
├─ src/api/client.ts             # modify: desktop download bridge
└─ test/api-client.test.ts       # modify: bridge test

scripts/
├─ package-portable.mjs          # modify: --no-zip
├─ prepare-desktop-payload.mjs   # new
├─ make-icon.mjs                 # new
├─ smoke-desktop.mjs             # new
└─ release-checksums.mjs         # new

e2e/desktop/smoke.spec.ts        # new
playwright.desktop.config.ts     # new
packaging/icon.png               # generated, tracked
packaging/icon.ico               # generated, tracked
```

No changes to `apps/server/src/db`, migrations, or the HTTP API.

---

## Task 1: Server desktop IPC

**Files:**
- Create: `apps/server/src/desktop-ipc.ts`
- Create: `apps/server/test/unit/desktop-ipc.test.ts`
- Modify: `apps/server/src/index.ts` (import + register after `shutdown`)

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run it and verify RED**

Run: `npx vitest run --root apps/server test/unit/desktop-ipc.test.ts`
Expected: FAIL because `../../src/desktop-ipc` does not exist.

- [ ] **Step 3: Implement the module**

```ts
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
```

- [ ] **Step 4: Wire it into the server entry**

In `apps/server/src/index.ts`, add:

```ts
import { registerDesktopIpc } from './desktop-ipc';
```

After the `shutdown` function declaration (before the signal handlers), add:

```ts
registerDesktopIpc((reason) => void shutdown(reason, 0));
```

Do not add an HTTP shutdown endpoint.

- [ ] **Step 5: Verify**

Run:

```bash
npx vitest run --root apps/server test/unit/desktop-ipc.test.ts
npm run typecheck -w @mcpanel/server
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/desktop-ipc.ts apps/server/src/index.ts apps/server/test/unit/desktop-ipc.test.ts
git commit -m "feat(server): support desktop IPC shutdown"
```

---

## Task 2: Desktop workspace, paths and preferences

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsup.config.ts`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/src/paths.ts`
- Create: `apps/desktop/src/preferences.ts`
- Create: `apps/desktop/test/paths.test.ts`
- Create: `apps/desktop/test/preferences.test.ts`
- Create: `apps/desktop/src/main.ts` (temporary working shell, replaced in Task 5)

- [ ] **Step 0: Bump the workspace to 0.4.0**

Update the version to `0.4.0` in:

- root `package.json`
- `apps/server/package.json` (`version` and `@mcpanel/shared`)
- `apps/web/package.json` (`version` and `@mcpanel/shared`)
- `packages/shared/package.json`
- `packages/shared/src/constants.ts` (`PANEL_VERSION`)

Run `npm install` so `package-lock.json` records the new workspace versions.
The `apps/desktop` package is created in Step 1 at the same version.

- [ ] **Step 1: Add the workspace package**

`apps/desktop/package.json`:

```json
{
  "name": "@mcpanel/desktop",
  "version": "0.4.0",
  "private": true,
  "productName": "MC Panel",
  "type": "module",
  "main": "dist/main.cjs",
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "package": "electron-builder --win nsis portable --x64 --config electron-builder.yml"
  },
  "devDependencies": {
    "electron": "^45.0.0",
    "electron-builder": "^26.18.0",
    "vitest": "^5.0.5"
  }
}
```

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`apps/desktop/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/preload.ts'],
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  outExtension: () => ({ js: '.cjs' }),
  external: ['electron'],
});
```

`apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 2: Add a temporary working main**

`apps/desktop/src/main.ts`:

```ts
import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 600 });
  void window.loadURL('data:text/html,<h1>MC Panel Desktop</h1>');
});

app.on('window-all-closed', () => app.quit());
```

This is replaced by the real shell in Task 5.

- [ ] **Step 3: Install the workspace**

Run: `npm install`
Expected: Electron and electron-builder install; `package-lock.json` updates.

- [ ] **Step 4: Add paths and preferences with failing tests first**

`apps/desktop/test/paths.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopPaths, resolveUserDataDir } from '../src/paths';

describe('desktop paths', () => {
  it('uses the portable data directory next to the exe', () => {
    expect(
      resolveUserDataDir({ portableExecutableDir: 'D:\\MC Panel', appDataDir: 'C:\\Users\\u\\AppData\\Roaming' }),
    ).toBe(path.join('D:\\MC Panel', 'mcpanel-data'));
  });

  it('uses %APPDATA%\\MC Panel for the installed app', () => {
    expect(resolveUserDataDir({ appDataDir: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'MC Panel'),
    );
  });

  it('uses a unique temp directory in smoke mode', () => {
    expect(
      resolveUserDataDir({ appDataDir: 'C:\\Users\\u\\AppData\\Roaming', smokeTest: true, tempDir: 'C:\\Temp', pid: 42 }),
    ).toBe(path.join('C:\\Temp', 'mcpanel-desktop-smoke-42'));
  });

  it('derives data, preferences, runtime and log paths', () => {
    const paths = resolveDesktopPaths('C:\\Users\\u\\AppData\\Roaming\\MC Panel');
    expect(paths.dataDir).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'data'));
    expect(paths.preferencesFile).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'desktop.json'));
    expect(paths.runtimeFile).toBe(path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'runtime.json'));
    expect(paths.desktopLogFile).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming\\MC Panel', 'data', 'logs', 'desktop.log'),
    );
  });
});
```

`apps/desktop/test/preferences.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from '../src/preferences';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-prefs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop preferences', () => {
  it('returns defaults for a missing or malformed file', () => {
    const dir = temp();
    expect(loadPreferences(path.join(dir, 'missing.json'))).toEqual(DEFAULT_PREFERENCES);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(loadPreferences(path.join(dir, 'bad.json'))).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads booleans and ignores invalid fields', () => {
    const file = path.join(temp(), 'desktop.json');
    fs.writeFileSync(file, JSON.stringify({ autoLaunch: true, minimizeToTray: 'yes' }));
    expect(loadPreferences(file)).toEqual({ autoLaunch: true, minimizeToTray: DEFAULT_PREFERENCES.minimizeToTray });
  });

  it('round-trips values atomically', () => {
    const file = path.join(temp(), 'desktop.json');
    savePreferences(file, { autoLaunch: true, minimizeToTray: false });
    expect(loadPreferences(file)).toEqual({ autoLaunch: true, minimizeToTray: false });
  });
});
```

Run: `npx vitest run --root apps/desktop test/paths.test.ts test/preferences.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 5: Implement paths and preferences**

`apps/desktop/src/paths.ts`:

```ts
import path from 'node:path';

export interface DesktopPaths {
  userDataDir: string;
  dataDir: string;
  preferencesFile: string;
  runtimeFile: string;
  desktopLogFile: string;
}

export interface UserDataInput {
  portableExecutableDir?: string;
  appDataDir: string;
  smokeTest?: boolean;
  tempDir?: string;
  pid?: number;
}

export function resolveUserDataDir(input: UserDataInput): string {
  if (input.smokeTest) {
    return path.join(input.tempDir ?? '', `mcpanel-desktop-smoke-${input.pid ?? process.pid}`);
  }
  if (input.portableExecutableDir) return path.join(input.portableExecutableDir, 'mcpanel-data');
  return path.join(input.appDataDir, 'MC Panel');
}

export function resolveDesktopPaths(userDataDir: string): DesktopPaths {
  const dataDir = path.join(userDataDir, 'data');
  return {
    userDataDir,
    dataDir,
    preferencesFile: path.join(userDataDir, 'desktop.json'),
    runtimeFile: path.join(userDataDir, 'runtime.json'),
    desktopLogFile: path.join(dataDir, 'logs', 'desktop.log'),
  };
}
```

`apps/desktop/src/preferences.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface Preferences {
  autoLaunch: boolean;
  minimizeToTray: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { autoLaunch: false, minimizeToTray: true };

export function loadPreferences(file: string): Preferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Preferences> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };
    return {
      autoLaunch: typeof parsed.autoLaunch === 'boolean' ? parsed.autoLaunch : DEFAULT_PREFERENCES.autoLaunch,
      minimizeToTray:
        typeof parsed.minimizeToTray === 'boolean' ? parsed.minimizeToTray : DEFAULT_PREFERENCES.minimizeToTray,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(file: string, preferences: Preferences): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
```

- [ ] **Step 6: Verify**

Run:

```bash
npx vitest run --root apps/desktop test/paths.test.ts test/preferences.test.ts
npm run build -w @mcpanel/desktop
npm run typecheck -w @mcpanel/desktop
```

Expected: tests and build pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json apps/server/package.json apps/web/package.json packages/shared/package.json packages/shared/src/constants.ts apps/desktop
git commit -m "feat(desktop): scaffold workspace and preferences"
```

---

## Task 3: Runtime metadata, orphan detection and data import

**Files:**
- Create: `apps/desktop/src/runtime.ts`
- Create: `apps/desktop/src/data-import.ts`
- Create: `apps/desktop/test/runtime.test.ts`
- Create: `apps/desktop/test/data-import.test.ts`

- [ ] **Step 1: Write the failing runtime tests**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRuntime, readRuntime, stopOrphan, writeRuntime } from '../src/runtime';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-runtime-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runtime metadata', () => {
  it('round-trips pid and port', () => {
    const file = path.join(temp(), 'runtime.json');
    writeRuntime(file, { pid: 1234, port: 3123 });
    expect(readRuntime(file)).toEqual({ pid: 1234, port: 3123 });
    clearRuntime(file);
    expect(readRuntime(file)).toBeNull();
  });

  it('rejects malformed entries', () => {
    const file = path.join(temp(), 'runtime.json');
    fs.writeFileSync(file, JSON.stringify({ pid: -1, port: 'x' }));
    expect(readRuntime(file)).toBeNull();
  });
});

describe('stopOrphan', () => {
  const info = { pid: 1234, port: 3123 };

  it('does nothing when the saved pid is dead', async () => {
    const kill = vi.fn();
    await expect(stopOrphan(info, { isAlive: () => false, health: async () => true, kill })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill a reused pid when the panel health check fails', async () => {
    const kill = vi.fn();
    await expect(stopOrphan(info, { isAlive: () => true, health: async () => false, kill })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills only the saved panel pid when it answers health', async () => {
    let alive = true;
    const kill = vi.fn(() => {
      alive = false;
    });
    await expect(
      stopOrphan(info, {
        isAlive: () => alive,
        health: async () => true,
        kill,
        wait: async () => undefined,
      }),
    ).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(1234);
  });
});
```

`apps/desktop/test/data-import.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importPanelData, isPanelDataDir } from '../src/data-import';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-desktop-import-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('importPanelData', () => {
  it('copies an existing panel data directory', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    fs.writeFileSync(path.join(source, 'secret.key'), 'secret');
    fs.mkdirSync(path.join(source, 'backups'));
    const target = path.join(temp(), 'data');

    expect(isPanelDataDir(source)).toBe(true);
    await importPanelData(source, target);
    expect(fs.readFileSync(path.join(target, 'panel.db'), 'utf8')).toBe('db');
    expect(fs.readFileSync(path.join(target, 'secret.key'), 'utf8')).toBe('secret');
    expect(fs.statSync(path.join(target, 'backups')).isDirectory()).toBe(true);
  });

  it('rejects a directory without panel.db', async () => {
    await expect(importPanelData(temp(), path.join(temp(), 'data'))).rejects.toThrow(/panel\.db/);
  });

  it('rejects an already initialized target', async () => {
    const source = temp();
    fs.writeFileSync(path.join(source, 'panel.db'), 'db');
    const target = temp();
    fs.writeFileSync(path.join(target, 'panel.db'), 'existing');
    await expect(importPanelData(source, target)).rejects.toThrow(/已有面板数据/);
  });
});
```

Run: `npx vitest run --root apps/desktop test/runtime.test.ts test/data-import.test.ts`
Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Implement runtime and data import**

`apps/desktop/src/runtime.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeInfo {
  pid: number;
  port: number;
}

export interface OrphanDeps {
  isAlive?: (pid: number) => boolean;
  health?: (port: number) => Promise<boolean>;
  kill?: (pid: number) => void;
  wait?: (ms: number) => Promise<void>;
}

export function readRuntime(file: string): RuntimeInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeInfo>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      parsed.port <= 65535
    ) {
      return { pid: parsed.pid, port: parsed.port };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeRuntime(file: string, info: RuntimeInfo): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(info)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function clearRuntime(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function stopOrphan(info: RuntimeInfo, deps: OrphanDeps = {}): Promise<boolean> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const health = deps.health ?? (async () => false);
  const kill = deps.kill ?? ((pid: number) => process.kill(pid));
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (!isAlive(info.pid)) return false;
  // A reused PID must never be killed unless the saved port still answers as our panel.
  if (!(await health(info.port))) return false;
  try {
    kill(info.pid);
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isAlive(info.pid)) return true;
    await wait(500);
  }
  return !isAlive(info.pid);
}
```

`apps/desktop/src/data-import.ts`:

```ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function isPanelDataDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'panel.db')).isFile();
  } catch {
    return false;
  }
}

export async function importPanelData(source: string, target: string): Promise<void> {
  if (!isPanelDataDir(source)) throw new Error('所选目录不是面板 data 目录（缺少 panel.db）');
  if (fs.existsSync(path.join(target, 'panel.db'))) throw new Error('目标目录已有面板数据');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true, dereference: true });
}
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
npx vitest run --root apps/desktop test/runtime.test.ts test/data-import.test.ts
npm run typecheck -w @mcpanel/desktop
git add apps/desktop/src/runtime.ts apps/desktop/src/data-import.ts apps/desktop/test/runtime.test.ts apps/desktop/test/data-import.test.ts
git commit -m "feat(desktop): detect orphans and import panel data"
```

Expected: all pass.

---

## Task 4: ServerProcess (spawn, health, shutdown)

**Files:**
- Create: `apps/desktop/src/server-process.ts`
- Create: `apps/desktop/test/server-process.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { buildServerEnv, findFreePort, ServerProcess, waitForHealth } from '../src/server-process';

const logFile = path.join(os.tmpdir(), `mcpanel-desktop-test-${process.pid}.log`);
afterEach(() => {
  fs.rmSync(logFile, { force: true });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  send = vi.fn();
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit('exit', 0);
  });
}

describe('server process helpers', () => {
  it('builds the child environment', () => {
    expect(buildServerEnv(3123, 'D:\\data', { PATH: 'x' })).toMatchObject({
      PATH: 'x',
      NODE_ENV: 'production',
      PANEL_HOST: '127.0.0.1',
      PANEL_PORT: '3123',
      DATA_DIR: 'D:\\data',
    });
  });

  it('allocates a bindable loopback port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('waits for a healthy endpoint', async () => {
    expect(await waitForHealth(1, 50, 10)).toBe(false);
  });
});

describe('ServerProcess', () => {
  it('spawns the server with IPC and waits for health', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const process = new ServerProcess({
      serverDir: 'D:\\app\\server',
      nodePath: 'D:\\app\\server\\node\\node.exe',
      entryPath: 'D:\\app\\server\\apps\\server\\dist\\index.js',
      dataDir: 'D:\\data',
      logFile,
      findPort: async () => 3123,
      waitHealth: async () => true,
      spawnFn,
    });

    await expect(process.start()).resolves.toEqual({ pid: 4242, port: 3123 });
    expect(spawnFn).toHaveBeenCalledWith(
      'D:\\app\\server\\node\\node.exe',
      ['D:\\app\\server\\apps\\server\\dist\\index.js'],
      expect.objectContaining({
        cwd: 'D:\\app\\server',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
  });

  it('kills the child when health never passes', async () => {
    const child = new FakeChild();
    const process = new ServerProcess({
      serverDir: 's',
      nodePath: 'n',
      entryPath: 'e',
      dataDir: 'd',
      logFile,
      findPort: async () => 3123,
      waitHealth: async () => false,
      spawnFn: vi.fn(() => child as unknown as ChildProcess),
    });
    await expect(process.start()).rejects.toThrow(/启动失败/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('sends shutdown and resolves after exit', async () => {
    const child = new FakeChild();
    const process = new ServerProcess({
      serverDir: 's',
      nodePath: 'n',
      entryPath: 'e',
      dataDir: 'd',
      logFile,
      findPort: async () => 3123,
      waitHealth: async () => true,
      spawnFn: vi.fn(() => child as unknown as ChildProcess),
    });
    await process.start();
    const stopping = process.stop(500);
    expect(child.send).toHaveBeenCalledWith('shutdown');
    child.exitCode = 0;
    child.emit('exit', 0);
    await expect(stopping).resolves.toBeUndefined();
  });
});
```

Run: `npx vitest run --root apps/desktop test/server-process.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the module**

`apps/desktop/src/server-process.ts`:

```ts
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export interface ServerStartInfo {
  pid: number;
  port: number;
}

export interface ServerProcessOptions {
  serverDir: string;
  nodePath: string;
  entryPath: string;
  dataDir: string;
  logFile: string;
  findPort?: () => Promise<number>;
  waitHealth?: (port: number) => Promise<boolean>;
  spawnFn?: typeof spawn;
}

export function buildServerEnv(
  port: number,
  dataDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    NODE_ENV: 'production',
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: String(port),
    DATA_DIR: dataDir,
  };
}

export async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('无法分配空闲端口');
  return port;
}

export async function waitForHealth(port: number, timeoutMs = 30_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export class ServerProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private currentPort: number | null = null;
  private readonly findPort: () => Promise<number>;
  private readonly waitHealth: (port: number) => Promise<boolean>;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly options: ServerProcessOptions) {
    super();
    this.findPort = options.findPort ?? findFreePort;
    this.waitHealth = options.waitHealth ?? ((port) => waitForHealth(port));
    this.spawnFn = options.spawnFn ?? spawn;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get port(): number | null {
    return this.currentPort;
  }

  async start(): Promise<ServerStartInfo> {
    if (this.child) throw new Error('面板服务已在运行');
    const port = await this.findPort();
    await fsp.mkdir(path.dirname(this.options.logFile), { recursive: true });
    this.logStream = fs.createWriteStream(this.options.logFile, { flags: 'a' });

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.options.nodePath, [this.options.entryPath], {
        cwd: this.options.serverDir,
        env: buildServerEnv(port, this.options.dataDir),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      this.logStream.end();
      this.logStream = null;
      throw error;
    }

    this.child = child;
    this.currentPort = port;
    child.stdout?.pipe(this.logStream, { end: false });
    child.stderr?.pipe(this.logStream, { end: false });
    child.on('exit', (code) => {
      this.child = null;
      this.currentPort = null;
      this.logStream?.end();
      this.logStream = null;
      this.emit('exit', code);
    });
    child.on('error', (error) => this.emit('server-error', error));

    const healthy = await this.waitHealth(port);
    if (!healthy) {
      await this.killChild();
      throw new Error(`面板服务启动失败，请查看 ${this.options.logFile}`);
    }
    if (!child.pid) {
      await this.killChild();
      throw new Error('面板服务没有返回 PID');
    }
    return { pid: child.pid, port };
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.connected) child.send('shutdown');
    const exited = await waitForExit(child, timeoutMs);
    if (!exited) await this.killChild();
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
    await waitForExit(child, 5_000);
  }
}
```

- Never use tree-kill here; the Minecraft processes are children of the panel and must
  survive a panel restart.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run --root apps/desktop test/server-process.test.ts
npm run typecheck -w @mcpanel/desktop
git add apps/desktop/src/server-process.ts apps/desktop/test/server-process.test.ts
git commit -m "feat(desktop): manage the panel server child process"
```

---

## Task 5: Electron main, tray, preload and lifecycle

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/tray.ts`

- [ ] **Step 1: Implement the tray module**

`apps/desktop/src/tray.ts`:

```ts
import { Menu, Tray, nativeImage, shell } from 'electron';

export interface TrayOptions {
  iconPath: string;
  getWindowVisible: () => boolean;
  showWindow: () => void;
  hideWindow: () => void;
  panelUrl: string;
  dataDir: string;
  logDir: string;
  getAutoLaunch: () => boolean;
  setAutoLaunch: (enabled: boolean) => void;
  quit: () => void;
}

export function createTray(options: TrayOptions): Tray {
  const tray = new Tray(nativeImage.createFromPath(options.iconPath));
  tray.setToolTip('MC Panel');

  const refresh = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开面板', click: options.showWindow },
        { label: '在浏览器中打开', click: () => void shell.openExternal(options.panelUrl) },
        { type: 'separator' },
        { label: '打开数据目录', click: () => void shell.openPath(options.dataDir) },
        { label: '打开日志目录', click: () => void shell.openPath(options.logDir) },
        { type: 'separator' },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: options.getAutoLaunch(),
          click: (item) => {
            options.setAutoLaunch(item.checked);
            refresh();
          },
        },
        { type: 'separator' },
        { label: '退出', click: options.quit },
      ]),
    );
  };
  refresh();
  tray.on('click', () => {
    if (options.getWindowVisible()) options.hideWindow();
    else options.showWindow();
  });
  return tray;
}
```

- [ ] **Step 2: Implement the preload**

`apps/desktop/src/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mcpanelDesktop', {
  saveFile: (input: { url: string; filename: string }) => ipcRenderer.invoke('desktop:save-file', input),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url),
  getVersion: () => ipcRenderer.invoke('desktop:version'),
});
```

- [ ] **Step 3: Replace `main.ts` with the full shell**

`apps/desktop/src/main.ts`:

```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTray } from './tray';
import { ServerProcess, type ServerStartInfo } from './server-process';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import { clearRuntime, readRuntime, stopOrphan, writeRuntime } from './runtime';
import { resolveDesktopPaths, resolveUserDataDir } from './paths';
import { importPanelData, isPanelDataDir } from './data-import';

const isSmoke = process.argv.includes('--smoke-test');
const smokeExit = process.argv.includes('--smoke-exit');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void run();
}

async function run(): Promise<void> {
  const userDataDir = resolveUserDataDir({
    portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    appDataDir: app.getPath('appData'),
    smokeTest: isSmoke,
    tempDir: os.tmpdir(),
    pid: process.pid,
  });
  app.setPath('userData', userDataDir);
  const paths = resolveDesktopPaths(userDataDir);
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.resolve(__dirname, '../../../packaging/icon.png');
  const serverDir = app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(app.getAppPath(), 'build', 'server');
  const nodePath = path.join(serverDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const entryPath = path.join(serverDir, 'apps', 'server', 'dist', 'index.js');

  let preferences: Preferences = loadPreferences(paths.preferencesFile);
  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let server: ServerProcess | null = null;
  let panelOrigin = '';
  let quitting = false;
  let recovering = false;

  fs.mkdirSync(path.dirname(paths.desktopLogFile), { recursive: true });
  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      fs.appendFileSync(paths.desktopLogFile, line);
    } catch {
      // logging must never take the shell down
    }
    if (!app.isPackaged) console.log(message);
  };

  const applyLoginItem = (): void => {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: preferences.autoLaunch, args: ['--hidden'] });
  };

  const ensureData = async (): Promise<boolean> => {
    if (isSmoke) return true;
    if (isPanelDataDir(paths.dataDir)) return true;
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: 'MC Panel',
      message: '未发现面板数据',
      detail: '可以新建数据目录，或从现有便携版导入 data 目录。',
      buttons: ['新建', '导入现有数据', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 2) return false;
    if (choice.response === 1) {
      const picked = await dialog.showOpenDialog({ title: '选择现有 data 目录', properties: ['openDirectory'] });
      const source = picked.filePaths[0];
      if (picked.canceled || !source) return ensureData();
      try {
        await importPanelData(source, paths.dataDir);
      } catch (error) {
        await dialog.showMessageBox({
          type: 'error',
          title: '导入失败',
          message: error instanceof Error ? error.message : String(error),
        });
        return ensureData();
      }
    }
    return true;
  };

  const startServer = async (): Promise<ServerStartInfo> => {
    server = new ServerProcess({
      serverDir,
      nodePath,
      entryPath,
      dataDir: paths.dataDir,
      logFile: paths.desktopLogFile,
    });
    server.on('exit', (code: number | null) => {
      if (!quitting) void handleServerExit(code);
    });
    const info = await server.start();
    writeRuntime(paths.runtimeFile, info);
    panelOrigin = `http://127.0.0.1:${info.port}`;
    log(`panel server started on ${panelOrigin}`);
    return info;
  };

  const startServerWithRetry = async (): Promise<ServerStartInfo> => {
    try {
      return await startServer();
    } catch (error) {
      log(`server start failed: ${error instanceof Error ? error.message : String(error)}`);
      await server?.stop(1000).catch(() => undefined);
      server = null;
      return await startServer();
    }
  };

  const handleServerExit = async (code: number | null): Promise<void> => {
    if (recovering || quitting) return;
    recovering = true;
    log(`server exited: ${code}`);
    try {
      const result = await dialog.showMessageBox({
        type: 'error',
        title: 'MC Panel',
        message: '面板服务已退出',
        detail: `退出码：${code ?? 'unknown'}\n日志：${paths.desktopLogFile}`,
        buttons: ['重启', '打开日志', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 0) {
        await startServerWithRetry();
        await mainWindow?.loadURL(panelOrigin);
      } else if (result.response === 1) {
        await shell.openPath(paths.desktopLogFile);
      } else {
        app.quit();
      }
    } catch (error) {
      log(`server recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      app.quit();
    } finally {
      recovering = false;
    }
  };

  const createWindow = async (): Promise<void> => {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      show: false,
      backgroundColor: '#0b0f0d',
      icon: iconPath,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(panelOrigin)) event.preventDefault();
    });
    mainWindow.on('close', (event) => {
      if (!quitting && preferences.minimizeToTray) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    await mainWindow.loadURL(panelOrigin);
    if (!startHidden) mainWindow.show();
  };

  const createTrayMenu = (): void => {
    tray = createTray({
      iconPath,
      getWindowVisible: () => Boolean(mainWindow?.isVisible()),
      showWindow: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
      hideWindow: () => mainWindow?.hide(),
      panelUrl: panelOrigin,
      dataDir: paths.dataDir,
      logDir: path.dirname(paths.desktopLogFile),
      getAutoLaunch: () => preferences.autoLaunch,
      setAutoLaunch: (enabled) => {
        preferences = { ...preferences, autoLaunch: enabled };
        savePreferences(paths.preferencesFile, preferences);
        applyLoginItem();
      },
      quit: () => app.quit(),
    });
  };

  const registerIpc = (): void => {
    ipcMain.handle('desktop:version', () => app.getVersion());
    ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('unsupported url');
      await shell.openExternal(url);
    });
    ipcMain.handle('desktop:save-file', async (event, input: unknown) => {
      if (!input || typeof input !== 'object') {
        return { error: { code: 'VALIDATION_ERROR', message: '参数错误', status: 400 } };
      }
      const { url, filename } = input as { url?: unknown; filename?: unknown };
      if (typeof url !== 'string' || typeof filename !== 'string') {
        return { error: { code: 'VALIDATION_ERROR', message: '参数错误', status: 400 } };
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { error: { code: 'VALIDATION_ERROR', message: 'URL 无效', status: 400 } };
      }
      if (parsed.origin !== panelOrigin) {
        return { error: { code: 'FORBIDDEN', message: 'URL 来源不匹配', status: 403 } };
      }
      const picked = mainWindow
        ? await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(filename) })
        : await dialog.showSaveDialog({ defaultPath: path.basename(filename) });
      if (picked.canceled || !picked.filePath) return { canceled: true };
      try {
        const response = await event.sender.session.fetch(parsed.toString(), { credentials: 'include' });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          return {
            error: {
              code: data?.error?.code ?? 'DOWNLOAD_FAILED',
              message: data?.error?.message ?? `下载失败（HTTP ${response.status}）`,
              status: response.status,
            },
          };
        }
        if (!response.body) {
          return { error: { code: 'DOWNLOAD_FAILED', message: '响应为空', status: 502 } };
        }
        await pipeline(
          Readable.fromWeb(
            response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
          ),
          fs.createWriteStream(picked.filePath),
        );
        return { canceled: false, filePath: picked.filePath };
      } catch (error) {
        return {
          error: {
            code: 'DOWNLOAD_FAILED',
            message: error instanceof Error ? error.message : String(error),
            status: 500,
          },
        };
      }
    });
  };

  app.on('second-instance', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (!preferences.minimizeToTray) app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      await server?.stop(10_000).catch(() => undefined);
      clearRuntime(paths.runtimeFile);
      if (isSmoke) fs.rmSync(userDataDir, { recursive: true, force: true });
      mainWindow?.destroy();
      app.quit();
    })();
  });

  await app.whenReady();
  app.setAppUserModelId('com.ss1uye.mcpanel');
  applyLoginItem();

  if (!(await ensureData())) {
    app.quit();
    return;
  }

  const orphan = readRuntime(paths.runtimeFile);
  if (orphan) {
    await stopOrphan(orphan, {
      health: async (port) => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
        } catch {
          return false;
        }
      },
    });
    clearRuntime(paths.runtimeFile);
  }

  if (smokeExit) {
    try {
      await startServerWithRetry();
      log(`[smoke] ready ${panelOrigin}`);
    } catch (error) {
      log(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
      return;
    }
    app.quit();
    return;
  }

  try {
    await startServerWithRetry();
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'MC Panel',
      message: '无法启动面板服务',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
    return;
  }

  registerIpc();
  await createWindow();
  createTrayMenu();
  if (isSmoke) log(`[smoke] ready ${panelOrigin}`);
}
```

- [ ] **Step 4: Build and typecheck**

Run:

```bash
npm run build -w @mcpanel/desktop
npm run typecheck -w @mcpanel/desktop
```

Expected: both pass. The actual window is exercised by the Playwright Electron
smoke in Task 8, after the server payload and icon exist.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.ts apps/desktop/src/preload.ts apps/desktop/src/tray.ts
git commit -m "feat(desktop): add the Electron shell and tray"
```

---

## Task 6: Desktop download bridge

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/test/api-client.test.ts`
- The main/preload bridge is added in Task 5.

- [ ] **Step 1: Write the failing web test**

Add to `apps/web/test/api-client.test.ts`:

```ts
it('delegates downloads to the desktop bridge when present', async () => {
  const saveFile = vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\tmp\\latest.log' });
  (window as unknown as { mcpanelDesktop: { saveFile: typeof saveFile } }).mcpanelDesktop = { saveFile };

  await downloadFile('/instances/x/logs/download', 'latest.log');

  expect(saveFile).toHaveBeenCalledWith({
    url: `${window.location.origin}/api/instances/x/logs/download`,
    filename: 'latest.log',
  });
  expect(fetchMock).not.toHaveBeenCalled();
  delete (window as unknown as { mcpanelDesktop?: unknown }).mcpanelDesktop;
});
```

Add a second test for a bridge error:

```ts
it('maps desktop bridge errors to ApiError', async () => {
  (window as unknown as { mcpanelDesktop: unknown }).mcpanelDesktop = {
    saveFile: vi.fn().mockResolvedValue({
      error: { code: 'AUTH_REQUIRED', message: '请先登录', status: 401 },
    }),
  };
  const error = await downloadFile('/instances/x/logs/download', 'latest.log').catch((cause) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('AUTH_REQUIRED');
  delete (window as unknown as { mcpanelDesktop?: unknown }).mcpanelDesktop;
});
```

Run: `npx vitest run --root apps/web test/api-client.test.ts`
Expected: the first new test fails because `downloadFile` still calls `fetch`.

- [ ] **Step 2: Implement the bridge branch**

At the start of `downloadFile`, before `fetch`:

```ts
interface DesktopBridge {
  saveFile(input: { url: string; filename: string }): Promise<{
    canceled?: boolean;
    error?: { code: string; message: string; status: number };
  }>;
}

const desktop = (window as unknown as { mcpanelDesktop?: DesktopBridge }).mcpanelDesktop;
if (desktop) {
  const result = await desktop.saveFile({
    url: new URL(`/api${path}`, window.location.origin).toString(),
    filename,
  });
  if (result.error) {
    if (result.error.status === 401) {
      clearCsrfToken();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(result.error.code, result.error.message, result.error.status);
  }
  return;
}
```

The existing FSA/blob path remains as the browser fallback.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run --root apps/web test/api-client.test.ts
npm run typecheck -w @mcpanel/web
git add apps/web/src/api/client.ts apps/web/test/api-client.test.ts
git commit -m "feat(web): support the desktop download bridge"
```

---

## Task 7: Packaging payload, icon and electron-builder

**Files:**
- Modify: `scripts/package-portable.mjs` (add `--no-zip`)
- Create: `scripts/prepare-desktop-payload.mjs`
- Create: `scripts/make-icon.mjs`
- Create: `apps/desktop/electron-builder.yml`
- Create: `packaging/icon.png`, `packaging/icon.ico`
- Modify: `.gitignore`
- Modify: root `package.json` scripts

- [ ] **Step 1: Add `--no-zip` to the portable script**

At the top of `scripts/package-portable.mjs`:

```js
const noZip = process.argv.includes('--no-zip');
```

Before `console.log('[package] creating zip...');`:

```js
if (noZip) {
  console.log(`Server payload: ${staging}`);
  process.exit(0);
}
```

- [ ] **Step 2: Create the desktop payload script**

`scripts/prepare-desktop-payload.mjs`:

```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
if (process.platform !== 'win32') throw new Error('桌面版目前只支持 Windows x64');

const result = spawnSync(process.execPath, ['scripts/package-portable.mjs', '--no-zip'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

const source = path.join(repoRoot, 'release', `mcpanel-${pkg.version}-win-x64`);
const target = path.join(repoRoot, 'apps/desktop/build/server');
await fsp.rm(target, { recursive: true, force: true });
await fsp.cp(source, target, { recursive: true, force: true, dereference: true });
await fsp.copyFile(path.join(repoRoot, 'packaging/icon.png'), path.join(repoRoot, 'apps/desktop/build/icon.png'));
await fsp.copyFile(path.join(repoRoot, 'packaging/icon.ico'), path.join(repoRoot, 'apps/desktop/build/icon.ico'));
console.log(`[desktop] server payload: ${target}`);
```

- [ ] **Step 3: Create the icon assets**

Generate a 1024×1024 or 512×512 PNG with a dark panel/block motif and save it as
`packaging/icon.png`. The icon must not use Minecraft trademarks. Then convert it:

```bash
npm install -D png-to-ico
node scripts/make-icon.mjs
```

`scripts/make-icon.mjs`:

```js
import fs from 'node:fs';
import pngToIco from 'png-to-ico';

const png = fs.readFileSync('packaging/icon.png');
fs.writeFileSync('packaging/icon.ico', await pngToIco(png));
console.log('packaging/icon.ico written');
```

Keep both files tracked.

- [ ] **Step 4: Add electron-builder config**

`apps/desktop/electron-builder.yml`:

```yaml
appId: com.ss1uye.mcpanel
productName: MC Panel
directories:
  output: ../../release/desktop
  buildResources: build
files:
  - dist/**
  - package.json
extraResources:
  - from: build/server
    to: server
  - from: build/icon.png
    to: icon.png
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  deleteAppDataOnUninstall: false
  runAfterFinish: true
  artifactName: MC-Panel-Setup-${version}.exe
portable:
  artifactName: MC-Panel-${version}-portable.exe
publish: null
```

- [ ] **Step 5: Add root scripts and ignore the build directory**

Root `package.json`:

```json
"desktop:payload": "node scripts/prepare-desktop-payload.mjs",
"desktop:build": "npm run build -w @mcpanel/desktop",
"desktop:package": "npm run build && npm run desktop:payload && npm run desktop:build && npm run package -w @mcpanel/desktop",
"smoke:desktop": "node scripts/smoke-desktop.mjs",
"test:e2e:desktop": "playwright test --config playwright.desktop.config.ts",
"release:desktop": "npm run desktop:package && npm run test:e2e:desktop && npm run smoke:desktop && node scripts/release-checksums.mjs"
```

`.gitignore` add:

```text
apps/desktop/build/
```

- [ ] **Step 6: Build the package**

Run:

```bash
npm run desktop:package
```

Expected: `release/desktop/MC-Panel-Setup-0.4.0.exe`, `release/desktop/MC-Panel-0.4.0-portable.exe`, and `release/desktop/win-unpacked/MC Panel.exe`.

- [ ] **Step 7: Commit**

```bash
git add scripts/package-portable.mjs scripts/prepare-desktop-payload.mjs scripts/make-icon.mjs apps/desktop/electron-builder.yml packaging/icon.png packaging/icon.ico package.json package-lock.json .gitignore
git commit -m "build(desktop): package the Electron installer and portable exe"
```

---

## Task 8: Desktop smoke, Playwright Electron E2E and checksums

**Files:**
- Create: `scripts/smoke-desktop.mjs`
- Create: `scripts/release-checksums.mjs`
- Create: `playwright.desktop.config.ts`
- Create: `e2e/desktop/smoke.spec.ts`

- [ ] **Step 1: Create the packaging smoke script**

`scripts/smoke-desktop.mjs`:

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exe = path.resolve('release/desktop/win-unpacked/MC Panel.exe');
if (!fs.existsSync(exe)) throw new Error(`缺少 ${exe}，请先运行 npm run desktop:package`);

const child = spawn(exe, ['--smoke-test', '--smoke-exit'], { stdio: 'inherit' });
const timer = setTimeout(() => {
  child.kill();
  console.error('desktop smoke timed out');
  process.exit(1);
}, 90_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});
```

- [ ] **Step 2: Create the Playwright config and test**

`playwright.desktop.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/desktop',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});
```

`e2e/desktop/smoke.spec.ts`:

```ts
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('desktop shell boots the panel', async () => {
  const app = await electron.launch({
    args: ['.', '--smoke-test'],
    cwd: path.resolve('apps/desktop'),
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('body')).toContainText(/创建管理员|登录|初始化/, { timeout: 60_000 });
  } finally {
    await app.close();
  }
});
```

The app's `--smoke-test` mode must use a temp data directory and skip the import dialog
(Task 5). The desktop package must have `apps/desktop/build/server` populated.

- [ ] **Step 3: Create release checksums**

`scripts/release-checksums.mjs`:

```js
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  ...fs.readdirSync('release').filter((name) => name.endsWith('.zip')).map((name) => path.join('release', name)),
  ...fs.readdirSync('release/desktop')
    .filter((name) => name.endsWith('.exe'))
    .map((name) => path.join('release/desktop', name)),
];
const lines = [];
for (const file of files) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  lines.push(`${hash.digest('hex')}  ${path.basename(file)}`);
}
fs.writeFileSync('release/SHA256SUMS.txt', `${lines.join('\n')}\n`);
console.log(`Wrote release/SHA256SUMS.txt (${lines.length} files)`);
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run desktop:package
npm run test:e2e:desktop
npm run smoke:desktop
node scripts/release-checksums.mjs
```

Expected: Playwright opens the setup page; the packaged exe exits 0; checksums include
the server ZIP and both desktop exes.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-desktop.mjs scripts/release-checksums.mjs playwright.desktop.config.ts e2e/desktop/smoke.spec.ts
git commit -m "test(desktop): add packaging smoke and Electron e2e"
```

---

## Task 9: CI and release workflows

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add a desktop job to CI**

Add a `desktop` job on `windows-latest` (timeout 30 minutes):

```yaml
  desktop:
    name: desktop package (windows)
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Use the repository npm version
        run: npm install -g npm@11.19.1
      - run: npm ci
      - run: npm run release:desktop
      - uses: actions/upload-artifact@v4
        with:
          name: mcpanel-desktop-windows
          path: |
            release/desktop/*.exe
            release/SHA256SUMS.txt
```

- [ ] **Step 2: Extend the release job**

In `release.yml`, after the portable smoke step and before the artifact upload, add:

```yaml
      - name: Build desktop package
        shell: pwsh
        run: |
          $lines = & npm run release:desktop 2>&1
          $code = $LASTEXITCODE
          $lines | ForEach-Object { Write-Host $_ }
          if ($code -ne 0) {
            $lines | Select-Object -Last 20 | ForEach-Object { Write-Host "::error::$_" }
            exit $code
          }
```

Update the artifact and release file patterns:

```yaml
          path: |
            release/mcpanel-*-win-x64.zip
            release/desktop/*.exe
            release/SHA256SUMS.txt
```

```yaml
          files: |
            release/mcpanel-*-win-x64.zip
            release/desktop/*.exe
            release/SHA256SUMS.txt
```

Keep the existing `docs/releases/<tag>.md` body path.

- [ ] **Step 3: Verify workflow YAML locally**

Run:

```bash
node -e "const fs=require('fs'); for (const f of ['.github/workflows/ci.yml','.github/workflows/release.yml']) { const s=fs.readFileSync(f,'utf8'); if (!s.includes('desktop')) throw new Error(f); } console.log('workflow files updated')"
```

Expected: `workflow files updated`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: build and smoke the desktop app"
```

---

## Task 10: Documentation, version 0.4.0 and release checklist

**Files:**
- Modify: `README.md`, `HANDOFF.md`, `CHANGELOG.md`
- Create: `docs/releases/v0.4.0.md`
- Modify: `docs/portable.md` (desktop vs portable)
- Verify: all package versions and `PANEL_VERSION` are `0.4.0` (set in Task 2)

- [ ] **Step 1: Document the desktop app**

Update README with:
- “Windows 桌面版” section: installer and portable exe, data directory, tray/autostart, upgrade preserves `data/`.
- Keep the server-only portable ZIP documented for headless users.

Update `docs/portable.md` to distinguish:
- Desktop installer/portable (this plan).
- Server portable ZIP (existing `start-panel.bat`).

- [ ] **Step 2: Confirm the 0.4.0 version**

Run:

```bash
node -e "for (const f of ['package.json','apps/server/package.json','apps/web/package.json','packages/shared/package.json','apps/desktop/package.json']) { const p=require('./'+f); if (p.version !== '0.4.0') throw new Error(f+' has '+p.version); } console.log('versions ok')"
```

Expected: `versions ok`. The version was bumped in Task 2 Step 0.

- [ ] **Step 3: Write release notes**

Create `docs/releases/v0.4.0.md` covering:
- Desktop installer and portable exe.
- Tray, single instance, autostart, close-to-tray.
- Data import and upgrade preserving `data/`.
- No database changes.
- SHA256SUMS instructions.
- Known limitation: unsigned installer, manual update in 0.4.0.

- [ ] **Step 4: Full verification**

Run:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
npm run release:portable
npm run desktop:package
npm run test:e2e:desktop
npm run smoke:desktop
node scripts/release-checksums.mjs
```

Expected: all green. Existing server/web/shared tests remain at their current baseline.

- [ ] **Step 5: Commit**

```bash
git add README.md HANDOFF.md CHANGELOG.md docs/portable.md docs/releases/v0.4.0.md
git commit -m "chore(release): prepare v0.4.0 desktop edition"
```

- [ ] **Step 6: Release after explicit approval**

Do not tag/push until the user approves the release. When approved:

```bash
git tag -a v0.4.0 -m "MC Panel 0.4.0"
git push origin main
git push origin v0.4.0
```

Then verify the Release workflow and update HANDOFF with the artifact URLs/SHA256.

---

## Self-review checklist

- [x] Every spec requirement maps to a task: shell, child process, IPC, tray, single instance, autostart, data import, portable mode, download bridge, installer/portable packaging, CI/release, tests, docs.
- [x] No placeholder code in the tasks; temporary code (the Task 2 hello-world main) is explicitly replaced in Task 5.
- [x] Types/names consistent: `ServerProcess.start()` returns `{ pid, port }`; `resolveDesktopPaths()` returns `desktopLogFile`; `stopOrphan()` returns boolean; `createTray()` options match main.
- [x] No server HTTP API or DB schema changes.
- [x] Windows x64 only for v0.4.0; auto-update and code signing remain out of scope.
