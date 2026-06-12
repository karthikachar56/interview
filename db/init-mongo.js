// db/init-mongo.js
// Run: MONGO_URI=mongodb://localhost:27017 node db/init-mongo.js

const path = require('path');
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'ai_interview';

async function run() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db(DB_NAME);

    // Create collections
    const collections = await db.listCollections().toArray();
    const names = collections.map(c => c.name);

    if (!names.includes('users')) await db.createCollection('users');
    if (!names.includes('interviews')) await db.createCollection('interviews');
    if (!names.includes('sessions')) await db.createCollection('sessions');
    if (!names.includes('entrances')) await db.createCollection('entrances');
    if (!names.includes('interviewsessions')) await db.createCollection('interviewsessions');
    if (!names.includes('interviewquestions')) await db.createCollection('interviewquestions');

    console.log('Collections ensured: users, interviews, sessions, entrances, interviewsessions, interviewquestions');

    // Indexes
    await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
    await db.collection('interviews').createIndex({ interviewerId: 1 });
    await db.collection('sessions').createIndex({ interviewId: 1 });
    await db.collection('entrances').createIndex({ branch: 1, field: 1 });

    console.log('Indexes created');

    // Insert sample document into entrances (optional)
    const sample = { branch: 'Computer Science', field: 'Frontend Development', createdAt: new Date() };
    await db.collection('entrances').insertOne(sample);
    console.log('Inserted sample entrance document');

    // Seed interview questions
    const fs = require('fs');
    const path = require('path');
    const questionsCount = await db.collection('interviewquestions').countDocuments();
    if (questionsCount === 0) {
      try {
        const questionsPath = path.join(__dirname, 'fallback-questions.json');
        const questionsData = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
        const seedDoc = { _id: 'global_questions', ...questionsData };
        await db.collection('interviewquestions').insertOne(seedDoc);
        console.log('Seeded interview questions into the database');
      } catch (e) {
        console.error('Failed to seed questions:', e);
      }
    }

    console.log(`Database "${DB_NAME}" initialized successfully.`);
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

run();
