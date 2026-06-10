// server/index.js
// Minimal Express example to store entrance selections

const path = require('path');
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

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb+srv://achark659_db_user:achark659@cluster0.o9gcc16.mongodb.net/?retryWrites=true&w=majority';
const DB_NAME = 'ai_interview';
const fallbackPath = path.join(__dirname, '..', 'db', 'fallback-entrances.json');
const sessionsFallbackPath = path.join(__dirname, '..', 'db', 'fallback-sessions.json');
const previewsDir = path.join(__dirname, '..', 'db', 'previews');
let dbClient = null;
let mongoUnavailable = false;
let backupEntrances = [];
let backupSessions = [];

async function loadFallback() {
  try {
    const content = await fs.readFile(fallbackPath, 'utf8');
    backupEntrances = JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load fallback data', err);
    backupEntrances = [];
  }
  try {
    const content = await fs.readFile(sessionsFallbackPath, 'utf8');
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

const QUESTIONS_BY_ROUND = {
  "Basic Introduction": [
    "Hello! Let's start with your background. Can you tell me about yourself?",
    "What are your hobbies and interest areas outside of study or work?",
    "Why did you choose your branch of study, and what did you enjoy most about it?",
    "Where do you see yourself in 3 years from now?",
    "Finally, do you have any questions for me about the platform or the mock assessment?"
  ],
  "Aptitude Round": [
    "Welcome to the Aptitude Round. Let's do some logical reasoning. If a clock strikes 6 times in 5 seconds, how long will it take to strike 12 times?",
    "A train traveling at 60 km/h passes a pole in 9 seconds. What is the length of the train in meters?",
    "A box contains 5 red, 8 blue, and 3 green marbles. If 3 marbles are drawn at random, what is the probability that they are all blue?",
    "If 5 workers can build 5 tables in 5 days, how many days will it take 100 workers to build 100 tables?",
    "That concludes the aptitude questions. Do you have any general comments on these questions?"
  ],
  "Technical Round": [
    "Hello! Let's start with your background. Can you tell me about yourself and your recent experience?",
    "Could you describe a challenging technical problem you recently solved and how you approached it?",
    "What is your experience with system design and architecture?",
    "How do you handle disagreements within your team regarding technical decisions?",
    "Can you explain a time when you had to optimize the performance of an application?",
    "What testing methodologies do you follow to ensure the reliability of your code?",
    "How do you stay updated with the latest technologies and industry trends?",
    "Could you share your experience with CI/CD pipelines and deployment strategies?",
    "Describe a situation where you had to quickly learn a new technology to complete a project.",
    "Finally, do you have any questions for me about the company or the role?"
  ],
  "HR Round": [
    "Welcome to the HR round. Why do you want to work with us?",
    "Can you describe a situation where you worked under a tight deadline and how you managed it?",
    "What are your key strengths, and what is one major area you are working to improve?",
    "How do you handle conflicts or work-related stress?",
    "Finally, do you have any questions for me about the company or the team culture?"
  ]
};

function getQuestionsForRound(round) {
  const normalized = Object.keys(QUESTIONS_BY_ROUND).find(
    r => r.toLowerCase().replace(/\s+/g, '') === String(round || '').toLowerCase().replace(/\s+/g, '')
  );
  return QUESTIONS_BY_ROUND[normalized || "Technical Round"];
}

async function startServer() {
  await loadFallback();
  console.log(`Loaded fallback entrances: ${backupEntrances.length}`);
  console.log(`Loaded fallback sessions: ${backupSessions.length}`);

  // candidate login/register
  app.post('/api/student/register', async (req, res) => {
    const { studentName, usn, college, branch, year } = req.body;
    if (!studentName || !usn) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const sessionId = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
    
    const doc = {
      sessionId,
      mode: 'ai',
      adminMessage: null,
      studentAnswer: null,
      studentName: studentName.trim(),
      usn: usn.trim().toUpperCase(),
      college: (college || '').trim(),
      branch: (branch || '').trim(),
      year: year || '4th Year',
      status: 'in_progress',
      aiStatus: 'active',
      startTime: new Date(),
      updatedAt: new Date(),
      transcript: []
    };

    try {
      if (mongoUnavailable) {
        backupSessions.unshift(doc);
        await saveSessionsFallback();
        return res.json({ success: true, sessionId, session: doc });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').insertOne(doc);
        return res.json({ success: true, sessionId, session: doc });
      }

      backupSessions.unshift(doc);
      await saveSessionsFallback();
      res.json({ success: true, sessionId, session: doc });
    } catch (err) {
      console.error('/api/student/register error:', err);
      res.status(500).json({ error: "Failed to register student" });
    }
  });

  // student sessions (history / dashboard stats)
  app.get('/api/student/sessions', async (req, res) => {
    const usn = req.query.usn;
    if (!usn) return res.status(400).json({ error: 'Missing usn' });

    try {
      if (mongoUnavailable) {
        const filtered = backupSessions.filter(s => s.usn === usn.toUpperCase() && s.status === 'completed');
        filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        return res.json({ sessions: filtered });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const items = await db.collection('interviewsessions')
          .find({ usn: usn.toUpperCase(), status: 'completed' })
          .sort({ completedAt: -1 })
          .toArray();
        return res.json({ sessions: items });
      }

      const filtered = backupSessions.filter(s => s.usn === usn.toUpperCase() && s.status === 'completed');
      filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
      res.json({ sessions: filtered });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // interview start
  app.post('/api/interview/start', async (req, res) => {
    try {
      const { sessionId } = req.body;
      let round = "Technical Round";

      if (sessionId) {
        if (mongoUnavailable) {
          const s = backupSessions.find(x => x.sessionId === sessionId);
          if (s && s.round) round = s.round;
        } else {
          const client = await connectDb();
          if (client) {
            const db = client.db(DB_NAME);
            const s = await db.collection('interviewsessions').findOne({ sessionId });
            if (s && s.round) round = s.round;
          }
        }
      }

      const questions = getQuestionsForRound(round);
      res.json({ question: questions[0], round });
    } catch (err) {
      console.error(err);
      res.json({ question: "Hello! Let's start with your background. Can you tell me about yourself?" });
    }
  });

  // interview answer
  app.post('/api/interview/answer', async (req, res) => {
    try {
      const { sessionId, history } = req.body;
      let round = "Technical Round";

      if (sessionId) {
        if (mongoUnavailable) {
          const s = backupSessions.find(x => x.sessionId === sessionId);
          if (s && s.round) round = s.round;
        } else {
          const client = await connectDb();
          if (client) {
            const db = client.db(DB_NAME);
            const s = await db.collection('interviewsessions').findOne({ sessionId });
            if (s && s.round) round = s.round;
          }
        }
      }

      const questions = getQuestionsForRound(round);
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
        return res.json({ session });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        let session = await db.collection('interviewsessions').findOne({ sessionId });
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date(), updatedAt: new Date() };
          await db.collection('interviewsessions').insertOne(session);
        }
        return res.json({ session });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date(), updatedAt: new Date() };
        backupSessions.unshift(session);
        await saveSessionsFallback();
      }
      res.json({ session });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch session" });
    }
  });

  app.post('/api/interview/sync', async (req, res) => {
    const { sessionId, mode, adminMessage, studentAnswer, status, aiStatus, round } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const updates = {};
    if (mode !== undefined) updates.mode = mode;
    if (adminMessage !== undefined) updates.adminMessage = adminMessage;
    if (studentAnswer !== undefined) updates.studentAnswer = studentAnswer;
    if (status !== undefined) updates.status = status;
    if (aiStatus !== undefined) updates.aiStatus = aiStatus;
    if (round !== undefined) updates.round = round;
    updates.updatedAt = new Date();

    try {
      if (mongoUnavailable) {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date() };
          backupSessions.unshift(session);
        }
        Object.assign(session, updates);
        await saveSessionsFallback();
        return res.json({ success: true, session });
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
        return res.json({ success: true, session: updated });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', status: 'in_progress', aiStatus: 'active', transcript: [], startTime: new Date() };
        backupSessions.unshift(session);
      }
      Object.assign(session, updates);
      await saveSessionsFallback();
      res.json({ success: true, session });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update session" });
    }
  });

  // leaderboard
  app.get('/api/leaderboard', async (req, res) => {
    try {
      if (mongoUnavailable) {
        const filtered = backupSessions.filter(s => s.status === 'completed' && s.score !== undefined);
        filtered.sort((a, b) => b.score - a.score);
        const sliced = filtered.slice(0, 20).map(s => ({
          studentName: s.studentName,
          usn: s.usn,
          college: s.college,
          branch: s.branch,
          score: s.score,
          completedAt: s.completedAt
        }));
        return res.json({ leaderboard: sliced });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const items = await db.collection('interviewsessions')
          .find({ status: 'completed', score: { $exists: true } })
          .sort({ score: -1 })
          .limit(20)
          .project({ studentName: 1, usn: 1, college: 1, branch: 1, score: 1, completedAt: 1 })
          .toArray();
        return res.json({ leaderboard: items });
      }

      const filtered = backupSessions.filter(s => s.status === 'completed' && s.score !== undefined);
      filtered.sort((a, b) => b.score - a.score);
      const sliced = filtered.slice(0, 20).map(s => ({
        studentName: s.studentName,
        usn: s.usn,
        college: s.college,
        branch: s.branch,
        score: s.score,
        completedAt: s.completedAt
      }));
      res.json({ leaderboard: sliced });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // interview complete (Gemini Evaluation)
  app.post('/api/interview/complete', async (req, res) => {
    try {
      const { sessionId, transcript } = req.body;
      if (!sessionId || !Array.isArray(transcript)) {
        return res.status(400).json({ error: 'Missing sessionId or transcript' });
      }

      const transcriptStr = transcript
        .map(m => `${m.role === 'ai' ? 'INTERVIEWER' : m.role === 'student' ? 'CANDIDATE' : 'ADMIN'}: ${m.text}`)
        .join('\n');

      const evaluationPrompt = `You are an expert interview evaluator. Analyze this interview transcript and provide a detailed evaluation.

TRANSCRIPT:
${transcriptStr}

Evaluate the candidate and respond with ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "score": <integer 0-100>,
  "feedback": "<2-3 sentence overall feedback>",
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "improvements": ["<improvement 1>", "<improvement 2>", "<improvement 3>"]
}

Scoring criteria:
- Technical accuracy (40 pts): Correctness and depth of answers
- Communication (30 pts): Clarity, structure, and confidence
- Problem-solving (30 pts): Approach, reasoning, adaptability`;

      let score = 70;
      let feedback = 'Good effort. Keep practicing to improve your interview skills.';
      let strengths = ['Showed willingness to engage', 'Attempted all questions'];
      let improvements = ['Work on technical depth', 'Practice clear explanations'];

      if (process.env.GEMINI_API_KEY) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: evaluationPrompt,
          });

          const raw = (response.text || '').trim();
          const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
          const parsed = JSON.parse(jsonStr);

          score = Math.min(100, Math.max(0, Number(parsed.score) || 70));
          if (parsed.feedback) feedback = parsed.feedback;
          if (Array.isArray(parsed.strengths)) strengths = parsed.strengths.slice(0, 3);
          if (Array.isArray(parsed.improvements)) improvements = parsed.improvements.slice(0, 3);
        } catch (aiErr) {
          console.error('AI evaluation failed, using defaults:', aiErr.message);
        }
      } else {
        console.warn('GEMINI_API_KEY not set. Using fallback scoring.');
      }

      const updateDoc = {
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
        transcript,
        score,
        feedback,
        strengths,
        improvements
      };

      if (mongoUnavailable) {
        let session = backupSessions.find(s => s.sessionId === sessionId);
        if (!session) {
          session = { sessionId, mode: 'ai', startTime: new Date() };
          backupSessions.unshift(session);
        }
        Object.assign(session, updateDoc);
        await saveSessionsFallback();
        return res.json({ success: true, score, feedback, strengths, improvements });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').updateOne(
          { sessionId },
          { $set: updateDoc }
        );
        return res.json({ success: true, score, feedback, strengths, improvements });
      }

      let session = backupSessions.find(s => s.sessionId === sessionId);
      if (!session) {
        session = { sessionId, mode: 'ai', startTime: new Date() };
        backupSessions.unshift(session);
      }
      Object.assign(session, updateDoc);
      await saveSessionsFallback();
      res.json({ success: true, score, feedback, strengths, improvements });
    } catch (err) {
      console.error('Error completing interview:', err);
      res.status(500).json({ error: 'Failed to complete interview' });
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
