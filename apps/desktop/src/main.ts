import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { Tray } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTray } from './tray';
import { ServerProcess, type ServerStartInfo } from './server-process';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import { clearRuntime, isPidAlive, readRuntime, stopOrphan, writeRuntime } from './runtime';
import { resolveDesktopPaths, resolveLoginItemPath, resolveUserDataDir } from './paths';
import { importPanelData, isPanelDataDir } from './data-import';

const isSmoke = process.argv.includes('--smoke-test');
const smokeExit = process.argv.includes('--smoke-exit');
const startHidden = process.argv.includes('--hidden');

const userDataDir = resolveUserDataDir({
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  appDataDir: app.getPath('appData'),
  smokeTest: isSmoke,
  tempDir: os.tmpdir(),
  pid: process.pid,
});
app.setPath('userData', userDataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void run(userDataDir).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    void app.whenReady().then(() => {
      dialog.showErrorBox('MC Panel 启动失败', message);
      app.quit();
    });
  });
}

async function run(userDataDir: string): Promise<void> {
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
  let keepRuntimeOnQuit = false;
  let cleanupStarted = false;
  let exitCode = 0;

  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      fs.appendFileSync(paths.desktopLogFile, line);
    } catch {
      // Logging must never take the shell down.
    }
    if (!app.isPackaged || isSmoke) console.log(message);
  };

  const sweepSmokeDirs = (): void => {
    if (isSmoke) return;
    try {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith('mcpanel-desktop-smoke-')) continue;
        const dir = path.join(os.tmpdir(), name);
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          // Locked by a running Chromium or already gone.
        }
      }
    } catch {
      // Temporary directory cleanup is best effort.
    }
  };

  const probeHealth = async (port: number): Promise<boolean> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return body?.ok === true;
    } catch {
      return false;
    }
  };

  const applyLoginItem = (): void => {
    if (!app.isPackaged || isSmoke) return;
    app.setLoginItemSettings({
      path: resolveLoginItemPath(process.env, process.execPath),
      openAtLogin: preferences.autoLaunch,
      args: ['--hidden'],
    });
  };

  const persistPreferences = (next: Preferences): void => {
    preferences = next;
    try {
      savePreferences(paths.preferencesFile, next);
    } catch (error) {
      log(`preferences save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const ensureData = async (): Promise<boolean> => {
    if (isSmoke) return true;
    if (isPanelDataDir(paths.dataDir)) return true;
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: 'MC Panel',
      message: '未发现面板数据',
      detail: '可以新建数据目录，或从现有便携版导入 data 目录。导入前请先关闭旧面板。',
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
    server.on('server-error', (error: unknown) => {
      log(`server error: ${error instanceof Error ? error.message : String(error)}`);
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
      await server?.stop(1_000).catch(() => undefined);
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
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      try {
        if (new URL(url).origin !== panelOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    mainWindow.webContents.on('will-redirect', (event, url) => {
      try {
        if (new URL(url).origin !== panelOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
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
      getPanelUrl: () => panelOrigin,
      dataDir: paths.dataDir,
      logDir: path.dirname(paths.desktopLogFile),
      getAutoLaunch: () => preferences.autoLaunch,
      setAutoLaunch: (enabled) => {
        persistPreferences({ ...preferences, autoLaunch: enabled });
        applyLoginItem();
      },
      getMinimizeToTray: () => preferences.minimizeToTray,
      setMinimizeToTray: (enabled) => {
        persistPreferences({ ...preferences, minimizeToTray: enabled });
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
      let partPath = '';
      try {
        const response = await event.sender.session.fetch(parsed.toString(), { credentials: 'include' });
        let finalOrigin = parsed.origin;
        try {
          finalOrigin = new URL(response.url).origin;
        } catch {
          // Some responses do not expose a URL; the request origin remains authoritative.
        }
        if (finalOrigin !== panelOrigin) {
          return { error: { code: 'FORBIDDEN', message: '下载重定向到非面板来源', status: 403 } };
        }
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
        partPath = `${picked.filePath}.part-${randomUUID()}`;
        await pipeline(
          Readable.fromWeb(
            response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
          ),
          fs.createWriteStream(partPath),
        );
        await fsp.rename(partPath, picked.filePath);
        return { canceled: false, filePath: picked.filePath };
      } catch (error) {
        if (partPath) await fsp.rm(partPath, { force: true }).catch(() => undefined);
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
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (!preferences.minimizeToTray) app.quit();
  });

  app.on('before-quit', (event) => {
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    quitting = true;
    void (async () => {
      try {
        await server?.stop(12_000).catch(() => undefined);
        if (!keepRuntimeOnQuit) clearRuntime(paths.runtimeFile);
        if (isSmoke) {
          // Chromium still owns the userData root; only remove the panel data here.
          try {
            fs.rmSync(paths.dataDir, { recursive: true, force: true });
          } catch {
            // Stale temp directories are swept on a later launch.
          }
        }
      } finally {
        try {
          tray?.destroy();
          tray = null;
          mainWindow?.destroy();
        } finally {
          app.exit(exitCode);
        }
      }
    })();
  });

  await app.whenReady();
  app.setAppUserModelId('com.ss1uye.mcpanel');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  applyLoginItem();
  sweepSmokeDirs();

  if (!(await ensureData())) {
    app.quit();
    return;
  }
  fs.mkdirSync(path.dirname(paths.desktopLogFile), { recursive: true });

  const orphan = readRuntime(paths.runtimeFile);
  if (orphan) {
    let stopped = await stopOrphan(orphan, { health: probeHealth });
    if (!stopped) {
      for (let attempt = 0; attempt < 3 && isPidAlive(orphan.pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await probeHealth(orphan.port)) {
          stopped = await stopOrphan(orphan, { health: probeHealth });
          break;
        }
      }
    }
    if (!stopped && isPidAlive(orphan.pid)) {
      keepRuntimeOnQuit = true;
      await dialog.showMessageBox({
        type: 'error',
        title: 'MC Panel',
        message: '旧面板进程仍在运行',
        detail: `PID ${orphan.pid} 仍在运行，但健康检查未通过。请先在任务管理器中结束它，或重启电脑后再试。`,
      });
      app.quit();
      return;
    }
    clearRuntime(paths.runtimeFile);
  }

  if (smokeExit) {
    try {
      await startServerWithRetry();
      log(`[smoke] ready ${panelOrigin}`);
    } catch (error) {
      log(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
      app.quit();
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
