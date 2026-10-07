# server

Express 5 + Prisma 7 API for erd-designer: accounts, sessions and several saved ERDs per user.

```bash
cp .env.example .env          # set DATABASE_URL
npm run db:deploy             # apply migrations
npm run dev                   # http://127.0.0.1:3001 (watch mode)
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/signup` | `{ email, password (8-128), name? }` → 201 + session cookie |
| POST | `/api/auth/login` | `{ email, password }` → 200 + session cookie |
| POST | `/api/auth/logout` | 204, ends the session |
| GET | `/api/auth/me` | `{ user }` or `{ user: null }` |
| GET | `/api/diagrams` | the signed-in user's ERDs: `{ diagrams: [{ id, title, updatedAt }] }`, oldest first (no content) |
| POST | `/api/diagrams` | `{ title?, data? }` → 201 `{ diagram }`; blank and "Untitled diagram" by default; max 50 per user (409 beyond) |
| GET | `/api/diagrams/:id` | one ERD with its content: `{ diagram: { id, title, updatedAt, data } }` |
| PUT | `/api/diagrams/:id` | `{ title?, data? }` (at least one): rename and/or save the validated workspace |
| DELETE | `/api/diagrams/:id` | 204 |
| GET | `/api/health` | `{ ok: true }` (no database access) |

Errors are `{ error, field? }`; limits return `429` with `RateLimit-*` headers.

## Layout

```
src/
  app.ts            Express app factory (middleware order, error handler)
  config.ts         Validated environment
  db.ts             Prisma client (pg driver adapter)
  schemas.ts        Zod schemas for every request body
  auth/             Password hashing (scrypt) and session cookies
  middleware/       Origin (CSRF) check, session loader, requireAuth
  routes/           auth.ts, diagrams.ts
  security/         Rate limiters + the PostgreSQL-backed store they share
  vercel.ts         Serverless entry
prisma/             schema.prisma + migrations
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string (use a pooled URL on serverless) |
| `PORT` | `3001` | Local listen port |
| `NODE_ENV` | `development` | `production` enables `Secure` / `__Host-` cookies |
| `ALLOWED_ORIGINS` | localhost dev origins | Extra origins allowed to make cookie writes (own origin is always allowed) |
| `TRUST_PROXY` | `0` | `1` behind a reverse proxy (automatic on Vercel) |

`npm test` needs `TEST_DATABASE_URL`; see the root README.
