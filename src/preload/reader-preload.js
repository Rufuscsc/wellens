const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  getPDF:    (shareId) => ipcRenderer.invoke('reader:getPDF', { shareId }),
  expired:   (shareId) => ipcRenderer.invoke('reader:expired', { shareId }),
  close:     ()        => ipcRenderer.send('window:close'),
  minimize:  ()        => ipcRenderer.send('window:minimize'),
  maximize:  ()        => ipcRenderer.send('window:maximize'),

  getParams: () => {
    const p = new URLSearchParams(window.location.search);
    return {
      shareId:   p.get('shareId'),
      expiresAt: p.get('expiresAt') ? Number(p.get('expiresAt')) : null,
    };
  }
});
