const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ── Paths ──────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const BOOKS_DIR = path.join(USER_DATA, 'books');
const SHARES_DIR= path.join(USER_DATA, 'shares');
const DB_FILE   = path.join(USER_DATA, 'library.json');
const DEVICE_ID_FILE = path.join(USER_DATA, 'device-id.json');

[BOOKS_DIR, SHARES_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Device ID ──────────────────────────────────────────────────────────────
function getDeviceId() {
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
    if (data.deviceId) return data.deviceId;
  } catch {}
  const deviceId = crypto.randomUUID();
  fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId, createdAt: Date.now() }));
  return deviceId;
}
const DEVICE_ID = getDeviceId();

// ── App Mode (Creator vs Viewer) ──────────────────────────────────────────
// If the .creator file is present, the app shows Upload & Share buttons.
const IS_CREATOR = fs.existsSync(path.join(app.getAppPath(), '.creator')) || 
                   fs.existsSync(path.join(process.cwd(), '.creator'));

// ── Backend API ────────────────────────────────────────────────────────────
// Used for global device limit tracking across offline files.
// When you deploy your backend/server.js, put the URL here.
const API_URL = 'http://localhost:3000';

// ── DB ─────────────────────────────────────────────────────────────────────
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { books: [], shares: [] }; }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Crypto ─────────────────────────────────────────────────────────────────
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + 'wellens-salt-v1').digest('hex');
}
function encryptBuffer(buf, key) {
  const k  = crypto.scryptSync(key, 'wellens', 32);
  const iv = crypto.randomBytes(16);
  const c  = crypto.createCipheriv('aes-256-cbc', k, iv);
  return Buffer.concat([iv, c.update(buf), c.final()]);
}
function decryptBuffer(buf, key) {
  const k  = crypto.scryptSync(key, 'wellens', 32);
  const iv = buf.slice(0, 16);
  const d  = crypto.createDecipheriv('aes-256-cbc', k, iv);
  return Buffer.concat([d.update(buf.slice(16)), d.final()]);
}
// Overload that takes pre-derived key bytes
function decryptBufferWithKey(buf, keyBytes) {
  const iv = buf.slice(0, 16);
  const d  = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
  return Buffer.concat([d.update(buf.slice(16)), d.final()]);
}
function encryptBufferWithKey(buf, keyBytes) {
  const iv = crypto.randomBytes(16);
  const c  = crypto.createCipheriv('aes-256-cbc', keyBytes, iv);
  return Buffer.concat([iv, c.update(buf), c.final()]);
}

// ── In-memory sessions (cleared on quit) ──────────────────────────────────
// sessionToken -> { shareId, encKey, expiresAt }
const sessionMap = {};
// shareId -> encKey  (set when reader opens, cleared when reader closes)
const activeReaderSessions = {};
// shareId -> source .wellens file path (for writing activations back)
const shareSourceFiles = {};

// ── Windows ────────────────────────────────────────────────────────────────
let mainWindow = null;
const readerWindows = {};  // shareId -> BrowserWindow

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f0e0c',
    titleBarStyle: 'hiddenInset',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/library.html'));
  // mainWindow.webContents.openDevTools(); // debug
}

function createReaderWindow(shareId, expiresAt) {
  if (readerWindows[shareId]) {
    try { readerWindows[shareId].close(); } catch {}
  }

  // ── FIX: pass expiresAt as a numeric query param (0 if null) ──
  const expiryParam = expiresAt ? String(expiresAt) : '0';

  const win = new BrowserWindow({
    width: 1100, height: 800, minWidth: 800, minHeight: 600,
    backgroundColor: '#161412',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/reader-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,   // no devtools for reader
    }
  });

  win.webContents.on('context-menu', e => e.preventDefault());
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(
    path.join(__dirname, '../renderer/pages/reader.html'),
    { query: { shareId, expiresAt: expiryParam } }
  );

  readerWindows[shareId] = win;
  win.on('closed', () => {
    delete readerWindows[shareId];
    delete activeReaderSessions[shareId];
  });

  return win;
}

function createUnlockWindow(shareId) {
  const win = new BrowserWindow({
    width: 480, height: 520, resizable: false,
    backgroundColor: '#0f0e0c',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  win.loadFile(
    path.join(__dirname, '../renderer/pages/unlock.html'),
    { query: { shareId } }
  );
  return win;
}

// ── App ready & Deep Linking ───────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('wellens-app', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('wellens-app');
}

function handleDeepLink(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return;
  if (urlStr.startsWith('wellens-app://open/')) {
    const shareId = urlStr.split('wellens-app://open/')[1]?.replace(/\/$/, '');
    if (shareId) {
      createUnlockWindow(shareId);
    }
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = commandLine.find(arg => arg.startsWith('wellens-app://'));
    if (url) handleDeepLink(url);
    
    const fileArg = commandLine.find(arg => arg.endsWith('.wellens'));
    if (fileArg && fs.existsSync(fileArg)) processImportedFile(fileArg);
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) {
      handleDeepLink(url);
    } else {
      app.once('ready', () => handleDeepLink(url));
    }
  });

  app.on('open-file', (event, pathStr) => {
    event.preventDefault();
    if (app.isReady() && pathStr.endsWith('.wellens')) {
      processImportedFile(pathStr);
    } else {
      app.once('ready', () => {
        if (pathStr.endsWith('.wellens')) processImportedFile(pathStr);
      });
    }
  });

  app.whenReady().then(() => {
    createMainWindow();

    // For Windows/Linux: check args if opened from cold start
    if (process.platform === 'win32' || process.platform === 'linux') {
      const url = process.argv.find(arg => arg.startsWith('wellens-app://'));
      if (url) handleDeepLink(url);
      
      const fileArg = process.argv.find(arg => arg.endsWith('.wellens'));
      if (fileArg && fs.existsSync(fileArg)) processImportedFile(fileArg);
    }
  });
} // End Single Instance Lock

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// ── IPC: Library ───────────────────────────────────────────────────────────

ipcMain.handle('app:getMode', () => IS_CREATOR);

ipcMain.handle('library:upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a Book',
    filters: [{ name: 'Books', extensions: ['pdf','epub','mobi','azw3'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { success: false };

  const src  = result.filePaths[0];
  const ext  = path.extname(src).slice(1).toLowerCase();
  const id   = crypto.randomUUID();
  const dest = path.join(BOOKS_DIR, id + '.' + ext);
  fs.copyFileSync(src, dest);

  const stat = fs.statSync(dest);
  const book = {
    id, format: ext,
    title: path.basename(src).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
    author: 'Unknown Author',
    size: formatSize(stat.size),
    sizeBytes: stat.size,
    dateAdded: Date.now(),
    storedName: id + '.' + ext,
  };

  const db = readDB();
  db.books.push(book);
  writeDB(db);
  return { success: true, book };
});

ipcMain.handle('library:getBooks', async () => readDB().books);

ipcMain.handle('library:delete', async (e, bookId) => {
  const db   = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book) return { success: false };

  try { fs.unlinkSync(path.join(BOOKS_DIR, book.storedName)); } catch {}

  // Also remove all shares for this book
  for (const s of db.shares.filter(x => x.bookId === bookId)) {
    try { fs.unlinkSync(path.join(SHARES_DIR, s.id + '.enc')); } catch {}
  }
  db.books  = db.books.filter(b => b.id !== bookId);
  db.shares = db.shares.filter(s => s.bookId !== bookId);
  writeDB(db);
  return { success: true };
});

// ── Read book locally (no share password needed) ──
ipcMain.handle('library:readBook', async (e, bookId) => {
  const db   = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book || book.format !== 'pdf')
    return { success: false, error: 'Only PDF reading is supported.' };

  // Create a temporary local share with a random key (no expiry, no password)
  const tempId  = 'local-' + crypto.randomUUID();
  const encKey  = crypto.randomBytes(32).toString('hex');

  const pdfBuf  = fs.readFileSync(path.join(BOOKS_DIR, book.storedName));
  const encBuf  = encryptBuffer(pdfBuf, encKey);
  fs.writeFileSync(path.join(SHARES_DIR, tempId + '.enc'), encBuf);

  const share = {
    id: tempId, bookId,
    bookTitle: book.title,
    encKey,              // stored for local reads (no password needed)
    passwordHash: null,
    encKeyEnc: null,
    expiresAt: null,
    isLocal: true,
    createdAt: Date.now(),
    linkOpens: 0,
  };
  db.shares.push(share);
  writeDB(db);

  // Put encKey in activeReaderSessions so reader:getPDF can use it
  activeReaderSessions[tempId] = { encKey, bookTitle: book.title, expiresAt: null };

  createReaderWindow(tempId, null);
  return { success: true };
});

// ── IPC: Sharing ───────────────────────────────────────────────────────────

ipcMain.handle('share:create', async (e, { bookId, password, expiresAt, maxDevices, expiryDuration }) => {
  const db   = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book) return { success: false, error: 'Book not found' };
  if (book.format !== 'pdf') return { success: false, error: 'Only PDF books can be shared' };

  const shareId      = crypto.randomUUID();
  const encKey       = crypto.randomBytes(32).toString('hex');
  const passwordHash = hashPassword(password);

  // Encrypt the PDF with the encKey
  const pdfBuf = fs.readFileSync(path.join(BOOKS_DIR, book.storedName));
  const encBuf = encryptBuffer(pdfBuf, encKey);
  fs.writeFileSync(path.join(SHARES_DIR, shareId + '.enc'), encBuf);

  // Encrypt the encKey itself using the password hash so we can recover it on unlock
  const encKeyBuf = encryptBuffer(Buffer.from(encKey), passwordHash);
  const encKeyEnc = encKeyBuf.toString('base64');

  const share = {
    id: shareId, bookId,
    bookTitle: book.title,
    encKeyEnc,
    passwordHash,
    expiresAt: expiresAt || null,
    maxDevices: maxDevices || 1,
    expiryDuration: expiryDuration || null,  // ms from first open per device
    activations: [],  // { deviceId, activatedAt }
    isLocal: false,
    createdAt: Date.now(),
    linkOpens: 0,
  };
  db.shares.push(share);
  writeDB(db);

  const exportData = JSON.stringify({
    magic: "WELLENS_SECURE_SHARE",
    version: 2,
    metadata: {
      id: share.id, bookId: share.bookId, bookTitle: share.bookTitle,
      encKeyEnc: share.encKeyEnc, passwordHash: share.passwordHash,
      expiresAt: share.expiresAt,
      maxDevices: share.maxDevices,
      expiryDuration: share.expiryDuration,
    },
    activations: [],
    payload: encBuf.toString('base64')
  });

  const savePath = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Secure Book File',
    defaultPath: `${book.title.replace(/[^a-zA-Z0-9 -]/g, '')}.wellens`,
    filters: [{ name: 'Wellens Secure Book', extensions: ['wellens'] }]
  });

  if (!savePath.canceled && savePath.filePath) {
    fs.writeFileSync(savePath.filePath, exportData, 'utf8');
    // Remember the source file path for activation write-back
    shareSourceFiles[shareId] = savePath.filePath;
  }

  const link = `https://Rufuscsc.github.io/wellens/share.html`;
  return { success: true, shareId, link, saved: !savePath.canceled };
});

ipcMain.handle('share:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Secure Book File',
    filters: [{ name: 'Wellens Book', extensions: ['wellens'] }],
    properties: ['openFile']
  });
  
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  return await processImportedFile(result.filePaths[0]);
});

async function processImportedFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed.magic !== 'WELLENS_SECURE_SHARE') throw new Error('Invalid signature');
    
    const isV2 = parsed.version >= 2;
    const db = readDB();
    const existing = db.shares.find(s => s.id === parsed.metadata.id);
    if (!existing) {
      db.shares.push({
        id: parsed.metadata.id, bookId: parsed.metadata.bookId,
        bookTitle: parsed.metadata.bookTitle, encKeyEnc: parsed.metadata.encKeyEnc,
        passwordHash: parsed.metadata.passwordHash, expiresAt: parsed.metadata.expiresAt,
        maxDevices: isV2 ? (parsed.metadata.maxDevices || 1) : 999,
        expiryDuration: isV2 ? (parsed.metadata.expiryDuration || null) : null,
        activations: isV2 ? (parsed.activations || []) : [],
        isLocal: false, createdAt: Date.now(), linkOpens: 0
      });
      writeDB(db);
    } else {
      // Merge activations from file (file may have newer activations from other devices)
      if (isV2 && parsed.activations && parsed.activations.length) {
        const existingIds = new Set((existing.activations || []).map(a => a.deviceId));
        for (const act of parsed.activations) {
          if (!existingIds.has(act.deviceId)) {
            existing.activations = existing.activations || [];
            existing.activations.push(act);
          }
        }
        existing.maxDevices = parsed.metadata.maxDevices || existing.maxDevices || 999;
        existing.expiryDuration = parsed.metadata.expiryDuration || existing.expiryDuration || null;
        writeDB(db);
      }
    }
    
    // Remember the source file path for activation write-back
    shareSourceFiles[parsed.metadata.id] = filePath;
    
    // Extract base64 payload back into native physical .enc file
    const encPath = path.join(SHARES_DIR, parsed.metadata.id + '.enc');
    if (!fs.existsSync(encPath)) {
      fs.writeFileSync(encPath, Buffer.from(parsed.payload, 'base64'));
    }
    
    createUnlockWindow(parsed.metadata.id);
    return { success: true };
  } catch (err) {
    dialog.showErrorBox('Import Failed', 'Could not open the .wellens package. The file might be corrupted.');
    return { success: false, error: 'Import failed' };
  }
}

ipcMain.handle('share:getAll', async () => {
  const db = readDB();
  return db.shares.map(s => {
    const activations = s.activations || [];
    const maxDevices = s.maxDevices || 999;
    // Check if this device has an activation and compute its per-device expiry
    const myActivation = activations.find(a => a.deviceId === DEVICE_ID);
    let deviceExpired = false;
    if (myActivation && s.expiryDuration) {
      deviceExpired = Date.now() > (myActivation.activatedAt + s.expiryDuration);
    }
    return {
      id: s.id,
      bookTitle: s.bookTitle,
      expiresAt: s.expiresAt,
      expiryDuration: s.expiryDuration || null,
      createdAt: s.createdAt,
      linkOpens: s.linkOpens || 0,
      isLocal: s.isLocal,
      maxDevices,
      activatedDevices: activations.length,
      expired: deviceExpired || (s.expiresAt ? Date.now() > s.expiresAt : false),
    };
  });
});

ipcMain.handle('share:delete', async (e, shareId) => {
  const db = readDB();
  try { fs.unlinkSync(path.join(SHARES_DIR, shareId + '.enc')); } catch {}
  db.shares = db.shares.filter(s => s.id !== shareId);
  writeDB(db);
  return { success: true };
});

// Unlock: verify password, create session, return token
ipcMain.handle('share:unlock', async (e, { shareId, password }) => {
  const db    = readDB();
  const share = db.shares.find(s => s.id === shareId);
  if (!share) return { success: false, error: 'Share not found.' };

  // Absolute expiry check
  if (share.expiresAt && Date.now() > share.expiresAt)
    return { success: false, error: 'This share link has expired.' };

  // ── Device activation check ──
  const maxDevices  = share.maxDevices || 999;
  let activations = share.activations || [];
  let myActivation = activations.find(a => a.deviceId === DEVICE_ID);

  if (API_URL) {
    try {
      const resp = await fetch(`${API_URL}/api/activations/${shareId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID, maxDevices })
      });
      const data = await resp.json();
      if (!resp.ok) {
        return { success: false, error: data.error || 'Server error tracking device.' };
      }
      activations = data.activations;
      myActivation = activations.find(a => a.deviceId === DEVICE_ID);
      share.activations = activations;
      writeDB(db);
    } catch (err) {
      return { success: false, error: 'Internet connection required to verify device sync.' };
    }
  } else {
    if (!myActivation && activations.length >= maxDevices) {
      return {
        success: false,
        error: `Device limit reached — this file can only be opened on ${maxDevices} device${maxDevices > 1 ? 's' : ''}.`
      };
    }
    if (!myActivation) {
      myActivation = { deviceId: DEVICE_ID, activatedAt: Date.now() };
      share.activations = share.activations || [];
      share.activations.push(myActivation);
      writeDB(db);
      writeActivationToSourceFile(shareId, share.activations);
    }
  }

  // Per-device expiry check
  if (myActivation && share.expiryDuration) {
    const deviceExpiresAt = myActivation.activatedAt + share.expiryDuration;
    if (Date.now() > deviceExpiresAt)
      return { success: false, error: 'Your access has expired on this device.' };
  }

  // Password check
  const hash = hashPassword(password);
  if (hash !== share.passwordHash)
    return { success: false, error: 'Incorrect password.' };

  // Decrypt the encKey
  let encKey;
  try {
    const encKeyBuf = Buffer.from(share.encKeyEnc, 'base64');
    encKey = decryptBuffer(encKeyBuf, hash).toString();
  } catch {
    return { success: false, error: 'Decryption error.' };
  }

  // Calculate per-device expiresAt
  const act = myActivation;
  let effectiveExpiresAt = share.expiresAt || null;
  if (share.expiryDuration && act) {
    const deviceExpiresAt = act.activatedAt + share.expiryDuration;
    // Use the earlier of absolute and per-device expiry
    if (effectiveExpiresAt) {
      effectiveExpiresAt = Math.min(effectiveExpiresAt, deviceExpiresAt);
    } else {
      effectiveExpiresAt = deviceExpiresAt;
    }
  }

  // Create session
  const token = crypto.randomBytes(32).toString('hex');
  sessionMap[token] = {
    shareId,
    encKey,
    bookTitle: share.bookTitle,
    expiresAt: effectiveExpiresAt,
  };

  // Increment open count
  share.linkOpens = (share.linkOpens || 0) + 1;
  writeDB(db);

  return { success: true, sessionToken: token, expiresAt: effectiveExpiresAt };
});

// Open reader from a valid session token
ipcMain.handle('share:openReader', async (e, { sessionToken }) => {
  const session = sessionMap[sessionToken];
  if (!session) return { success: false, error: 'Invalid or expired session.' };

  // Store encKey so reader:getPDF can find it
  activeReaderSessions[session.shareId] = {
    encKey:     session.encKey,
    bookTitle:  session.bookTitle,
    expiresAt:  session.expiresAt,  // ← stored here
  };

  // ── FIX: pass expiresAt to createReaderWindow so URL param is set ──
  createReaderWindow(session.shareId, session.expiresAt);

  // Clean up session token (single use)
  delete sessionMap[sessionToken];

  return { success: true };
});

// Reader fetches the PDF data
ipcMain.handle('reader:getPDF', async (e, { shareId }) => {
  const session = activeReaderSessions[shareId];
  if (!session) return { success: false, error: 'No active session.' };

  const db    = readDB();
  const share = db.shares.find(s => s.id === shareId);

  // Re-check expiry at read time
  if (share && share.expiresAt && Date.now() > share.expiresAt)
    return { success: false, error: 'expired' };

  const encPath = path.join(SHARES_DIR, shareId + '.enc');
  if (!fs.existsSync(encPath)) return { success: false, error: 'File not found.' };

  let pdfBuf;
  try {
    const encBuf = fs.readFileSync(encPath);
    pdfBuf = decryptBuffer(encBuf, session.encKey);
  } catch {
    return { success: false, error: 'Decryption failed.' };
  }

  return {
    success:   true,
    data:      pdfBuf.toString('base64'),   // stays in memory, never on disk
    bookTitle: session.bookTitle || (share ? share.bookTitle : 'Shared Book'),
    // ── FIX: always send expiresAt in the response so reader can start countdown ──
    expiresAt: share ? (share.expiresAt || null) : null,
  };
});

// Reader signals it expired — lock the share
ipcMain.handle('reader:expired', async (e, { shareId }) => {
  const db    = readDB();
  const share = db.shares.find(s => s.id === shareId);
  if (share) {
    share.expiresAt = Date.now() - 1;  // force expired
    writeDB(db);
  }
  delete activeReaderSessions[shareId];
  const win = readerWindows[shareId];
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// ── Window controls ────────────────────────────────────────────────────────
ipcMain.on('window:minimize', e => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', e => {
  const w = BrowserWindow.fromWebContents(e.sender);
  w?.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('window:close', e => BrowserWindow.fromWebContents(e.sender)?.close());

// ── Helpers ────────────────────────────────────────────────────────────────
function formatSize(b) {
  if (b < 1024)        return b + ' B';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// Write device activations back into the source .wellens file
function writeActivationToSourceFile(shareId, activations) {
  const filePath = shareSourceFiles[shareId];
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (content.magic !== 'WELLENS_SECURE_SHARE') return;
    content.activations = activations;
    content.version = Math.max(content.version || 1, 2);
    fs.writeFileSync(filePath, JSON.stringify(content), 'utf8');
  } catch {}
}
