const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reader', {
  getPDF:   (shareId) => ipcRenderer.invoke('reader:getPDF',   { shareId }),
  expired:  (shareId) => ipcRenderer.invoke('reader:expired',  { shareId }),
  close:    ()        => ipcRenderer.send('window:close'),
  minimize: ()        => ipcRenderer.send('window:minimize'),
  maximize: ()        => ipcRenderer.send('window:maximize'),

  getParams: () => {
    const p          = new URLSearchParams(window.location.search);
    const expiresRaw = p.get('expiresAt');
    // ── FIX: parse as number; treat '0' or missing as null ──
    const expiresAt  = expiresRaw && expiresRaw !== '0'
      ? Number(expiresRaw)
      : null;
    return {
      shareId:   p.get('shareId'),
      expiresAt,
    };
  }
});
