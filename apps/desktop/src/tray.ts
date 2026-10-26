import { Menu, Tray, nativeImage, shell } from 'electron';

export interface TrayOptions {
  iconPath: string;
  getWindowVisible: () => boolean;
  showWindow: () => void;
  hideWindow: () => void;
  getPanelUrl: () => string;
  dataDir: string;
  logDir: string;
  getAutoLaunch: () => boolean;
  setAutoLaunch: (enabled: boolean) => void;
  getMinimizeToTray: () => boolean;
  setMinimizeToTray: (enabled: boolean) => void;
  quit: () => void;
}

export function createTray(options: TrayOptions): Tray {
  const image = nativeImage.createFromPath(options.iconPath);
  if (image.isEmpty()) throw new Error(`托盘图标缺失：${options.iconPath}`);
  const tray = new Tray(image);
  tray.setToolTip('MC Panel');

  const refresh = (): void => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开面板', click: options.showWindow },
        {
          label: '在浏览器中打开',
          click: () => void shell.openExternal(options.getPanelUrl()).catch(() => undefined),
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => void shell.openPath(options.dataDir).catch(() => undefined) },
        { label: '打开日志目录', click: () => void shell.openPath(options.logDir).catch(() => undefined) },
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
        {
          label: '关闭窗口时最小化到托盘',
          type: 'checkbox',
          checked: options.getMinimizeToTray(),
          click: (item) => {
            options.setMinimizeToTray(item.checked);
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
