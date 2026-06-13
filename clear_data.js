const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://achark659_db_user:Xxol6UxZQILSZtrQ@cluster0.upn6f4k.mongodb.net/?appName=Cluster0';
const DB_NAME = 'ai_interview';

async function clearData() {
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const result = await db.collection('interviewsessions').deleteMany({});
    console.log(`Deleted ${result.deletedCount} sessions from MongoDB.`);
  } catch (err) {
    console.error('Error clearing MongoDB:', err.message);
  } finally {
    await client.close();
  }

  const fallbackPath = path.join(__dirname, 'db', 'fallback-sessions.json');
  try {
    fs.writeFileSync(fallbackPath, '[]', 'utf8');
    console.log('Cleared fallback-sessions.json.');
  } catch (err) {
    console.error('Error clearing fallback-sessions.json:', err.message);
  }
}

clearData();
