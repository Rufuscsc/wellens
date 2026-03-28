const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ── Paths ──────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const BOOKS_DIR = path.join(USER_DATA, 'books');
const SHARES_DIR = path.join(USER_DATA, 'shares');
const DB_FILE = path.join(USER_DATA, 'library.json');
const LOCK_FILE = path.join(USER_DATA, '.expired');

[BOOKS_DIR, SHARES_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── DB helpers ─────────────────────────────────────────────────────────────
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { books: [], shares: [] };
  }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Crypto helpers ─────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'wellens-salt-v1').digest('hex');
}
function encryptBuffer(buf, password) {
  const key = crypto.scryptSync(password, 'wellens', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, encrypted]);
}
function decryptBuffer(buf, password) {
  const key = crypto.scryptSync(password, 'wellens', 32);
  const iv = buf.slice(0, 16);
  const data = buf.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── Windows ────────────────────────────────────────────────────────────────
let mainWindow = null;
let readerWindows = {}; // shareId -> BrowserWindow

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0e0c',
    titleBarStyle: 'hiddenInset',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/library.html'));
  // mainWindow.webContents.openDevTools(); // uncomment to debug
}

function createReaderWindow(shareId, expiresAt) {
  // Close any existing reader for this share
  if (readerWindows[shareId]) {
    readerWindows[shareId].close();
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1815',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/reader-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Prevent right-click save, devtools, etc.
      devTools: false,
    }
  });

  // Security: disable right-click context menu
  win.webContents.on('context-menu', (e) => e.preventDefault());

  // Security: block any attempt to navigate away
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Security: block new window opens
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, '../renderer/pages/reader.html'), {
    query: { shareId, expiresAt: String(expiresAt) }
  });

  readerWindows[shareId] = win;
  win.on('closed', () => { delete readerWindows[shareId]; });

  return win;
}

function createPasswordWindow(shareId, shareData) {
  const win = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    backgroundColor: '#0f0e0c',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  win.loadFile(path.join(__dirname, '../renderer/pages/unlock.html'), {
    query: { shareId }
  });
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
      createPasswordWindow(shareId);
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
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) {
      handleDeepLink(url);
    } else {
      app.once('ready', () => handleDeepLink(url));
    }
  });

  app.whenReady().then(() => {
  // Register a custom protocol for serving encrypted PDFs securely
  // We use it from the reader window only
  protocol.handle('wellens', async (request) => {
    const url = new URL(request.url);
    const shareId = url.hostname;
    const db = readDB();
    const share = db.shares.find(s => s.id === shareId);
    if (!share) return new Response('Not Found', { status: 404 });

    // Check expiry
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return new Response('Expired', { status: 410 });
    }

    // Decrypt the PDF
    try {
      const encPath = path.join(SHARES_DIR, share.id + '.enc');
      const encBuf = fs.readFileSync(encPath);
      const pdfBuf = decryptBuffer(encBuf, share.encKey);
      return new Response(pdfBuf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'no-store',
        }
      });
    } catch (err) {
      return new Response('Error', { status: 500 });
    }
  });

  createMainWindow();

  // For Windows/Linux: check args if opened from cold start
  if (process.platform === 'win32' || process.platform === 'linux') {
    const url = process.argv.find(arg => arg.startsWith('wellens-app://'));
    if (url) handleDeepLink(url);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
} // End Single Instance Lock

// ── IPC: Library ───────────────────────────────────────────────────────────

// Upload a book
ipcMain.handle('library:upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a Book',
    filters: [{ name: 'Books', extensions: ['pdf', 'epub', 'mobi', 'azw3'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { success: false };

  const src = result.filePaths[0];
  const fileName = path.basename(src);
  const ext = path.extname(src).slice(1).toLowerCase();
  const id = crypto.randomUUID();
  const dest = path.join(BOOKS_DIR, id + '.' + ext);

  fs.copyFileSync(src, dest);
  const stat = fs.statSync(dest);

  const book = {
    id,
    title: fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
    author: 'Unknown Author',
    format: ext,
    size: formatSize(stat.size),
    sizeBytes: stat.size,
    dateAdded: Date.now(),
    fileName,
    storedName: id + '.' + ext,
  };

  const db = readDB();
  db.books.push(book);
  writeDB(db);

  return { success: true, book };
});

// Get all books
ipcMain.handle('library:getBooks', async () => {
  const db = readDB();
  return db.books;
});

// Delete a book
ipcMain.handle('library:delete', async (e, bookId) => {
  const db = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book) return { success: false };

  const bookPath = path.join(BOOKS_DIR, book.storedName);
  try { fs.unlinkSync(bookPath); } catch {}

  db.books = db.books.filter(b => b.id !== bookId);
  // Also remove shares for this book
  for (const share of db.shares.filter(s => s.bookId === bookId)) {
    try { fs.unlinkSync(path.join(SHARES_DIR, share.id + '.enc')); } catch {}
  }
  db.shares = db.shares.filter(s => s.bookId !== bookId);
  writeDB(db);

  return { success: true };
});

// Open PDF in reader (local, no share)
ipcMain.handle('library:readBook', async (e, bookId) => {
  const db = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book || book.format !== 'pdf') return { success: false, error: 'Only PDF supported for reading' };

  const bookPath = path.join(BOOKS_DIR, book.storedName);

  // Create a temp in-app share with no expiry and a random internal key
  const tempKey = crypto.randomBytes(32).toString('hex');
  const tempId = 'local-' + crypto.randomUUID();

  const pdfBuf = fs.readFileSync(bookPath);
  const encBuf = encryptBuffer(pdfBuf, tempKey);
  fs.writeFileSync(path.join(SHARES_DIR, tempId + '.enc'), encBuf);

  const share = {
    id: tempId,
    bookId,
    bookTitle: book.title,
    encKey: tempKey,
    passwordHash: null, // no password for local read
    expiresAt: null,
    isLocal: true,
    createdAt: Date.now(),
  };
  db.shares.push(share);
  writeDB(db);

  activeReaderSessions[tempId] = tempKey;
  const win = createReaderWindow(tempId, null);
  return { success: true };
});

// ── IPC: Sharing ───────────────────────────────────────────────────────────

// Create a share link
ipcMain.handle('share:create', async (e, { bookId, password, expiresAt }) => {
  const db = readDB();
  const book = db.books.find(b => b.id === bookId);
  if (!book) return { success: false, error: 'Book not found' };
  if (book.format !== 'pdf') return { success: false, error: 'Only PDF books can be shared' };

  const shareId = crypto.randomUUID();
  const encKey = crypto.randomBytes(32).toString('hex');
  const passwordHash = hashPassword(password);

  // Encrypt the PDF with the encKey
  const bookPath = path.join(BOOKS_DIR, book.storedName);
  const pdfBuf = fs.readFileSync(bookPath);
  const encBuf = encryptBuffer(pdfBuf, encKey);
  fs.writeFileSync(path.join(SHARES_DIR, shareId + '.enc'), encBuf);

  // Store the encKey encrypted with the password hash so we can retrieve it after auth
  const encKeyEnc = encryptBuffer(Buffer.from(encKey), passwordHash).toString('base64');

  const share = {
    id: shareId,
    bookId,
    bookTitle: book.title,
    encKeyEnc,        // encKey encrypted with passwordHash
    passwordHash,
    expiresAt: expiresAt || null,
    isLocal: false,
    createdAt: Date.now(),
    linkOpens: 0,
  };

  db.shares.push(share);
  writeDB(db);

  // The "link" points to the web standalone page.
  // The page will redirect to the deep link wellens-app://open/<shareId>.
  const link = `https://Rufuscsc.github.io/wellens/share.html?id=${shareId}`;
  return { success: true, shareId, link };
});

// Get shares list
ipcMain.handle('share:getAll', async () => {
  const db = readDB();
  return db.shares.map(s => ({
    id: s.id,
    bookTitle: s.bookTitle,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    linkOpens: s.linkOpens || 0,
    isLocal: s.isLocal,
    expired: s.expiresAt ? Date.now() > s.expiresAt : false,
  }));
});

// Delete a share
ipcMain.handle('share:delete', async (e, shareId) => {
  const db = readDB();
  try { fs.unlinkSync(path.join(SHARES_DIR, shareId + '.enc')); } catch {}
  db.shares = db.shares.filter(s => s.id !== shareId);
  writeDB(db);
  return { success: true };
});

// Validate password and open reader (called from unlock.html or when link is opened)
ipcMain.handle('share:unlock', async (e, { shareId, password }) => {
  const db = readDB();
  const share = db.shares.find(s => s.id === shareId);
  if (!share) return { success: false, error: 'Share not found' };

  // Check expiry
  if (share.expiresAt && Date.now() > share.expiresAt) {
    return { success: false, error: 'This share link has expired.' };
  }

  // Verify password
  const hash = hashPassword(password);
  if (hash !== share.passwordHash) {
    return { success: false, error: 'Incorrect password.' };
  }

  // Decrypt the encKey
  try {
    const encKeyBuf = Buffer.from(share.encKeyEnc, 'base64');
    const encKey = decryptBuffer(encKeyBuf, hash).toString();

    // Write a session-temp file so reader can access it (no plaintext on disk)
    // We store the encKey in memory via a session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessionMap[sessionToken] = { shareId, encKey, expiresAt: share.expiresAt };

    // Update open count
    share.linkOpens = (share.linkOpens || 0) + 1;
    writeDB(db);

    return { success: true, sessionToken, expiresAt: share.expiresAt };
  } catch {
    return { success: false, error: 'Decryption failed.' };
  }
});

// In-memory session map (cleared on quit)
const sessionMap = {};

// Open reader with a valid session token
ipcMain.handle('share:openReader', async (e, { sessionToken }) => {
  const session = sessionMap[sessionToken];
  if (!session) return { success: false, error: 'Invalid session' };

  // Write re-encrypted copy for the protocol handler
  const db = readDB();
  const share = db.shares.find(s => s.id === session.shareId);
  if (!share) return { success: false };

  // Set the encKey so protocol handler can decrypt it
  // We patch the in-memory copy only
  share._sessionEncKey = session.encKey;

  // Make sure the .enc file is encrypted with the session encKey
  // (it already is — the share.encKeyEnc holds the encKey used during encryption)
  // We need to expose the encKey to the protocol handler
  // We'll use a per-session in-memory store keyed by shareId
  activeReaderSessions[session.shareId] = session.encKey;

  const win = createReaderWindow(session.shareId, session.expiresAt);
  return { success: true };
});

// Active reader sessions (in-memory, cleared on close)
const activeReaderSessions = {};

// Protocol handler needs encKey — update it to use activeReaderSessions
// We already registered protocol above; let's re-handle it:
// (The protocol.handle above will be overridden — move logic here)

// Reader requests PDF data
ipcMain.handle('reader:getPDF', async (e, { shareId }) => {
  const encKey = activeReaderSessions[shareId];
  if (!encKey) return { success: false, error: 'No active session' };

  const encPath = path.join(SHARES_DIR, shareId + '.enc');
  if (!fs.existsSync(encPath)) return { success: false, error: 'File not found' };

  const db = readDB();
  const share = db.shares.find(s => s.id === shareId);

  // Check expiry again
  if (share && share.expiresAt && Date.now() > share.expiresAt) {
    return { success: false, error: 'expired' };
  }

  try {
    const encBuf = fs.readFileSync(encPath);
    const pdfBuf = decryptBuffer(encBuf, encKey);
    // Return as base64 — never written to disk
    return { success: true, data: pdfBuf.toString('base64'), expiresAt: share ? share.expiresAt : null };
  } catch (err) {
    return { success: false, error: 'Decryption error' };
  }
});

// Reader signals expiry — lock the share
ipcMain.handle('reader:expired', async (e, { shareId }) => {
  const db = readDB();
  const share = db.shares.find(s => s.id === shareId);
  if (share) {
    share.expiresAt = Date.now() - 1; // force expired
    writeDB(db);
  }
  delete activeReaderSessions[shareId];
  const win = readerWindows[shareId];
  if (win && !win.isDestroyed()) win.close();
  return { success: true };
});

// Window controls
ipcMain.on('window:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.on('window:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.on('window:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win?.isMaximized() ? win.unmaximize() : win.maximize();
});

// ── Helpers ────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
