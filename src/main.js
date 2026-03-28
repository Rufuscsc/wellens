const { app, BrowserWindow, ipcMain, dialog, session, Menu, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const url = require('url');
const os = require('os');

// ─── Paths ───────────────────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const BOOKS_DIR = path.join(USER_DATA, 'books');
const DB_FILE   = path.join(USER_DATA, 'library.json');
const SHARES_FILE = path.join(USER_DATA, 'shares.json');

if (!fs.existsSync(BOOKS_DIR)) fs.mkdirSync(BOOKS_DIR, { recursive: true });

// ─── DB helpers ──────────────────────────────────────────────────────────────
function loadDB()     { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function loadShares() { try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); } catch { return {}; } }
function saveShares(data) { fs.writeFileSync(SHARES_FILE, JSON.stringify(data, null, 2)); }

// ─── Crypto helpers ───────────────────────────────────────────────────────────
const ALGO = 'aes-256-gcm';

function encryptFile(inputPath, password) {
  const key  = crypto.scryptSync(password, 'librarium-salt-v1', 32);
  const iv   = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = fs.readFileSync(inputPath);
  const enc  = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag  = cipher.getAuthTag();
  // Format: [iv 16b][tag 16b][encrypted]
  return Buffer.concat([iv, tag, enc]);
}

function decryptBuffer(encBuffer, password) {
  const key = crypto.scryptSync(password, 'librarium-salt-v1', 32);
  const iv  = encBuffer.slice(0, 16);
  const tag = encBuffer.slice(16, 32);
  const enc = encBuffer.slice(32);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd + 'librarium-pw-salt').digest('hex');
}

// ─── Share server ─────────────────────────────────────────────────────────────
let shareServer = null;
let shareServerPort = 0;

function startShareServer() {
  if (shareServer) return;
  shareServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const parts  = parsed.pathname.split('/').filter(Boolean);

    // CORS for same-machine access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // GET /share/:token  → serve viewer HTML
    if (parts[0] === 'share' && parts[1] && req.method === 'GET' && !parts[2]) {
      const token = parts[1];
      const shares = loadShares();
      const share  = shares[token];
      if (!share) { res.writeHead(404); res.end('Not found'); return; }
      if (Date.now() > share.expiresAt) { res.writeHead(410); res.end('Link expired'); return; }
      // Serve the viewer page
      const viewerHTML = fs.readFileSync(path.join(__dirname, '..', 'viewer', 'viewer.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(viewerHTML);
      return;
    }

    // POST /share/:token/auth  → verify password, return session token
    if (parts[0] === 'share' && parts[1] && parts[2] === 'auth' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const token = parts[1];
        const shares = loadShares();
        const share  = shares[token];
        if (!share) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
        if (Date.now() > share.expiresAt) { res.writeHead(410); res.end(JSON.stringify({ ok: false, error: 'Link expired' })); return; }
        try {
          const { password } = JSON.parse(body);
          if (hashPassword(password) !== share.passwordHash) {
            res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'Wrong password' })); return;
          }
          // Issue short-lived session token
          const sessionToken = crypto.randomBytes(32).toString('hex');
          share.sessions = share.sessions || {};
          share.sessions[sessionToken] = { created: Date.now(), expiresAt: share.expiresAt };
          saveShares(shares);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionToken, expiresAt: share.expiresAt, title: share.title }));
        } catch(e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Bad request' })); }
      });
      return;
    }

    // GET /share/:token/pdf?session=xxx  → stream encrypted PDF
    if (parts[0] === 'share' && parts[1] && parts[2] === 'pdf' && req.method === 'GET') {
      const token = parts[1];
      const sessionToken = parsed.query.session;
      const shares = loadShares();
      const share  = shares[token];
      if (!share) { res.writeHead(404); res.end('Not found'); return; }
      if (Date.now() > share.expiresAt) { res.writeHead(410); res.end('Expired'); return; }
      const session = share.sessions && share.sessions[sessionToken];
      if (!session || Date.now() > session.expiresAt) { res.writeHead(403); res.end('Unauthorized'); return; }

      // Decrypt and stream
      try {
        const encPath = path.join(BOOKS_DIR, share.encryptedFile);
        const encData = fs.readFileSync(encPath);
        const pdfData = decryptBuffer(encData, share.fileKey);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdfData.length,
          'Cache-Control': 'no-store, no-cache',
          'Content-Disposition': 'inline'         // never attachment
        });
        res.end(pdfData);
      } catch(e) {
        console.error('Decrypt error:', e);
        res.writeHead(500); res.end('Decrypt failed');
      }
      return;
    }

    // GET /share/:token/meta?session=xxx → remaining ms
    if (parts[0] === 'share' && parts[1] && parts[2] === 'meta' && req.method === 'GET') {
      const token = parts[1];
      const sessionToken = parsed.query.session;
      const shares = loadShares();
      const share  = shares[token];
      if (!share) { res.writeHead(404); res.end('{}'); return; }
      const session = share.sessions && share.sessions[sessionToken];
      if (!session) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ remainingMs: Math.max(0, share.expiresAt - Date.now()), title: share.title }));
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  shareServer.listen(0, '127.0.0.1', () => {
    shareServerPort = shareServer.address().port;
    console.log('Share server on port', shareServerPort);
  });
}

// ─── Windows ──────────────────────────────────────────────────────────────────
let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    }
  });

  // Block right-click save, DevTools in production
  mainWindow.webContents.on('context-menu', e => e.preventDefault());
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (e, input) => {
      if (input.key === 'F12') e.preventDefault();
      if (input.control && input.shift && input.key === 'I') e.preventDefault();
    });
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  Menu.setApplicationMenu(null);
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startShareServer();
  createMainWindow();

  // Block all PDF downloads globally
  session.defaultSession.on('will-download', (e) => { e.preventDefault(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// ─── IPC: Library ─────────────────────────────────────────────────────────────
ipcMain.handle('library:load', () => loadDB());

ipcMain.handle('library:upload', async (_, filePath) => {
  const books = loadDB();
  const ext   = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') return { ok: false, error: 'Only PDF files are supported.' };

  const id       = crypto.randomUUID();
  const stat     = fs.statSync(filePath);
  const destName = id + '.pdf';
  const destPath = path.join(BOOKS_DIR, destName);
  fs.copyFileSync(filePath, destPath);

  const book = {
    id,
    title: path.basename(filePath, ext),
    author: 'Unknown',
    format: 'pdf',
    size: (stat.size / 1048576).toFixed(1) + ' MB',
    sizeBytes: stat.size,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    file: destName,
    encrypted: false,
    shared: false,
    shareToken: null
  };
  books.unshift(book);
  saveDB(books);
  return { ok: true, book };
});

ipcMain.handle('library:delete', (_, id) => {
  let books = loadDB();
  const book = books.find(b => b.id === id);
  if (book) {
    const filePath = path.join(BOOKS_DIR, book.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // also remove encrypted copy if any
    const encPath = path.join(BOOKS_DIR, id + '.enc');
    if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
  }
  books = books.filter(b => b.id !== id);
  saveDB(books);
  return { ok: true };
});

// ─── IPC: Open file picker ────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a PDF book',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── IPC: Read PDF (secure, inline) ──────────────────────────────────────────
ipcMain.handle('book:read', async (event, id) => {
  const books = loadDB();
  const book  = books.find(b => b.id === id);
  if (!book) return { ok: false, error: 'Book not found' };
  const filePath = path.join(BOOKS_DIR, book.file);
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File missing' };
  const data = fs.readFileSync(filePath);
  return { ok: true, data: data.toString('base64'), title: book.title };
});

// ─── IPC: Share ───────────────────────────────────────────────────────────────
ipcMain.handle('share:create', async (_, { bookId, password, expiresInMs }) => {
  const books = loadDB();
  const book  = books.find(b => b.id === bookId);
  if (!book) return { ok: false, error: 'Book not found' };

  const token    = crypto.randomBytes(20).toString('hex');
  const fileKey  = crypto.randomBytes(32).toString('hex'); // key used to encrypt the shared file copy
  const encName  = token + '.enc';
  const encPath  = path.join(BOOKS_DIR, encName);
  const srcPath  = path.join(BOOKS_DIR, book.file);

  // Encrypt file copy with a random key (not the user password directly)
  const key    = crypto.scryptSync(fileKey, 'librarium-salt-v1', 32);
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const raw    = fs.readFileSync(srcPath);
  const enc    = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag    = cipher.getAuthTag();
  fs.writeFileSync(encPath, Buffer.concat([iv, tag, enc]));

  const share = {
    token,
    bookId,
    title: book.title,
    passwordHash: hashPassword(password),
    fileKey,
    encryptedFile: encName,
    expiresAt: Date.now() + expiresInMs,
    createdAt: Date.now(),
    sessions: {}
  };

  const shares = loadShares();
  shares[token] = share;
  saveShares(shares);

  // Mark book as shared
  book.shared = true;
  book.shareToken = token;
  saveDB(books);

  const link = `http://127.0.0.1:${shareServerPort}/share/${token}`;
  return { ok: true, link, token };
});

ipcMain.handle('share:revoke', (_, token) => {
  const shares = loadShares();
  if (shares[token]) {
    const encPath = path.join(BOOKS_DIR, shares[token].encryptedFile);
    if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
    delete shares[token];
    saveShares(shares);
  }
  const books = loadDB();
  const book  = books.find(b => b.shareToken === token);
  if (book) { book.shared = false; book.shareToken = null; saveDB(books); }
  return { ok: true };
});

ipcMain.handle('share:list', () => {
  const shares = loadShares();
  return Object.values(shares).map(s => ({
    token: s.token, bookId: s.bookId, title: s.title,
    expiresAt: s.expiresAt, createdAt: s.createdAt,
    expired: Date.now() > s.expiresAt
  }));
});

ipcMain.handle('share:serverPort', () => shareServerPort);
