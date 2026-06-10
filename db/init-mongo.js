// db/init-mongo.js
// Run: MONGO_URI=mongodb://localhost:27017 node db/init-mongo.js

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

    console.log('Collections ensured: users, interviews, sessions, entrances');

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

    console.log(`Database "${DB_NAME}" initialized successfully.`);
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

run();
