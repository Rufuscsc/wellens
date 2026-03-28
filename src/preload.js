const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Library
  loadLibrary:  ()         => ipcRenderer.invoke('library:load'),
  uploadBook:   (path)     => ipcRenderer.invoke('library:upload', path),
  deleteBook:   (id)       => ipcRenderer.invoke('library:delete', id),

  // File dialog
  openFileDialog: ()       => ipcRenderer.invoke('dialog:openFile'),

  // Reading
  readBook:     (id)       => ipcRenderer.invoke('book:read', id),

  // Sharing
  createShare:  (opts)     => ipcRenderer.invoke('share:create', opts),
  revokeShare:  (token)    => ipcRenderer.invoke('share:revoke', token),
  listShares:   ()         => ipcRenderer.invoke('share:list'),
  getServerPort:()         => ipcRenderer.invoke('share:serverPort'),
});
