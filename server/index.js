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

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb+srv://achark659_db_user:Xxol6UxZQILSZtrQ@cluster0.upn6f4k.mongodb.net/?appName=Cluster0';
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

async function get10RandomQuestionsForRound(round) {
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

  // Try exact match or normalized match
  let poolKey = Object.keys(questionsObj).find(k => k.toLowerCase().replace(/\s+/g, '') === normalizedRound.toLowerCase().replace(/\s+/g, ''));
  if (!poolKey || poolKey === '_id') poolKey = Object.keys(questionsObj).find(k => k !== '_id');

  const pool = questionsObj[poolKey] || [];
  if (pool.length === 0) return ["Can you tell me about yourself?", "What is your biggest achievement?", "What is your greatest strength?"];
  
  const shuffled = shuffleArray([...pool]);
  
  if (normalizedRound.toLowerCase().includes('basic introduction')) {
    const forcedQuestion = "Can you tell me about yourself?";
    const filtered = shuffled.filter(q => q.toLowerCase() !== forcedQuestion.toLowerCase());
    return [forcedQuestion, ...filtered].slice(0, 10);
  }

  return shuffled.slice(0, 10);
}

function getAdminAuth(req) {
  const rc = req.headers.cookie;
  if (!rc) return false;
  const list = {};
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list['admin_auth'] === 'authenticated';
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
  let defaultMetrics = { confidence: 6, vocabulary: 6, answering: 6, nervousness: 6, faceExpression: 6, questionUnderstand: 6, answerScore: 6 };
  let result = {
    correctedText: rawAnswer,
    metrics: defaultMetrics
  };

  if (!process.env.GEMINI_API_KEY || !rawAnswer || rawAnswer.trim().length === 0) {
    return result;
  }

  const prompt = `You are an expert interview evaluator and speech-to-text transcription corrector.
Analyze this candidate response to the interview question.

Context:
Interviewer Asked: "${questionAsked}"
Raw Transcription: "${rawAnswer}"

Tasks:
1. Correct obvious garbled/misheard words in the Raw Transcription. Make the text readable, correct words that sound similar but make no sense in context, and fix minor grammar errors. Keep the candidate's original meaning and style intact.
2. Evaluate the candidate's performance on a scale of 0 to 10 for the following metrics:
   "confidence", "vocabulary", "answering", "nervousness", "faceExpression", "questionUnderstand", "answerScore".
   Note: "answerScore" measures the correctness of the answer to the question (10=perfect, 5=partial/half-correct, 0=wrong or no real answer).

Respond ONLY with a valid JSON object in this exact format (no markdown blocks, no wrappers):
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
      const getMetric = (val) => (val === undefined || val === null || isNaN(Number(val))) ? 6 : Number(val);
      result.metrics = {
        confidence: Math.min(10, Math.max(0, getMetric(parsed.metrics.confidence))),
        vocabulary: Math.min(10, Math.max(0, getMetric(parsed.metrics.vocabulary))),
        answering: Math.min(10, Math.max(0, getMetric(parsed.metrics.answering))),
        nervousness: Math.min(10, Math.max(0, getMetric(parsed.metrics.nervousness))),
        faceExpression: Math.min(10, Math.max(0, getMetric(parsed.metrics.faceExpression))),
        questionUnderstand: Math.min(10, Math.max(0, getMetric(parsed.metrics.questionUnderstand))),
        answerScore: Math.min(10, Math.max(0, getMetric(parsed.metrics.answerScore)))
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

    // Try to load the latest vallyMetricsHistory from the DB/fallback if possible
    try {
      if (mongoUnavailable) {
        const s = backupSessions.find(x => x.sessionId === sessionId);
        if (s && s.vallyMetricsHistory && s.vallyMetricsHistory.length > historyForScore.length) {
          historyForScore = s.vallyMetricsHistory;
        }
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          const s = await db.collection('interviewsessions').findOne({ sessionId });
          if (s && s.vallyMetricsHistory && s.vallyMetricsHistory.length > historyForScore.length) {
            historyForScore = s.vallyMetricsHistory;
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

    if (!hasStudentAnswers) {
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
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    if (password !== adminPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    res.setHeader('Set-Cookie', 'admin_auth=authenticated; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800');
    res.json({ success: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'admin_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  app.get('/api/admin/sessions', async (req, res) => {
    if (!getAdminAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      if (mongoUnavailable) {
        return res.json({ sessions: backupSessions });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const sessions = await db.collection('interviewsessions').find().sort({ updatedAt: -1 }).toArray();
        return res.json({ sessions });
      }

      res.json({ sessions: backupSessions });
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
  app.post('/api/student/register', async (req, res) => {
    const { studentName, srn, usn, college, branch, year, password } = req.body;
    const finalSrn = (srn || usn || '').trim().toUpperCase();
    if (!studentName || !finalSrn) {
      return res.status(400).json({ error: "Missing required fields" });
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
      college: (college || '').trim(),
      branch: (branch || '').trim(),
      year: year || '4th Year',
      password: password || null,
      status: 'in_progress',
      aiStatus: 'active',
      startTime: new Date(),
      updatedAt: new Date(),
      transcript: []
    };

    try {
      let existingSession = null;
      if (mongoUnavailable) {
        existingSession = backupSessions.find(s => (s.srn === finalSrn || s.usn === finalSrn) && s.password);
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          existingSession = await db.collection('interviewsessions').findOne(
            { $or: [{ srn: finalSrn }, { usn: finalSrn }], password: { $ne: null } },
            { sort: { startTime: -1 } }
          );
        }
      }

      if (existingSession && existingSession.password) {
        if (!password || existingSession.password !== password) {
          return res.status(400).json({ error: "This SRN is already registered. Please log in instead." });
        }
      }

      if (mongoUnavailable) {
        backupSessions = backupSessions.filter(s => s.sessionId !== sessionId);
        backupSessions.unshift(doc);
        await saveSessionsFallback();
        return res.json({ success: true, sessionId, session: doc });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        await db.collection('interviewsessions').replaceOne(
          { sessionId },
          doc,
          { upsert: true }
        );
        return res.json({ success: true, sessionId, session: doc });
      }

      backupSessions = backupSessions.filter(s => s.sessionId !== sessionId);
      backupSessions.unshift(doc);
      await saveSessionsFallback();
      res.json({ success: true, sessionId, session: doc });
    } catch (err) {
      console.error('/api/student/register error:', err);
      res.status(500).json({ error: "Failed to register student" });
    }
  });

  // student login lookup by SRN and Password
  app.post('/api/student/login', async (req, res) => {
    const { srn, password } = req.body;
    const finalSrn = (srn || '').trim().toUpperCase();
    if (!finalSrn) return res.status(400).json({ error: "SRN is required for login" });

    try {
      if (mongoUnavailable) {
        const session = backupSessions.find(s => (s.srn === finalSrn || s.usn === finalSrn) && s.studentName);
        if (!session) {
          return res.status(404).json({ error: "No profile found for this SRN. Please register first." });
        }
        if (session.password && session.password !== password) {
          return res.status(401).json({ error: "Incorrect password for this SRN." });
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
        if (session.password && session.password !== password) {
          return res.status(401).json({ error: "Incorrect password for this SRN." });
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
      if (session.password && session.password !== password) {
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
    const finalSrn = (srn || '').trim().toUpperCase();
    if (!finalSrn) return res.status(400).json({ error: "Missing srn" });

    try {
      let exists = false;
      if (mongoUnavailable) {
        exists = backupSessions.some(s => (s.srn === finalSrn || s.usn === finalSrn) && s.password);
      } else {
        const client = await connectDb();
        if (client) {
          const db = client.db(DB_NAME);
          const count = await db.collection('interviewsessions').countDocuments({
            $or: [{ srn: finalSrn }, { usn: finalSrn }],
            password: { $ne: null }
          });
          exists = count > 0;
        }
      }
      res.json({ exists });
    } catch (err) {
      console.error('/api/student/check-srn error:', err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // student sessions (history / dashboard stats)
  app.get('/api/student/sessions', async (req, res) => {
    const srn = req.query.srn || req.query.usn;
    if (!srn) return res.status(400).json({ error: 'Missing srn' });

    try {
      if (mongoUnavailable) {
        const filtered = backupSessions.filter(s => ((s.srn && s.srn === srn.toUpperCase()) || (s.usn && s.usn === srn.toUpperCase())) && s.status === 'completed');
        filtered.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        return res.json({ sessions: filtered });
      }

      const client = await connectDb();
      if (client) {
        const db = client.db(DB_NAME);
        const items = await db.collection('interviewsessions')
          .find({
            $or: [
              { srn: srn.toUpperCase() },
              { usn: srn.toUpperCase() }
            ],
            status: 'completed'
          })
          .sort({ completedAt: -1 })
          .toArray();
        const mapped = items.map(s => ({ ...s, srn: s.srn || s.usn }));
        return res.json({ sessions: mapped });
      }

      const filtered = backupSessions.filter(s => ((s.srn && s.srn === srn.toUpperCase()) || (s.usn && s.usn === srn.toUpperCase())) && s.status === 'completed');
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

      const questions = await get10RandomQuestionsForRound(round);
      
      // Save selected questions to the session
      if (sessionId) {
        if (mongoUnavailable) {
          const s = backupSessions.find(x => x.sessionId === sessionId);
          if (s) {
            s.selectedQuestions = questions;
            await saveSessionsFallback();
          }
        } else {
          const client = await connectDb();
          if (client) {
            const db = client.db(DB_NAME);
            await db.collection('interviewsessions').updateOne({ sessionId }, { $set: { selectedQuestions: questions } });
          }
        }
      }

      res.json({ question: questions[0], round, selectedQuestions: questions });
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
      let questions = selectedQuestions;

      if (!questions || questions.length === 0) {
        if (sessionId) {
          if (mongoUnavailable) {
            const s = backupSessions.find(x => x.sessionId === sessionId);
            if (s && s.round) round = s.round;
            if (s && s.selectedQuestions) questions = s.selectedQuestions;
          } else {
            const client = await connectDb();
            if (client) {
              const db = client.db(DB_NAME);
              const s = await db.collection('interviewsessions').findOne({ sessionId });
              if (s && s.round) round = s.round;
              if (s && s.selectedQuestions) questions = s.selectedQuestions;
            }
          }
        }
      }

      if (!questions || questions.length === 0) {
        questions = await get10RandomQuestionsForRound(round);
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
    const { sessionId, mode, adminMessage, studentAnswer, status, aiStatus, round, score } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

    const updates = {};
    if (mode !== undefined) updates.mode = mode;
    if (adminMessage !== undefined) updates.adminMessage = adminMessage;
    if (studentAnswer !== undefined) updates.studentAnswer = studentAnswer;
    if (status !== undefined) {
      updates.status = status;
      if (status === 'completed') {
        updates.aiStatus = 'completed';
      }
    }
    if (aiStatus !== undefined) updates.aiStatus = aiStatus;
    if (round !== undefined) updates.round = round;
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
