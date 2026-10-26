import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 600 });
  void window.loadURL('data:text/html,<h1>MC Panel Desktop</h1>');
});

app.on('window-all-closed', () => app.quit());
