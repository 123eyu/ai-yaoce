const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  getSnapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  getHealth: () => ipcRenderer.invoke('monitor:health'),
  saveHealth: (config) => ipcRenderer.invoke('monitor:save-health', config),
  checkHealth: (id) => ipcRenderer.invoke('monitor:check-health', id),
  getPricing: () => ipcRenderer.invoke('monitor:pricing'),
  savePricing: (rules) => ipcRenderer.invoke('monitor:save-pricing', rules),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('monitor:pin', enabled),
  minimize: () => ipcRenderer.invoke('monitor:minimize'),
  close: () => ipcRenderer.invoke('monitor:close'),
  onSnapshot: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('monitor:update', listener);
    return () => ipcRenderer.removeListener('monitor:update', listener);
  }
});
