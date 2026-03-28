# Wellens — Secure Book Library

A fully encrypted, DRM-protected PDF reading and sharing app built with Electron.

---

## ⚡ Quick Start

### Prerequisites
- [Node.js](https://nodejs.org) v18 or later

### Run

```bash
cd wellens
npm install
npm start
```

Or on macOS/Linux:
```bash
chmod +x run.sh && ./run.sh
```

---

## 🔐 Security Features

### PDF Encryption
- Every uploaded book is stored on disk — no unencrypted originals are kept after the share is created
- Shared PDFs are encrypted with **AES-256-CBC** using a key derived from your password via `scrypt`
- The encryption key is itself encrypted with the password hash and stored in the DB — the plaintext key **never touches disk**
- PDF bytes are transferred to the renderer as a **base64 in-memory buffer** only — no temp file is written

### Reader DRM
- **Right-click is disabled** — no "Save As" context menu
- **All keyboard shortcuts blocked**: Ctrl+S, Ctrl+P, Ctrl+C, Ctrl+A, PrintScreen, F12, Ctrl+Shift+I
- **Text selection disabled** on all canvas elements — nothing to copy
- **DevTools disabled** in reader windows
- **Navigation blocked** — renderer cannot navigate away
- **New windows blocked** — `setWindowOpenHandler` denies all
- **Canvas rendering only** — PDF is rendered to `<canvas>` via PDF.js; no selectable DOM text layer
- **Subtle watermark** rendered on every page canvas: `WELLENS — PROTECTED`

### Share Links
- Each share link is a unique UUID: `wellens-app://open/<shareId>`
- Password required to unlock — hashed with SHA-256 + salt before storing
- Optional **expiry date** — set any future datetime
- On expiry: reader shows an "Access Expired" screen and auto-closes in 5 seconds
- Share can be **revoked** at any time from the Shared Links page
- Each link tracks how many times it has been opened

---

## 📖 How to Use

### Upload a Book
1. Click **Upload Book** in the top-right
2. Select a PDF (or EPUB/MOBI — note: only PDFs can be read in-app or shared)
3. Book appears in your library immediately

### Read a PDF
- Click the **Read** button on any PDF card
- Opens the secure reader window — no download, no copy, no print

### Share a PDF
1. Click the **share icon** (gold button) on any PDF card
2. Set a **password** — the recipient will need this to open the book
3. Optionally set an **expiry date** — access auto-locks after this time
4. Click **Create Share Link** — a `wellens-app://open/<id>` link is generated
5. Copy the link and send it to your recipient via any channel (email, message, etc.)

### Recipient Opens the Link
The recipient must also have **Wellens installed**. When they open the app:
1. They open the link (or you can paste the shareId and open unlock.html manually)
2. A password entry window appears
3. After entering the correct password, the secure reader opens
4. If an expiry was set, a countdown timer is visible at the top of the reader
5. When time runs out, the reader displays "Access Expired" and closes

### Manage Shares
- Click **Shared Links** in the left sidebar
- See all active/expired shares with open counts and expiry info
- Click the delete icon to **revoke** a share at any time

---

## 🗂 Project Structure

```
wellens/
├── package.json
├── run.sh
├── src/
│   ├── main/
│   │   └── main.js          ← Electron main process (IPC, crypto, file I/O)
│   ├── preload/
│   │   ├── preload.js        ← Safe API bridge for library/unlock windows
│   │   └── reader-preload.js ← Minimal bridge for reader window
│   └── renderer/
│       └── pages/
│           ├── library.html  ← Main library UI
│           ├── unlock.html   ← Password entry screen
│           └── reader.html   ← Secure PDF reader (PDF.js + DRM)
└── README.md
```

---

## ⚠️ Notes

- **Only PDF format** is supported for reading and sharing. EPUB/MOBI are stored but cannot be read in-app yet (requires additional renderer).
- Share links (`wellens-app://open/<id>`) are **deep links for internal use**. To share across machines, you would need to set up a relay server or use the shareId directly (the recipient opens their Wellens app and enters the ID).
- For a **production multi-user deployment**, consider a backend sync service. This version stores everything locally in Electron's `userData` directory.
- Screenshots via OS-level tools (e.g., macOS Cmd+Shift+3) **cannot be blocked at the app level** — this is an OS limitation. The watermark and canvas-only rendering make the content less useful if screenshotted.

---

## 🛠 Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Electron 29 |
| PDF Rendering | PDF.js (CDN) |
| Encryption | Node.js `crypto` (AES-256-CBC, scrypt) |
| Storage | JSON file in `app.getPath('userData')` |
| UI | Vanilla HTML/CSS/JS |
| Fonts | Playfair Display + DM Sans (Google Fonts) |
