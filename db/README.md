MongoDB setup for the AI Interview app

1) Start MongoDB via Docker (recommended):

   docker compose up -d

2) Install Node dependencies (from project root):

   npm install

3) Initialize DB (creates collections and sample doc):

   npm run init-db

4) Run the example server:

   npm start

Endpoints:
- POST /enter  -> body: { name?, branch, field }
- GET /api/entrances -> list saved entries

Notes:
- The init script reads `MONGO_URI` env var or defaults to `mongodb://localhost:27017`.
- MongoDB must be running before starting the server.
- Recommended: start using Docker Compose (`docker compose up -d`) or install MongoDB locally.
- If Docker is unavailable, install MongoDB Community Server and run `mongod` on port 27017.
