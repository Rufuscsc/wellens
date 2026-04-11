const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'store.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Get activations for a share
app.get('/api/activations/:shareId', (req, res) => {
  const db = readDB();
  const shareId = req.params.shareId;
  res.json({ activations: db[shareId] || [] });
});

// Register a device or check existing
app.post('/api/activations/:shareId', (req, res) => {
  const db = readDB();
  const shareId = req.params.shareId;
  const { deviceId, maxDevices } = req.body;

  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  if (!db[shareId]) {
    db[shareId] = [];
  }

  const activations = db[shareId];
  const existing = activations.find(a => a.deviceId === deviceId);

  if (existing) {
    // Device already registered
    return res.json({ success: true, isNew: false, activations });
  }

  // Check limits before adding new device
  if (activations.length >= (maxDevices || 999)) {
    return res.status(403).json({ success: false, error: 'Device limit reached for this share.' });
  }

  // Register new device
  activations.push({ deviceId, activatedAt: Date.now() });
  writeDB(db);

  res.json({ success: true, isNew: true, activations });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Wellens backend server running on port ${PORT}`);
});
