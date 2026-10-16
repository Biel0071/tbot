import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tbot', {
  get: (p) => ipcRenderer.invoke('api:get', p),
  post: (p, body) => ipcRenderer.invoke('api:post', p, body),
  put: (p, body) => ipcRenderer.invoke('api:put', p, body),
  del: (p) => ipcRenderer.invoke('api:delete', p),
  wsUrl: () => ipcRenderer.invoke('api:ws-url'),
});
