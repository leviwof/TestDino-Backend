# TestDino Backend

Express + TypeScript API that generates tailored interview-preparation kits from
a job description and a company URL. It crawls public company pages, extracts role
requirements, and uses an LLM to produce questions, flashcards, and a study
schedule. MongoDB (via Mongoose) is the datastore; auth is JWT-based.

## Requirements

- Node.js >= 20
- MongoDB (local or hosted, e.g. MongoDB Atlas)
- An LLM API key (OpenAI, OpenRouter, or Anthropic) — or `LLM_PROVIDER=mock` for local dev

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

At minimum, set `MONGODB_URI`, `JWT_SECRET`, and your LLM provider/key in `.env`.

## Scripts

| Command            | Description                                        |
| ------------------ | -------------------------------------------------- |
| `npm run dev`      | Start the server in watch mode (tsx)               |
| `npm run build`    | Compile TypeScript to `dist/`                      |
| `npm start`        | Run the compiled server (`node dist/index.js`)     |
| `npm test`         | Run the test suite (vitest)                        |
| `npm run evaluate` | Run the offline evaluation CLI against fixtures    |

## Environment variables

See [.env.example](./.env.example) for the full list. Key ones:

- `PORT` — HTTP port (default `3000`)
- `CORS_ORIGIN` — allowed frontend origin(s); use your deployed frontend URL in production
- `MONGODB_URI` — MongoDB connection string (**required** to boot)
- `JWT_SECRET` — token signing secret, >= 32 chars in production (**required** to boot)
- `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` — LLM configuration

## HTTP API (overview)

All `/kits` routes require a `Bearer` JWT; every kit is scoped to its owner.

- `POST /auth/register`, `POST /auth/login` — authentication
- `GET  /kits` — list the authenticated user's kits
- `POST /kits` — create a kit and enqueue its generation job
- `GET  /kits/:id` — fetch a kit
- `POST /kits/:id/regenerate` — regenerate (preserving edited/pinned items)
- `GET  /kits/:id/practice` — confidence-weighted practice items
- `GET  /jobs/:id` — poll generation job status

## Docker

```bash
docker build -t testdino-backend .
docker run --rm -p 3000:3000 --env-file .env testdino-backend
```

## Deploy

1. Provision a MongoDB instance (e.g. MongoDB Atlas) and copy its connection string.
2. Set the production env vars (`MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGIN`, LLM keys).
3. Build and run: `npm ci && npm run build && npm start`, or deploy the Docker image.
4. Point the frontend's `NEXT_PUBLIC_API_BASE_URL` at this service's public URL.
