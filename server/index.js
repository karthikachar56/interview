// server/index.js
// Minimal Express example to store entrance selections

const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const express = require('express');
const fs = require('fs').promises;
const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const app = express();
app.disable('x-powered-by');

// Security HTTP Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: https:;"
  );
  next();
});

// Lightweight In-Memory Rate Limiter
const rateLimitMap = new Map();
function rateLimit(keyPrefix, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let record = rateLimitMap.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      rateLimitMap.set(key, record);
      return next();
    }
    record.count++;
    if (record.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

// Cleanup expired rate limit records periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now > v.resetTime) rateLimitMap.delete(k);
  }
}, 10 * 60 * 1000);

// Authentication & Cryptographic Security Helpers
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function createAdminToken() {
  const expiresAt = Date.now() + 8 * 3600 * 1000; // 8 hours
  const payload = `admin:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}:${hmac}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [role, expiresStr, signature] = parts;
  if (role !== 'admin') return false;
  const expiresAt = parseInt(expiresStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false;
  const expectedPayload = `${role}:${expiresStr}`;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(expectedPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

function getAdminAuth(req) {
  if (!req) return false;
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (verifyAdminToken(bearerToken)) return true;
  }
  const rc = req.headers?.cookie;
  if (!rc) return false;
  const list = {};
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    }
  });
  return verifyAdminToken(list['admin_auth']);
}

function hashPassword(password) {
  if (!password) return { hash: null, salt: null };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash) return false;
  if (!storedSalt) {
    // Legacy plaintext password compatibility
    return password === storedHash;
  }
  const hash = crypto.scryptSync(password, storedSalt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function sanitizeSession(session) {
  if (!session) return session;
  const copy = { ...session };
  delete copy.password;
  delete copy.passwordHash;
  delete copy.passwordSalt;
  return copy;
}

// Sensitive files and directories access guard (must run before static serving)
app.use((req, res, next) => {
  const cleanPath = req.path.toLowerCase().replace(/\\/g, '/');

  // Block direct access to internal server directories & hidden files
  if (
    cleanPath.startsWith('/server') ||
    cleanPath.startsWith('/db') ||
    cleanPath.startsWith('/node_modules') ||
    cleanPath.startsWith('/tmp') ||
    cleanPath.startsWith('/.') ||
    cleanPath.includes('/.')
  ) {
    return res.status(403).json({ error: 'Forbidden: Access to protected directory is denied.' });
  }

  // Block direct downloading of sensitive backend source/config/metadata files
  if (
    cleanPath.endsWith('.json') ||
    cleanPath.endsWith('.js') ||
    cleanPath.endsWith('.ts') ||
    cleanPath.endsWith('.py') ||
    cleanPath.endsWith('.md') ||
    cleanPath.endsWith('.yml') ||
    cleanPath.endsWith('.yaml') ||
    cleanPath.endsWith('.lock') ||
    cleanPath.includes('dockerfile') ||
    cleanPath.includes('clear_data')
  ) {
    return res.status(403).json({ error: 'Forbidden: Direct access to source and configuration files is denied.' });
  }

  // Admin page protection: require authentication before loading admin HTML files
  if (
    (cleanPath.startsWith('/admin') && cleanPath.endsWith('.html') && cleanPath !== '/admin_login.html') ||
    cleanPath === '/admin.html'
  ) {
    if (!getAdminAuth(req)) {
      return res.redirect('/admin_login.html');
    }
  }

  next();
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..')));

let cachedInstructions = null;


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

const compileTempDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'compile')
  : path.join(__dirname, '..', 'tmp', 'compile');

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
  const normalized = String(language || '').toLowerCase().trim();
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

  if (typeof code !== 'string' || code.length > 50000) {
    return { error: 'Code submission exceeds size limit (50KB maximum)' };
  }

  const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const targetDir = path.join(compileTempDir, jobId);
  await fs.mkdir(targetDir, { recursive: true });
  const sourcePath = path.join(targetDir, sourceName);
  await fs.writeFile(sourcePath, code, 'utf8');

  try {
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
  } finally {
    // Clean up job directory to prevent disk exhaustion
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  }
}

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/ai_interview';
const DB_NAME = 'ai_interview';
const fallbackPath = path.join(__dirname, '..', 'db', 'fallback-entrances.json');
const sessionsFallbackPath = path.join(__dirname, '..', 'db', 'fallback-sessions.json');
const previewsDir = process.env.VERCEL
  ? path.join(os.tmpdir(), 'previews')
  : path.join(__dirname, '..', 'db', 'previews');
let dbClient = null;
let mongoUnavailable = false;
let backupEntrances = [];
let backupSessions = [];

function loadFallback() {
  const fsSync = require('fs');
  try {
    const content = fsSync.readFileSync(fallbackPath, 'utf8');
    backupEntrances = JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load fallback data', err);
    backupEntrances = [];
  }
  try {
    const content = fsSync.readFileSync(sessionsFallbackPath, 'utf8');
    backupSessions = JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load fallback sessions data', err);
    backupSessions = [];
  }
}

async function saveFallback() {
  try {
    await fs.writeFile(fallbackPath, JSON.stringify(backupEntrances, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save fallback data', err);
  }
}

async function saveSessionsFallback() {
  try {
    await fs.writeFile(sessionsFallbackPath, JSON.stringify(backupSessions, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save fallback sessions data', err);
  }
}

async function connectDb() {
  if (process.env.USE_LOCAL_DB === 'true') {
    mongoUnavailable = true;
    return null;
  }
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
    console.warn('TIP: If deploying to Vercel, ensure you have whitelisted access from all IPs (0.0.0.0/0) in MongoDB Atlas, as Vercel uses dynamic IP addresses. Alternatively, set the environment variable USE_LOCAL_DB=true to run in local fallback mode.');
    mongoUnavailable = true;
    try {
      await client.close();
    } catch (cleanupErr) {
      console.warn('Failed to close Mongo client after connect failure:', cleanupErr.message);
    }
    return null;
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function get10QuestionsForRoundAndLevel(round, level = 1) {
  const normalizedRound = String(round || 'Technical Round').trim();
  let questionsObj = null;

  try {
    if (mongoUnavailable) {
      const fs = require('fs');
      const questionsPath = path.join(__dirname, '..', 'db', 'fallback-questions.json');
      questionsObj = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
    } else {
      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        questionsObj = await db.collection('interviewquestions').findOne({ _id: 'global_questions' });
      }
    }
  } catch (err) {
    console.error('Failed to fetch questions from DB/fallback:', err);
  }

  if (!questionsObj) {
    return ["Can you tell me about yourself?", "What is your biggest achievement?", "What is your greatest strength?"];
  }

  // Try exact match or normalized match ignoring _id
  let poolKey = Object.keys(questionsObj).find(k => k !== '_id' && k.toLowerCase().replace(/\s+/g, '') === normalizedRound.toLowerCase().replace(/\s+/g, ''));
  if (!poolKey) poolKey = Object.keys(questionsObj).find(k => k !== '_id') || 'Basic Introduction';

  const pool = questionsObj[poolKey] || [];
  if (pool.length === 0) return ["Can you tell me about yourself?", "What is your biggest achievement?", "What is your greatest strength?"];

  const numLevel = Math.max(1, Math.min(25, parseInt(level) || 1));
  const startIndex = (numLevel - 1) * 10;

  let levelQuestions = pool.slice(startIndex, startIndex + 10);
  if (levelQuestions.length === 0) {
    levelQuestions = pool.slice(0, 10);
  }

  if (normalizedRound.toLowerCase().includes('basic introduction') && numLevel === 1) {
    const forcedQuestion = "Can you tell me about yourself?";
    const filtered = levelQuestions.filter(q => q.toLowerCase() !== forcedQuestion.toLowerCase());
    return [forcedQuestion, ...filtered].slice(0, 10);
  }

  return levelQuestions;
}



async function generateContentWithRetry(promptConfig, maxRetries = 3, delayMs = 5000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await ai.models.generateContent(promptConfig);
      return response;
    } catch (err) {
      attempt++;
      const isRateLimit = err.message && (
        err.message.includes('429') || 
        err.message.toLowerCase().includes('quota') || 
        err.message.toLowerCase().includes('rate limit') || 
        err.message.toLowerCase().includes('resource_exhausted')
      );
      if (isRateLimit && attempt < maxRetries) {
        console.warn(`Gemini API rate limited (429). Retrying attempt ${attempt}/${maxRetries} after ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2; // exponential backoff
      } else {
        throw err;
      }
    }
  }
}

async function evaluateAndCorrectResponse(sessionId, rawAnswer, questionAsked) {
  const cleanAnswer = (rawAnswer || '').trim();
  const lowerAnswer = cleanAnswer.toLowerCase();
  
  // Trivial/filler detector: "hi", "hello", "yes", "no", "idk", "pass", "ok", or 3 words or fewer
  const fillerWords = ['hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'no', 'yeah', 'idk', 'pass', 'don\'t know', 'dont know', 'skip', 'nothing', 'hm', 'hmm'];
  const words = cleanAnswer.split(/\s+/).filter(w => w.length > 0);
  const isTrivial = words.length <= 3 || fillerWords.includes(lowerAnswer);

  let defaultMetrics = {
    confidence: isTrivial ? 0 : 4,
    vocabulary: isTrivial ? 0 : 4,
    answering: isTrivial ? 0 : 4,
    nervousness: isTrivial ? 8 : 4,
    faceExpression: isTrivial ? 2 : 5,
    questionUnderstand: isTrivial ? 0 : 4,
    answerScore: isTrivial ? 0 : 4
  };

  let result = {
    correctedText: rawAnswer,
    metrics: defaultMetrics
  };

  if (!process.env.GEMINI_API_KEY || !rawAnswer || cleanAnswer.length === 0) {
    return result;
  }

  const prompt = `You are an expert, strict interview evaluator and speech-to-text transcription corrector.
Analyze this candidate response to the interview question.

Context:
Interviewer Asked: "${questionAsked}"
Raw Transcription: "${rawAnswer}"

CRITICAL SCORING RULES:
- If the candidate's answer is a trivial greeting, filler, refusal, or non-answer (e.g. "hi", "hello", "yes", "no", "idk", "pass", "ok", or very short irrelevant phrase under 5 words), you MUST score:
  answerScore = 0
  answering = 0
  vocabulary = 0
  confidence = 0
  questionUnderstand = 0
- "answerScore" measures how correctly, accurately, and completely the candidate answered the specific question:
  10 = Perfect, highly detailed, accurate answer
  5-7 = Average answer with partial detail
  1-3 = Very weak or barely relevant answer
  0 = Wrong, trivial greeting ("hi"), refusal ("idk"), or no actual answer provided.

Tasks:
1. Correct obvious garbled/misheard words in the Raw Transcription.
2. Evaluate performance on a scale of 0 to 10 for:
   "confidence", "vocabulary", "answering", "nervousness", "faceExpression", "questionUnderstand", "answerScore".

Respond ONLY with a valid JSON object in this exact format:
{
  "correctedText": "<corrected transcript string>",
  "metrics": {
    "confidence": <0-10>,
    "vocabulary": <0-10>,
    "answering": <0-10>,
    "nervousness": <0-10>,
    "faceExpression": <0-10>,
    "questionUnderstand": <0-10>,
    "answerScore": <0-10>
  }
}`;

  try {
    let parsed = {};
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      const raw = (response.text || '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (aiErr) {
      console.warn("evaluateAndCorrectResponse AI/Parse error (will fallback to defaults):", aiErr.message);
    }

    if (parsed.correctedText) {
      result.correctedText = parsed.correctedText;
    }

    if (parsed.metrics) {
      const fallbackVal = isTrivial ? 0 : 4;
      const getMetric = (val) => (val === undefined || val === null || isNaN(Number(val))) ? fallbackVal : Number(val);
      
      let answerScoreVal = isTrivial ? 0 : Math.min(10, Math.max(0, getMetric(parsed.metrics.answerScore)));
      let answeringVal = isTrivial ? 0 : Math.min(10, Math.max(0, getMetric(parsed.metrics.answering)));
      let vocabVal = isTrivial ? 0 : Math.min(10, Math.max(0, getMetric(parsed.metrics.vocabulary)));
      let confidenceVal = isTrivial ? 0 : Math.min(10, Math.max(0, getMetric(parsed.metrics.confidence)));
      let qUnderstandVal = isTrivial ? 0 : Math.min(10, Math.max(0, getMetric(parsed.metrics.questionUnderstand)));

      result.metrics = {
        confidence: confidenceVal,
        vocabulary: vocabVal,
        answering: answeringVal,
        nervousness: Math.min(10, Math.max(0, getMetric(parsed.metrics.nervousness))),
        faceExpression: Math.min(10, Math.max(0, getMetric(parsed.metrics.faceExpression))),
        questionUnderstand: qUnderstandVal,
        answerScore: answerScoreVal
      };
    }

    // Now, save both correctedText and metrics to the DB/fallback session
    const calculateAverages = (history) => {
      const count = history.length;
      return {
        confidence: Math.round(history.reduce((a, b) => a + b.confidence, 0) / count),
        vocabulary: Math.round(history.reduce((a, b) => a + b.vocabulary, 0) / count),
        answering: Math.round(history.reduce((a, b) => a + b.answering, 0) / count),
        nervousness: Math.round(history.reduce((a, b) => a + b.nervousness, 0) / count),
        faceExpression: Math.round(history.reduce((a, b) => a + b.faceExpression, 0) / count),
        questionUnderstand: Math.round(history.reduce((a, b) => a + b.questionUnderstand, 0) / count)
      };
    };

    if (mongoUnavailable) {
      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (session) {
        // 1. Correct the transcript
        if (Array.isArray(session.transcript)) {
          const msg = session.transcript.find(m => m.role === 'student' && m.text === rawAnswer);
          if (msg) msg.text = result.correctedText;
        }
        // 2. Add metrics
        if (!session.vallyMetricsHistory) session.vallyMetricsHistory = [];
        session.vallyMetricsHistory.push(result.metrics);
        session.vallyMetrics = calculateAverages(session.vallyMetricsHistory);
        await saveSessionsFallback();
      }
    } else {
      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const session = await db.collection('interviewsessions').findOne({ sessionId });
        if (session) {
          const updates = {};
          // 1. Correct the transcript
          if (Array.isArray(session.transcript)) {
            const msg = session.transcript.find(m => m.role === 'student' && m.text === rawAnswer);
            if (msg) {
              msg.text = result.correctedText;
              updates.transcript = session.transcript;
            }
          }
          // 2. Add metrics
          const history = session.vallyMetricsHistory || [];
          history.push(result.metrics);
          updates.vallyMetricsHistory = history;
          updates.vallyMetrics = calculateAverages(history);

          await db.collection('interviewsessions').updateOne(
            { sessionId },
            { $set: updates }
          );
        }
      }
    }

  } catch (err) {
    console.error("evaluateAndCorrectResponse save error:", err);
  }

  return result;
}

async function runBackgroundEvaluation(sessionId, transcript, vallyMetricsHistory) {
  console.log(`Starting background evaluation for session ${sessionId}...`);
  try {
    const transcriptStr = transcript
      .map(m => `${m.role === 'ai' ? 'INTERVIEWER' : m.role === 'student' ? 'CANDIDATE' : 'ADMIN'}: ${m.text}`)
      .join('\n');

    let savedVallyMetrics = null;
    let historyForScore = vallyMetricsHistory || [];
    let warningsCount = 0;

    // Try to load the latest vallyMetricsHistory and cheatingWarnings from the DB/fallback if possible
    try {
      if (mongoUnavailable) {
        const s = backupSessions.find(x => x.sessionId === sessionId);
        if (s) {
          if (s.vallyMetricsHistory && s.vallyMetricsHistory.length > historyForScore.length) {
            historyForScore = s.vallyMetricsHistory;
          }
          if (s.cheatingWarnings !== undefined) {
            warningsCount = s.cheatingWarnings;
          }
        }
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          const s = await db.collection('interviewsessions').findOne({ sessionId });
          if (s) {
            if (s.vallyMetricsHistory && s.vallyMetricsHistory.length > historyForScore.length) {
              historyForScore = s.vallyMetricsHistory;
            }
            if (s.cheatingWarnings !== undefined) {
              warningsCount = s.cheatingWarnings;
            }
          }
        }
      }
    } catch (dbErr) {
      console.warn("Could not fetch latest history from DB on complete, using client history:", dbErr);
    }
    
    if (historyForScore.length > 0) {
      const count = historyForScore.length;
      savedVallyMetrics = {
        confidence: Math.round(historyForScore.reduce((a, b) => a + (b.confidence || 0), 0) / count),
        vocabulary: Math.round(historyForScore.reduce((a, b) => a + (b.vocabulary || 0), 0) / count),
        answering: Math.round(historyForScore.reduce((a, b) => a + (b.answering || 0), 0) / count),
        nervousness: Math.round(historyForScore.reduce((a, b) => a + (b.nervousness || 0), 0) / count),
        faceExpression: Math.round(historyForScore.reduce((a, b) => a + (b.faceExpression || 0), 0) / count),
        questionUnderstand: Math.round(historyForScore.reduce((a, b) => a + (b.questionUnderstand || 0), 0) / count)
      };
    }
    
    // Calculate real-time cumulative score from metrics instead of relying on the final AI evaluation
    const calculatedTotalScore = historyForScore.reduce((sum, item) => sum + (item.answerScore || 0), 0);
    const hasStudentAnswers = transcript.some(m => m.role === 'student');
    
    let score = Math.min(100, Math.max(0, calculatedTotalScore));
    let feedback = 'Good effort. Keep practicing to improve your interview skills.';
    let strengths = [
      { title: 'Willingness to Engage', detail: 'You showed great enthusiasm and active participation in answering the questions throughout the session.' }
    ];
    let improvements = [
      { title: 'Technical Depth', detail: 'Focus on providing deeper technical context and explaining underlying architectural concepts in your answers.' },
      { title: 'Clear Explanations', detail: 'Practice structuring your explanations step-by-step to improve clarity and logical coherence.' }
    ];

    if (warningsCount >= 1) {
      score = 0;
      feedback = 'The candidate was disqualified due to tab switching / window focus loss during the interview.';
      strengths = [
        { title: 'N/A', detail: 'No strengths recorded due to disqualification.' }
      ];
      improvements = [
        { title: 'Adhere to Guidelines', detail: 'Ensure you remain on the interview screen without switching tabs or losing window focus.' }
      ];
    } else if (!hasStudentAnswers) {
      score = 0;
      feedback = 'The candidate exited the interview without providing any answers.';
    } else {
      const transcriptStr = transcript.map(m => `${m.role === 'student' ? 'CANDIDATE' : 'INTERVIEWER'}: ${m.text}`).join('\n');
      
      let vallyMetricsStr = '';
      if (savedVallyMetrics) {
        vallyMetricsStr = `Here are the candidate's real-time behavioral metrics (out of 10) tracked during the interview:
Confidence: ${savedVallyMetrics.confidence}
Vocabulary: ${savedVallyMetrics.vocabulary}
Answering: ${savedVallyMetrics.answering}
Nervousness: ${savedVallyMetrics.nervousness}
Face Expression: ${savedVallyMetrics.faceExpression}
Understanding: ${savedVallyMetrics.questionUnderstand}\n`;
      }

      const evaluationPrompt = `You are an expert interview evaluator. Evaluate this interview transcript.
TRANSCRIPT:
${transcriptStr}
${vallyMetricsStr}
Evaluate the candidate and respond with ONLY valid JSON in this exact format:
{
  "feedback": "<A detailed, comprehensive overall evaluation of the candidate's performance, covering their technical skills, communication style, and confidence. Must be at least 2-3 sentences long.>",
  "strengths": [
    {
      "title": "<1-3 words title>",
      "detail": "<Detailed explanation of this strength with specific examples from their transcript and behavior. Must be 1-2 detailed sentences.>"
    }
  ],
  "improvements": [
    {
      "title": "<1-3 words title>",
      "detail": "<Detailed explanation of what to improve and concrete, actionable advice on how to improve. Must be 1-2 detailed sentences.>"
    }
  ]
}
Provide exactly 2-3 key strengths and exactly 2-3 key improvements based on the candidate's actual answers and behavioral metrics. Be detailed, constructive, and highly professional.`;

      if (process.env.GEMINI_API_KEY) {
        try {
          const response = await generateContentWithRetry({
            model: 'gemini-2.5-flash',
            contents: evaluationPrompt,
          }, 3, 5000);

          const raw = (response.text || '').trim();
          const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
          const parsed = JSON.parse(jsonStr);

          if (parsed.feedback) feedback = parsed.feedback;
          if (Array.isArray(parsed.strengths)) strengths = parsed.strengths.slice(0, 3);
          if (Array.isArray(parsed.improvements)) improvements = parsed.improvements.slice(0, 3);
        } catch (aiErr) {
          console.error('AI evaluation failed, using defaults:', aiErr.message);
          feedback = "Excellent effort! You have successfully completed the interview. Keep practicing to refine your responses and communication delivery.";
          strengths = [
            { title: 'Active Engagement', detail: 'You actively engaged with the interviewer throughout the session, showing high motivation.' },
            { title: 'Logical Reasoning', detail: 'Your answers demonstrated a solid structured thought process and logical reasoning flow.' }
          ];
          improvements = [
            { title: 'Technical Depth', detail: 'Practice detailing the specific tools, libraries, and design choices relevant to the domain.' },
            { title: 'Articulation', detail: 'Work on refining your pacing and delivery structure to ensure your points are concise and clear.' }
          ];
        }
      } else {
        console.warn('GEMINI_API_KEY not set. Using fallback scoring.');
      }
    }

    const updateDoc = {
      status: 'completed',
      aiStatus: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
      transcript,
      score,
      feedback,
      strengths,
      improvements,
      ...(savedVallyMetrics ? { vallyMetrics: savedVallyMetrics } : {})
    };

    if (mongoUnavailable) {
      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', startTime: new Date() };
        backupSessions.unshift(session);
      }
      Object.assign(session, updateDoc);
      await saveSessionsFallback();
    } else {
      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').updateOne(
          { sessionId },
          { $set: updateDoc }
        );
      } else {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', startTime: new Date() };
          backupSessions.unshift(session);
        }
        Object.assign(session, updateDoc);
        await saveSessionsFallback();
      }
    }
    console.log(`Background evaluation completed successfully for session ${sessionId}`);
  } catch (backgroundErr) {
    console.error(`Error in runBackgroundEvaluation for session ${sessionId}:`, backgroundErr);
  }
}

async function startServer() {
  loadFallback();
  console.log(`Loaded fallback entrances: ${backupEntrances.length}`);
  console.log(`Loaded fallback sessions: ${backupSessions.length}`);

  // Admin Endpoints
  app.post('/api/admin/login', rateLimit('admin-login', 5, 5 * 60 * 1000), (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (typeof password !== 'string' || password !== adminPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = createAdminToken();
    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader(
      'Set-Cookie',
      `admin_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${isProd ? '; Secure' : ''}`
    );
    res.json({ success: true, token });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  app.get('/api/admin/sessions', async (req, res) => {
    if (!getAdminAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      if (mongoUnavailable) {
        return res.json({ sessions: backupSessions.map(sanitizeSession) });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const sessions = await db.collection('interviewsessions').find().sort({ updatedAt: -1 }).toArray();
        return res.json({ sessions: sessions.map(sanitizeSession) });
      }

      res.json({ sessions: backupSessions.map(sanitizeSession) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  app.get('/api/admin/ai-config', async (req, res) => {
    if (!getAdminAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      if (mongoUnavailable) {
        if (cachedInstructions !== null) {
          return res.json({ instructions: cachedInstructions });
        }
        const configPath = path.join(__dirname, '..', 'db', 'fallback-aiconfig.json');
        const content = await fs.readFile(configPath, 'utf8')
          .then(JSON.parse)
          .catch(() => ({ instructions: '' }));
        cachedInstructions = content.instructions || '';
        return res.json({ instructions: cachedInstructions });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const config = await db.collection('aiconfigs').findOne();
        cachedInstructions = config?.instructions || '';
        return res.json({ instructions: cachedInstructions });
      }

      if (cachedInstructions !== null) {
        return res.json({ instructions: cachedInstructions });
      }
      const configPath = path.join(__dirname, '..', 'db', 'fallback-aiconfig.json');
      const content = await fs.readFile(configPath, 'utf8')
        .then(JSON.parse)
        .catch(() => ({ instructions: '' }));
      cachedInstructions = content.instructions || '';
      res.json({ instructions: cachedInstructions });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch AI config' });
    }
  });

  app.post('/api/admin/ai-config', async (req, res) => {
    if (!getAdminAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { instructions } = req.body;
    if (!instructions || typeof instructions !== 'string') {
      return res.status(400).json({ error: 'Missing instructions' });
    }

    try {
      if (mongoUnavailable) {
        cachedInstructions = instructions;
        const configPath = path.join(__dirname, '..', 'db', 'fallback-aiconfig.json');
        try {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, JSON.stringify({ instructions }, null, 2), 'utf8');
        } catch (writeErr) {
          console.warn('Failed to write fallback config to read-only FS:', writeErr.message);
        }
        return res.json({ success: true });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('aiconfigs').updateOne(
          {},
          { $set: { instructions } },
          { upsert: true }
        );
        cachedInstructions = instructions;
        return res.json({ success: true });
      }

      cachedInstructions = instructions;
      const configPath = path.join(__dirname, '..', 'db', 'fallback-aiconfig.json');
      try {
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({ instructions }, null, 2), 'utf8');
      } catch (writeErr) {
        console.warn('Failed to write fallback config to read-only FS:', writeErr.message);
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to save AI config' });
    }
  });

  app.post('/api/admin/training-feedback', async (req, res) => {
    if (!getAdminAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sessionId, issueType, correction } = req.body;
    if (!sessionId || !correction) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const note = `[TRAINING FEEDBACK - ${issueType}]: ${correction}`;

    try {
      if (mongoUnavailable) {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], improvements: [], startTime: new Date() };
          backupSessions.unshift(session);
        }
        if (!Array.isArray(session.improvements)) {
          session.improvements = [];
        }
        session.improvements.push(note);
        session.updatedAt = new Date();
        await saveSessionsFallback();
        return res.json({ success: true });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').updateOne(
          { sessionId },
          {
            $push: { improvements: note },
            $set: { updatedAt: new Date() }
          }
        );
        return res.json({ success: true });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], improvements: [], startTime: new Date() };
        backupSessions.unshift(session);
      }
      if (!Array.isArray(session.improvements)) {
        session.improvements = [];
      }
      session.improvements.push(note);
      session.updatedAt = new Date();
      await saveSessionsFallback();
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving training feedback:', err);
      res.status(500).json({ error: 'Failed to save feedback' });
    }
  });

  // candidate login/register
  app.post('/api/student/register', rateLimit('student-register', 15, 5 * 60 * 1000), async (req, res) => {
    const { studentName, srn, usn, college, branch, year, password } = req.body;
    if (typeof studentName !== 'string' || (!srn && !usn)) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const finalSrn = String(srn || usn || '').trim().toUpperCase();
    if (!studentName.trim() || !finalSrn) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Hash password securely if provided
    let passwordHash = null;
    let passwordSalt = null;
    if (typeof password === 'string' && password.trim()) {
      const hp = hashPassword(password.trim());
      passwordHash = hp.hash;
      passwordSalt = hp.salt;
    }

    const sessionId = `${finalSrn}-${Date.now()}`;
    
    const doc = {
      sessionId,
      mode: 'ai',
      adminMessage: null,
      studentAnswer: null,
      studentName: studentName.trim(),
      srn: finalSrn,
      usn: finalSrn, // Keep usn populated for legacy support
      college: typeof college === 'string' ? college.trim() : '',
      branch: typeof branch === 'string' ? branch.trim() : '',
      year: typeof year === 'string' ? year : '4th Year',
      passwordHash,
      passwordSalt,
      status: 'in_progress',
      aiStatus: 'active',
      startTime: new Date(),
      updatedAt: new Date(),
      transcript: []
    };

    try {
      let existingSession = null;
      if (mongoUnavailable) {
        existingSession = backupSessions.find(s => (s.srn === finalSrn || s.usn === finalSrn) && (s.passwordHash || s.password));
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          existingSession = await db.collection('interviewsessions').findOne(
            {
              $and: [
                { $or: [{ srn: finalSrn }, { usn: finalSrn }] },
                { $or: [{ passwordHash: { $ne: null } }, { password: { $ne: null } }] }
              ]
            },
            { sort: { startTime: -1 } }
          );
        }
      }

      if (existingSession) {
        const storedHash = existingSession.passwordHash || existingSession.password;
        const storedSalt = existingSession.passwordSalt || null;
        if (storedHash) {
          if (!password || !verifyPassword(String(password).trim(), storedHash, storedSalt)) {
            return res.status(400).json({ error: "This SRN is already registered. Please log in instead." });
          }
        }
      }

      if (mongoUnavailable) {
        backupSessions = backupSessions.filter(s => s.sessionId !== sessionId);
        backupSessions.unshift(doc);
        await saveSessionsFallback();
        return res.json({ success: true, sessionId, session: sanitizeSession(doc) });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').replaceOne(
          { sessionId },
          doc,
          { upsert: true }
        );
        return res.json({ success: true, sessionId, session: sanitizeSession(doc) });
      }

      backupSessions = backupSessions.filter(s => s.sessionId !== sessionId);
      backupSessions.unshift(doc);
      await saveSessionsFallback();
      res.json({ success: true, sessionId, session: sanitizeSession(doc) });
    } catch (err) {
      console.error('/api/student/register error:', err);
      res.status(500).json({ error: "Failed to register student" });
    }
  });

  // student login lookup by SRN and Password
  app.post('/api/student/login', rateLimit('student-login', 15, 5 * 60 * 1000), async (req, res) => {
    const { srn, password } = req.body;
    const finalSrn = typeof srn === 'string' ? srn.trim().toUpperCase() : '';
    if (!finalSrn) return res.status(400).json({ error: "SRN is required for login" });
    if (typeof password !== 'string') return res.status(400).json({ error: "Password is required" });

    try {
      if (mongoUnavailable) {
        const session = backupSessions.find(s => (s.srn === finalSrn || s.usn === finalSrn) && s.studentName);
        if (!session) {
          return res.status(404).json({ error: "No profile found for this SRN. Please register first." });
        }
        const storedHash = session.passwordHash || session.password;
        const storedSalt = session.passwordSalt || null;
        if (storedHash && !verifyPassword(password, storedHash, storedSalt)) {
          return res.status(401).json({ error: "Incorrect password for this SRN." });
        }
        // Upgrade legacy plaintext password if needed
        if (session.password && !session.passwordSalt) {
          const hp = hashPassword(password);
          session.passwordHash = hp.hash;
          session.passwordSalt = hp.salt;
          delete session.password;
          await saveSessionsFallback();
        }
        return res.json({
          success: true,
          studentName: session.studentName,
          srn: session.srn || session.usn,
          college: session.college,
          branch: session.branch,
          year: session.year
        });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const session = await db.collection('interviewsessions').findOne(
          { $or: [{ srn: finalSrn }, { usn: finalSrn }] },
          { sort: { startTime: -1 } }
        );
        if (!session || !session.studentName) {
          return res.status(404).json({ error: "No profile found for this SRN. Please register first." });
        }
        const storedHash = session.passwordHash || session.password;
        const storedSalt = session.passwordSalt || null;
        if (storedHash && !verifyPassword(password, storedHash, storedSalt)) {
          return res.status(401).json({ error: "Incorrect password for this SRN." });
        }
        // Upgrade legacy plaintext password if needed
        if (session.password && !session.passwordSalt) {
          const hp = hashPassword(password);
          session.passwordHash = hp.hash;
          session.passwordSalt = hp.salt;
          delete session.password;
          await db.collection('interviewsessions').updateMany(
            { $or: [{ srn: finalSrn }, { usn: finalSrn }] },
            { $set: { passwordHash: hp.hash, passwordSalt: hp.salt }, $unset: { password: "" } }
          );
        }
        return res.json({
          success: true,
          studentName: session.studentName,
          srn: session.srn || session.usn,
          college: session.college,
          branch: session.branch,
          year: session.year
        });
      }

      const session = backupSessions.find(s => (s.srn === finalSrn || s.usn === finalSrn) && s.studentName);
      if (!session) {
        return res.status(404).json({ error: "No profile found for this SRN. Please register first." });
      }
      const storedHash = session.passwordHash || session.password;
      const storedSalt = session.passwordSalt || null;
      if (storedHash && !verifyPassword(password, storedHash, storedSalt)) {
        return res.status(401).json({ error: "Incorrect password for this SRN." });
      }
      res.json({
        success: true,
        studentName: session.studentName,
        srn: session.srn || session.usn,
        college: session.college,
        branch: session.branch,
        year: session.year
      });
    } catch (err) {
      console.error('/api/student/login error:', err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // check if SRN is already registered
  app.get('/api/student/check-srn', async (req, res) => {
    const srn = req.query.srn;
    const finalSrn = typeof srn === 'string' ? srn.trim().toUpperCase() : '';
    if (!finalSrn) return res.status(400).json({ error: "Missing srn" });

    try {
      let exists = false;
      if (mongoUnavailable) {
        exists = backupSessions.some(s => (s.srn === finalSrn || s.usn === finalSrn) && (s.passwordHash || s.password));
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          const count = await db.collection('interviewsessions').countDocuments({
            $and: [
              { $or: [{ srn: finalSrn }, { usn: finalSrn }] },
              { $or: [{ passwordHash: { $ne: null } }, { password: { $ne: null } }] }
            ]
          });
          exists = count > 0;
        }
      }
      res.json({ exists: Boolean(exists) });
    } catch (err) {
      console.error('/api/student/check-srn error:', err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // student sessions (history / dashboard stats)
  app.get('/api/student/sessions', async (req, res) => {
    const srn = typeof req.query.srn === 'string' ? req.query.srn : typeof req.query.usn === 'string' ? req.query.usn : '';
    if (!srn.trim()) return res.status(400).json({ error: 'Missing srn' });
    const cleanSrn = srn.trim().toUpperCase();

    try {
      if (mongoUnavailable) {
        const filtered = backupSessions.filter(s => ((s.srn && s.srn === cleanSrn) || (s.usn && s.usn === cleanSrn)) && s.status === 'completed');
        filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        return res.json({ sessions: filtered.map(sanitizeSession) });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const items = await db.collection('interviewsessions')
          .find({
            $or: [
              { srn: cleanSrn },
              { usn: cleanSrn }
            ],
            status: 'completed'
          })
          .sort({ completedAt: -1 })
          .toArray();
        const mapped = items.map(s => sanitizeSession({ ...s, srn: s.srn || s.usn }));
        return res.json({ sessions: mapped });
      }

      const filtered = backupSessions.filter(s => ((s.srn && s.srn === cleanSrn) || (s.usn && s.usn === cleanSrn)) && s.status === 'completed');
      filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
      res.json({ sessions: filtered.map(sanitizeSession) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // Get student level progress for a specific round
  app.get('/api/student/levels', async (req, res) => {
    try {
      const srn = (req.query.srn || '').trim().toUpperCase();
      const round = (req.query.round || 'Basic Introduction').trim();

      if (!srn) return res.status(400).json({ error: 'Missing srn parameter' });

      let completedSessions = [];

      if (mongoUnavailable) {
        completedSessions = backupSessions.filter(s =>
          ((s.srn && s.srn.toUpperCase() === srn) || (s.usn && s.usn.toUpperCase() === srn)) &&
          s.status === 'completed'
        );
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          completedSessions = await db.collection('interviewsessions')
            .find({
              $or: [{ srn }, { usn: srn }],
              status: 'completed'
            })
            .toArray();
        }
      }

      const completedLevels = {};
      let highestPassedLevel = 0;

      completedSessions.forEach(s => {
        const sRound = String(s.round || '').trim().toLowerCase();
        const targetRound = round.trim().toLowerCase();
        if (sRound === targetRound || sRound.replace(/\s+/g, '') === targetRound.replace(/\s+/g, '')) {
          const lvl = parseInt(s.level) || 1;
          const scoreVal = (s.score !== undefined && s.score !== null) ? s.score : 0;
          const passed = scoreVal >= 40;

          if (!completedLevels[lvl] || ((s.score || 0) > (completedLevels[lvl].score || 0))) {
            completedLevels[lvl] = {
              score: scoreVal,
              passed,
              completedAt: s.completedAt
            };
          }

          if (passed && lvl > highestPassedLevel) {
            highestPassedLevel = lvl;
          }
        }
      });

      const highestUnlockedLevel = Math.min(25, highestPassedLevel + 1);

      res.json({
        srn,
        round,
        completedLevels,
        highestUnlockedLevel: Math.max(1, highestUnlockedLevel)
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch level progress' });
    }
  });



  // interview start
  app.post('/api/interview/start', async (req, res) => {
    try {
      const { sessionId } = req.body;
      let round = req.body.round || "Technical Round";
      let level = 1;

      if (sessionId) {
        if (mongoUnavailable) {
          const s = backupSessions.find(x => x.sessionId === sessionId);
          if (s && s.round) round = s.round;
          if (s && s.level) level = s.level;
        } else {
          const client = await connectDb();
          if (client) {
            const db = client.db(DB_NAME);
            const s = await db.collection('interviewsessions').findOne({ sessionId });
            if (s && s.round) round = s.round;
            if (s && s.level) level = s.level;
          }
        }
      }

      if (req.body.level) level = parseInt(req.body.level) || 1;

      const questions = await get10QuestionsForRoundAndLevel(round, level);
      
      // Save selected questions and level to the session
      if (sessionId) {
        if (mongoUnavailable) {
          const s = backupSessions.find(x => x.sessionId === sessionId);
          if (s) {
            s.selectedQuestions = questions;
            s.level = level;
            await saveSessionsFallback();
          }
        } else {
          const client = await connectDb();
          if (client) {
            const db = client.db(DB_NAME);
            await db.collection('interviewsessions').updateOne({ sessionId }, { $set: { selectedQuestions: questions, level } });
          }
        }
      }

      res.json({ question: questions[0], round, level, selectedQuestions: questions });
    } catch (err) {
      console.error(err);
      res.json({ question: "Hello! Let's start with your background. Can you tell me about yourself?" });
    }
  });

  // interview answer
  app.post('/api/interview/answer', async (req, res) => {
    try {
      const { sessionId, history, selectedQuestions } = req.body;
      let round = "Technical Round";
      let level = 1;
      let questions = selectedQuestions;

      if (!questions || questions.length === 0) {
        if (sessionId) {
          if (mongoUnavailable) {
            const s = backupSessions.find(x => x.sessionId === sessionId);
            if (s && s.round) round = s.round;
            if (s && s.level) level = s.level;
            if (s && s.selectedQuestions) questions = s.selectedQuestions;
          } else {
            const client = await connectDb();
            if (client) {
              const db = client.db(DB_NAME);
              const s = await db.collection('interviewsessions').findOne({ sessionId });
              if (s && s.round) round = s.round;
              if (s && s.level) level = s.level;
              if (s && s.selectedQuestions) questions = s.selectedQuestions;
            }
          }
        }
      }

      if (!questions || questions.length === 0) {
        questions = await get10QuestionsForRoundAndLevel(round, level);
      }

      const aiMessageCount = history.filter(msg => msg.role === 'ai' || msg.role === 'admin').length;

      if (aiMessageCount < questions.length) {
        res.json({ question: questions[aiMessageCount] });
      } else {
        res.json({ question: "Thank you for your time today. That concludes our interview questions. We will get back to you soon!" });
      }
    } catch (err) {
      console.error(err);
      res.json({ question: "Interesting. Can you elaborate more on this?" });
    }
  });

  // interview evaluate (async background metrics evaluation & AI transcription correction)
  app.post('/api/interview/evaluate', async (req, res) => {
    try {
      const { sessionId, answer, question } = req.body;
      if (!sessionId || !answer) {
        return res.status(400).json({ error: 'Missing sessionId or answer' });
      }

      const evalResult = await evaluateAndCorrectResponse(sessionId, answer, question || "Unknown question");
      res.json({ metrics: evalResult.metrics, correctedText: evalResult.correctedText });
    } catch (err) {
      console.error("Async evaluation handler error:", err);
      res.status(500).json({ error: "Failed to evaluate metrics" });
    }
  });

  // interview sync (GET & POST)
  app.get('/api/interview/sync', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    try {
      if (mongoUnavailable) {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date(), updatedAt: new Date() };
          backupSessions.unshift(session);
          await saveSessionsFallback();
        }
        return res.json({ session: sanitizeSession(session) });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        let session = await db.collection('interviewsessions').findOne({ sessionId });
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date(), updatedAt: new Date() };
          await db.collection('interviewsessions').insertOne(session);
        }
        return res.json({ session: sanitizeSession(session) });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date(), updatedAt: new Date() };
        backupSessions.unshift(session);
        await saveSessionsFallback();
      }
      res.json({ session: sanitizeSession(session) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.post('/api/interview/sync', async (req, res) => {
    const { sessionId, mode, adminMessage, studentAnswer, status, aiStatus, round, level, score, cheatingWarnings } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const updates = {};
    if (mode !== undefined) updates.mode = mode;
    if (adminMessage !== undefined) updates.adminMessage = adminMessage;
    if (studentAnswer !== undefined) updates.studentAnswer = studentAnswer;
    if (cheatingWarnings !== undefined) updates.cheatingWarnings = Number(cheatingWarnings);
    if (status !== undefined) {
      updates.status = status;
      if (status === 'completed') {
        updates.aiStatus = 'completed';
      }
    }
    if (aiStatus !== undefined) updates.aiStatus = aiStatus;
    if (round !== undefined) updates.round = round;
    if (level !== undefined) updates.level = parseInt(level) || 1;
    if (score !== undefined) {
      updates.score = score;
      updates.status = 'completed';
      updates.aiStatus = 'completed';
      updates.completedAt = new Date();
      updates.feedback = "Admin manually evaluated and completed the interview.";
      updates.strengths = ["Completed supervised interview"];
      updates.improvements = ["N/A"];
    }
    updates.updatedAt = new Date();

    if (updates.status === 'completed') {
      const wsSession = sessions.get(sessionId);
      if (wsSession) {
        const msg = JSON.stringify({ type: 'completed' });
        for (const ws of wsSession.candidates) {
          if (ws.readyState === 1) {
            try { ws.send(msg); } catch (e) { console.warn("Failed to notify candidate via WS completed:", e.message); }
          }
        }
      }
    }

    try {
      if (mongoUnavailable) {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date() };
          backupSessions.unshift(session);
        }
        Object.assign(session, updates);
        await saveSessionsFallback();
        return res.json({ success: true, session: sanitizeSession(session) });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        let session = await db.collection('interviewsessions').findOne({ sessionId });
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date() };
          await db.collection('interviewsessions').insertOne(session);
        }
        await db.collection('interviewsessions').updateOne({ sessionId }, { $set: updates });
        const updated = await db.collection('interviewsessions').findOne({ sessionId });
        return res.json({ success: true, session: sanitizeSession(updated) });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date() };
        backupSessions.unshift(session);
      }
      Object.assign(session, updates);
      await saveSessionsFallback();
      res.json({ success: true, session: sanitizeSession(session) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update session" });
    }
  });

  // leaderboard
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const getAggregatedFallback = () => {
        const completed = backupSessions.filter(s => s.status === 'completed' && s.score !== undefined);
        const map = new Map();
        for (const s of completed) {
          const key = s.srn || s.usn;
          if (!map.has(key)) {
            map.set(key, { ...s, score: 0 });
          }
          const entry = map.get(key);
          entry.score += s.score;
          if (new Date(s.completedAt) > new Date(entry.completedAt)) {
            entry.completedAt = s.completedAt;
          }
        }
        const aggregated = Array.from(map.values());
        aggregated.sort((a, b) => b.score - a.score);
        return aggregated.slice(0, 25).map(s => ({
          studentName: s.studentName,
          srn: s.srn || s.usn,
          usn: s.srn || s.usn,
          college: s.college,
          branch: s.branch,
          score: s.score,
          completedAt: s.completedAt
        }));
      };

      if (mongoUnavailable) {
        return res.json({ leaderboard: getAggregatedFallback() });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const items = await db.collection('interviewsessions').aggregate([
          { $match: { status: 'completed', score: { $exists: true } } },
          { $group: {
              _id: { $ifNull: [ '$srn', '$usn' ] },
              studentName: { $first: '$studentName' },
              college: { $first: '$college' },
              branch: { $first: '$branch' },
              score: { $sum: '$score' },
              completedAt: { $max: '$completedAt' }
          }},
          { $sort: { score: -1 } },
          { $limit: 25 },
          { $project: {
              _id: 0,
              srn: '$_id',
              usn: '$_id',
              studentName: 1,
              college: 1,
              branch: 1,
              score: 1,
              completedAt: 1
          }}
        ]).toArray();
        return res.json({ leaderboard: items });
      }

      res.json({ leaderboard: getAggregatedFallback() });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // interview complete (Gemini Evaluation)
  app.post('/api/interview/complete', (req, res) => {
    try {
      const { sessionId, transcript, vallyMetricsHistory } = req.body;
      if (!sessionId || !Array.isArray(transcript)) {
        return res.status(400).json({ error: 'Missing sessionId or transcript' });
      }

      // Send immediate success response to client so navigation transitions instantly
      res.json({ success: true, message: "Evaluation initiated in the background." });

      // Run evaluation asynchronously in the background
      void runBackgroundEvaluation(sessionId, transcript, vallyMetricsHistory);
    } catch (err) {
      console.error('Error starting complete interview request:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to complete interview' });
      }
    }
  });

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
  if (!getAdminAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
  if (!getAdminAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  try {
    const client = await connectDb();
    if (client && ObjectId.isValid(id)) {
      const db = client.db(DB_NAME);
      const item = await db.collection('entrances').findOne({ _id: new ObjectId(id) });
      if (!item) return res.status(404).json({ error: 'not found' });
      return res.json(item);
    } else {
      const item = backupEntrances.find(e => e.id === id);
      if (!item) return res.status(404).json({ error: 'not found' });
      return res.json(item);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Preview endpoints: save and serve latest snapshot for a given entrance id
app.post('/api/compile', rateLimit('compile', 20, 60 * 1000), async (req, res) => {
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
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const { image, type } = req.body;
    if (!image) return res.status(400).json({ error: 'image required' });

    const cleanType = type && /^[a-zA-Z0-9_\-]+$/.test(type) ? type : '';
    const m = String(image).match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'invalid image data' });
    const mime = m[1];
    const b64 = m[3];
    const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
    const suffix = cleanType ? `-${cleanType}` : '';

    await fs.mkdir(previewsDir, { recursive: true });
    const fileName = `${id}${suffix}.${ext}`;
    const filePath = path.join(previewsDir, fileName);

    // Path traversal defense
    if (!path.resolve(filePath).startsWith(path.resolve(previewsDir))) {
      return res.status(400).json({ error: 'invalid path' });
    }

    const buf = Buffer.from(b64, 'base64');
    await fs.writeFile(filePath, buf);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/preview POST error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/api/preview/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const files = await fs.readdir(previewsDir).catch(() => []);
    const qtype = req.query.type; // e.g., 'screen' or 'cam'
    const cleanType = qtype && /^[a-zA-Z0-9_\-]+$/.test(qtype) ? qtype : null;
    let found = null;
    if (cleanType) {
      found = files.find(f => f.startsWith(id + `-${cleanType}.`));
    }
    if (!found) {
      // fallback: prefer screen file, then any matching id.*
      found = files.find(f => f.startsWith(id + '-screen.')) || files.find(f => f.startsWith(id + '.')) || files.find(f => f.startsWith(id + '-cam.'));
    }
    if (!found) return res.status(404).json({ error: 'not found' });
    const filePath = path.join(previewsDir, found);

    // Path traversal defense
    if (!path.resolve(filePath).startsWith(path.resolve(previewsDir))) {
      return res.status(400).json({ error: 'invalid path' });
    }

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

  wss.on('connection', (ws, req) => {
    ws.role = null;
    ws.sessionId = null;
    console.log('ws connection established');

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'register' && message.role && message.id) {
          if (message.role === 'admin' && !getAdminAuth(req)) {
            console.warn('Unauthorized admin WebSocket connection attempt rejected');
            try {
              ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Admin authentication required' }));
            } catch (e) {}
            return;
          }

          ws.role = message.role;
          ws.sessionId = String(message.id);
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

        if (message.type === 'cheating_warning' && ws.role === 'candidate' && ws.sessionId) {
          const { count, details } = message;
          console.log(`ws cheating_warning: session=${ws.sessionId} count=${count} details=${details}`);
          const session = getSession(ws.sessionId);
          const msg = JSON.stringify({ type: 'cheating_warning', count, details });
          for (const adminWs of session.admins) {
            if (adminWs.readyState === 1) {
              try { adminWs.send(msg); } catch (e) { console.warn("Failed to notify admin via WS cheating_warning:", e.message); }
            }
          }
        }
      } catch (err) {
        console.warn('ws parse error:', err.message);
      }
    });

    ws.on('close', () => cleanupClient(ws));
    ws.on('error', () => cleanupClient(ws));
  });

  if (require.main === module) {
    server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
  }
}

// Export the app for Vercel Serverless Function deployment
module.exports = app;

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
} else {
  startServer().catch(err => {
    console.error('Failed to initialize server routes:', err);
  });
}
