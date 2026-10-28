# mybusiness-backend

Hono on Node 22, TypeScript, supabase-js, `@google/genai`.

```
src/
├── index.ts               boot: quota counters, catalogue + knowledge into memory, scheduler, server
├── app.ts                 middleware, routes, error handling (no CORS: only the frontend server calls this)
├── pkg/                   env (Zod-validated), Supabase service client, Gemini client
├── shared/                logger, AppError, rate limiter, client IP, crypto/vector/async utils, locale
├── jobs/                  fx | sync | enrich | knowledge | cleanup | all  (HTTP, CLI, in-process scheduler)
└── modules/
    ├── ai/                model per task + fallback chains, quota tracking, gateway (JSON, stream, embed)
    ├── fx/                National Bank of Georgia exchange rates
    ├── listings/          mybusiness.ge API → listings table (content hash decides re-enrichment)
    ├── enrichment/        Gemini extraction of structured facts per listing (+ rules for land)
    ├── catalog/           in-memory enriched catalogue, price stats, labels (ka/en/ru)
    ├── knowledge/         backend/knowledge/*.md → chunks + embeddings → retrieval
    └── chat/
        ├── chat.routes.ts         sessions, history, messages (SSE), feedback
        ├── chat.orchestrator.ts   one turn: route → profile → plan → tools → stream → validate → save
        ├── router/                flash-lite intent + profile extraction
        ├── profile/               buyer profile (known vs inferred), merge, track
        ├── planner/               question bank, next-question selection, readiness, budget reality check
        ├── tools/                 search + scoring, facts, compare table, market stats, cards
        ├── responder/             system prompt per mode
        ├── validator/             guarantee language, unknown numbers
        └── templates/             zero-call replies and labels in three languages
```

## Models (Gemini free tier)

| Task | Models (fallback order) |
|---|---|
| Router | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` |
| Responder | `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview` |
| Enrichment | `gemini-3.8-flash` → `gemini-3.6-flash` |
| Embeddings | `gemini-embedding-2` (768 dims) |

Free-tier prompts may be used by Google to improve its products; do not send personal data, and move to a paid tier for production.

## API

| Method | Path | Auth |
|---|---|---|
| POST | `/chat/sessions` | — (rate-limited per IP) → `{ token }` |
| GET | `/chat/session` | Bearer session token |
| DELETE | `/chat/session` | Bearer session token |
| POST | `/chat/messages` | Bearer session token → SSE: `meta`, `listings`, `compare`, `token`, `quick_replies`, `profile`, `done`, `error` |
| POST | `/chat/feedback` | Bearer session token |
| POST | `/jobs/:name` | Bearer `JOBS_SECRET` |
| GET | `/jobs/quota` | Bearer `JOBS_SECRET` |
| GET | `/health` | — |
