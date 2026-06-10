# AI Interview App

## Overview
This project includes:
- `admin.html`: admin portal connected to MongoDB
- `server/index.js`: Express backend for storing entrance data and serving static pages
- `docker-compose.yml`: MongoDB service definition
- `db/init-mongo.js`: MongoDB initialization script

## Setup
1. Install dependencies:

```bash
cd "c:\Users\karth\Desktop\2 ai mock"
npm install
```

2. Start MongoDB and the app with Docker:

```bash
docker compose up -d --build
```

This starts:
- MongoDB on `localhost:27017`
- the app server on `localhost:3000`

3. Initialize the database inside the app container:

```bash
docker compose exec app npm run init-db
```

4. Open the admin portal in your browser:
- Admin page: `http://localhost:3000/admin.html`

```bash
npm run init-db
```

4. Start the backend server:

```bash
npm start
```

5. Open the admin portal:
- Admin page: `http://localhost:3000/admin.html`

## Notes
- The admin portal loads saved candidate entries from `/api/entrances`.
- Selecting `See` opens the Admin Control Room within the admin portal to monitor the live preview and draft sync for that candidate.
