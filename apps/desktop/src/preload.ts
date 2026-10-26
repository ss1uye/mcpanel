import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mcpanelDesktop', {
  saveFile: (input: { url: string; filename: string }) => ipcRenderer.invoke('desktop:save-file', input),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url),
  getVersion: () => ipcRenderer.invoke('desktop:version'),
});
