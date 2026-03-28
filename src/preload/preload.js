const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wellens', {
  // Library
  uploadBook:   ()           => ipcRenderer.invoke('library:upload'),
  getBooks:     ()           => ipcRenderer.invoke('library:getBooks'),
  deleteBook:   (id)         => ipcRenderer.invoke('library:delete', id),
  readBook:     (id)         => ipcRenderer.invoke('library:readBook', id),

  // Shares
  createShare:  (opts)       => ipcRenderer.invoke('share:create', opts),
  getShares:    ()           => ipcRenderer.invoke('share:getAll'),
  deleteShare:  (id)         => ipcRenderer.invoke('share:delete', id),
  unlockShare:  (opts)       => ipcRenderer.invoke('share:unlock', opts),
  openReader:   (opts)       => ipcRenderer.invoke('share:openReader', opts),

  // Window controls
  minimize:     ()           => ipcRenderer.send('window:minimize'),
  maximize:     ()           => ipcRenderer.send('window:maximize'),
  closeWindow:  ()           => ipcRenderer.send('window:close'),

  // Utility
  getShareId:   ()           => new URLSearchParams(window.location.search).get('shareId'),
});
