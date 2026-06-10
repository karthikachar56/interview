// server/index.js
// Minimal Express example to store entrance selections

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..')));


const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { admins: new Set(), candidates: new Set(), lastPreview: null, lastDraft: null });
  }
  return sessions.get(id);
}

async function savePreviewSnapshot(id, preview) {
  const { image, previewType } = preview;
  const m = String(image).match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return;
  const mime = m[1];
  const b64 = m[2];
  const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
  const suffix = previewType ? `-${previewType}` : '';
  await fs.mkdir(previewsDir, { recursive: true });
  const filePath = path.join(previewsDir, `${id}${suffix}.${ext}`);
  await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
}

function broadcastPreview(id, preview) {
  const session = getSession(id);
  session.lastPreview = preview;
  void savePreviewSnapshot(id, preview).catch(err => console.warn('save preview snapshot failed:', err));
  console.log(`broadcastPreview: session=${id} previewType=${preview.previewType} adminCount=${session.admins.size}`);
  for (const ws of session.admins) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'preview', ...preview }));
      } catch (err) {
        console.warn('broadcastPreview send failed:', err.message);
      }
    }
  }
}

function broadcastDraft(id, text) {
  const session = getSession(id);
  session.lastDraft = text;
  console.log(`broadcastDraft: session=${id} adminCount=${session.admins.size}`);
  for (const ws of session.admins) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'draft', text }));
      } catch (err) {
        console.warn('broadcastDraft send failed:', err.message);
      }
    }
  }
}

function cleanupClient(ws) {
  if (!ws.sessionId) return;
  const session = sessions.get(ws.sessionId);
  if (!session) return;
  const target = ws.role === 'admin' ? session.admins : session.candidates;
  target.delete(ws);
  if (session.admins.size === 0 && session.candidates.size === 0) {
    sessions.delete(ws.sessionId);
  }
}

const compileTempDir = path.join(__dirname, '..', 'tmp', 'compile');

function formatResult(stdout, stderr) {
  const output = `${stdout || ''}${stderr || ''}`.trim();
  return output || 'No output';
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        return resolve({ error: err, stdout: stdout || '', stderr: stderr || '' });
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function runCompileJob(language, code) {
  const normalized = String(language || '').toLowerCase();
  const supported = {
    python: 'script.py',
    javascript: 'script.js',
    c: 'program.c',
    cpp: 'program.cpp',
    java: 'Main.java'
  };
  const sourceName = supported[normalized];
  if (!sourceName) {
    return { error: `Unsupported language: ${language}` };
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const targetDir = path.join(compileTempDir, jobId);
  await fs.mkdir(targetDir, { recursive: true });
  const sourcePath = path.join(targetDir, sourceName);
  await fs.writeFile(sourcePath, code, 'utf8');

  if (normalized === 'python') {
    let result = await execFilePromise('python', [sourcePath], { cwd: targetDir, timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error && result.error.code === 'ENOENT') {
      result = await execFilePromise('python3', [sourcePath], { cwd: targetDir, timeout: 5000, maxBuffer: 1024 * 1024 });
    }
    return { output: formatResult(result.stdout, result.stderr), error: result.error ? result.error.message : null };
  }

  if (normalized === 'javascript') {
    const nodePath = process.execPath || 'node';
    const result = await execFilePromise(nodePath, [sourcePath], { cwd: targetDir, timeout: 5000, maxBuffer: 1024 * 1024 });
    return { output: formatResult(result.stdout, result.stderr), error: result.error ? result.error.message : null };
  }

  if (normalized === 'c' || normalized === 'cpp') {
    const executableName = process.platform === 'win32' ? 'program.exe' : 'program';
    const executablePath = path.join(targetDir, executableName);
    const compiler = normalized === 'c' ? 'gcc' : 'g++';
    const compileResult = await execFilePromise(compiler, [sourcePath, '-o', executablePath], { cwd: targetDir, timeout: 10000, maxBuffer: 1024 * 1024 });
    if (compileResult.error) {
      return { output: formatResult(compileResult.stdout, compileResult.stderr), error: compileResult.error.message };
    }
    const runResult = await execFilePromise(executablePath, [], { cwd: targetDir, timeout: 5000, maxBuffer: 1024 * 1024 });
    return { output: formatResult(runResult.stdout, runResult.stderr), error: runResult.error ? runResult.error.message : null };
  }

  if (normalized === 'java') {
    const compileResult = await execFilePromise('javac', [sourcePath], { cwd: targetDir, timeout: 10000, maxBuffer: 1024 * 1024 });
    if (compileResult.error) {
      return { output: formatResult(compileResult.stdout, compileResult.stderr), error: compileResult.error.message };
    }
    const runResult = await execFilePromise('java', ['-cp', targetDir, 'Main'], { cwd: targetDir, timeout: 5000, maxBuffer: 1024 * 1024 });
    return { output: formatResult(runResult.stdout, runResult.stderr), error: runResult.error ? runResult.error.message : null };
  }

  return { error: `Language ${language} is not supported` };
}

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://achark659_db_user:achark659@cluster0.o9gcc16.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = 'ai_interview';
const fallbackPath = path.join(__dirname, '..', 'db', 'fallback-entrances.json');
const previewsDir = path.join(__dirname, '..', 'db', 'previews');
let dbClient = null;
let mongoUnavailable = false;
let backupEntrances = [];

async function loadFallback() {
  try {
    const content = await fs.readFile(fallbackPath, 'utf8');
    backupEntrances = JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load fallback data', err);
    backupEntrances = [];
  }
}

async function saveFallback() {
  try {
    await fs.writeFile(fallbackPath, JSON.stringify(backupEntrances, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save fallback data', err);
  }
}

async function connectDb() {
  if (mongoUnavailable) return null;
  if (dbClient) return dbClient;

  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
    socketTimeoutMS: 2000,
    family: 4,
  });

  try {
    await client.connect();
    dbClient = client;
    console.log('Connected to MongoDB');
    return dbClient;
  } catch (err) {
    console.warn('MongoDB unavailable:', err.message);
    mongoUnavailable = true;
    try {
      await client.close();
    } catch (cleanupErr) {
      console.warn('Failed to close Mongo client after connect failure:', cleanupErr.message);
    }
    return null;
  }
}

async function startServer() {
  await loadFallback();
  console.log(`Loaded fallback entrances: ${backupEntrances.length}`);

  // /enter kept for backward-compatibility but entrance page is removed
  app.post('/enter', async (req, res) => {
  const { name, branch, field } = req.body;
  if (!branch || !field) return res.status(400).json({ error: 'branch and field required' });
  try {
    const doc = { name: name || null, branch, field, createdAt: new Date() };
    if (mongoUnavailable) {
      doc.id = `fallback-${Date.now()}`;
      backupEntrances.unshift(doc);
      await saveFallback();
      return res.json({ ok: true, id: doc.id, fallback: true });
    }

    const client = await connectDb();
    if (client) {
      const db = client.db(DB_NAME);
      const result = await db.collection('entrances').insertOne(doc);
      return res.json({ ok: true, id: String(result.insertedId) });
    }

    doc.id = `fallback-${Date.now()}`;
    backupEntrances.unshift(doc);
    await saveFallback();
    res.json({ ok: true, id: doc.id, fallback: true });
  } catch (err) {
    console.error('/enter error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/entrances', async (req, res) => {
  console.log('/api/entrances request, mongoUnavailable=', mongoUnavailable);
  try {
    if (mongoUnavailable) {
      return res.json(backupEntrances);
    }

    const client = await connectDb();
    if (client) {
      const db = client.db(DB_NAME);
        const items = await db.collection('entrances').find().sort({ createdAt: -1 }).toArray();
        // normalize _id to id string for clients
        const normalized = items.map(i => ({ ...i, id: i._id ? String(i._id) : i.id }));
        return res.json(normalized);
    }

    res.json(backupEntrances);
  } catch (err) {
    console.error('/api/entrances error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/entrances/:id', async (req, res) => {
  try {
    const client = await connectDb();
    if (client) {
      const db = client.db(DB_NAME);
      const item = await db.collection('entrances').findOne({ _id: new ObjectId(req.params.id) });
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json(item);
    } else {
      const item = backupEntrances.find(e => e.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json(item);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Preview endpoints: save and serve latest snapshot for a given entrance id
app.post('/api/compile', async (req, res) => {
  try {
    const { language, code } = req.body;
    if (!language || !code) return res.status(400).json({ error: 'language and code required' });

    const compileResult = await runCompileJob(language, code);
    if (compileResult.error) {
      return res.status(200).json({ ok: false, output: compileResult.output, error: compileResult.error });
    }

    res.json({ ok: true, output: compileResult.output });
  } catch (err) {
    console.error('/api/compile POST error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/api/preview/:id', async (req, res) => {
  try {
    const { image, type } = req.body;
    if (!image) return res.status(400).json({ error: 'image required' });

    const m = image.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid image data' });
    const mime = m[1];
    const b64 = m[2];
    const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
    const suffix = type ? `-${type}` : '';

    await fs.mkdir(previewsDir, { recursive: true });
    const filePath = path.join(previewsDir, `${req.params.id}${suffix}.${ext}`);
    const buf = Buffer.from(b64, 'base64');
    await fs.writeFile(filePath, buf);
    console.log(`/api/preview POST saved: id=${req.params.id} type=${type || 'unknown'} path=${filePath}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/preview POST error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/preview/:id', async (req, res) => {
  try {
    const files = await fs.readdir(previewsDir).catch(() => []);
    const qtype = req.query.type; // e.g., 'screen' or 'cam'
    let found = null;
    if (qtype) {
      found = files.find(f => f.startsWith(req.params.id + `-${qtype}.`));
    }
    if (!found) {
      // fallback: prefer screen file, then any matching id.*
      found = files.find(f => f.startsWith(req.params.id + '-screen.')) || files.find(f => f.startsWith(req.params.id + '.')) || files.find(f => f.startsWith(req.params.id + '-cam.'));
    }
    if (!found) return res.status(404).json({ error: 'not found' });
    const filePath = path.join(previewsDir, found);
    const buf = await fs.readFile(filePath);
    const ext = path.extname(found).slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    res.type(mime).send(buf);
  } catch (err) {
    console.error('/api/preview GET error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.role = null;
    ws.sessionId = null;
    console.log('ws connection established');

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'register' && message.role && message.id) {
          ws.role = message.role;
          ws.sessionId = message.id;
          const session = getSession(message.id);
          console.log(`ws register: role=${message.role} id=${message.id}`);
          if (message.role === 'admin') {
            session.admins.add(ws);
            if (session.lastPreview) {
              ws.send(JSON.stringify({ type: 'preview', ...session.lastPreview }));
            }
            if (session.lastDraft) {
              ws.send(JSON.stringify({ type: 'draft', text: session.lastDraft }));
            }
          } else if (message.role === 'candidate') {
            session.candidates.add(ws);
          }
          return;
        }

        if (message.type === 'preview' && ws.role === 'candidate' && ws.sessionId) {
          const { previewType, image } = message;
          if (!previewType || !image) return;
          console.log(`ws preview: session=${ws.sessionId} type=${previewType}`);
          broadcastPreview(ws.sessionId, { previewType, image });
        }

        if (message.type === 'draft' && ws.role === 'candidate' && ws.sessionId) {
          const text = typeof message.text === 'string' ? message.text.trim() : '';
          if (!text) return;
          console.log(`ws draft: session=${ws.sessionId} length=${text.length}`);
          broadcastDraft(ws.sessionId, text);
        }
      } catch (err) {
        console.warn('ws parse error:', err.message);
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
