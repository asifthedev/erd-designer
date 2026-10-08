# server

Express 5 + Prisma 7 API for erd-designer: accounts, sessions and saved ERDs (the Free plan includes one per account; see below).

```bash
cp .env.example .env          # set DATABASE_URL
npm run db:deploy             # apply migrations
npm run dev                   # http://127.0.0.1:3001 (watch mode)
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/signup/code` | `{ email }` → emails a 6-digit code (200 for any address; 429 `retryAfter` within 60 s of the last one) |
| POST | `/api/auth/signup` | `{ email, password (8-128), code, name? }` → 201 + session cookie. **No valid code, no account.** |
| POST | `/api/auth/password/forgot` | `{ email }` → emails a reset code to registered addresses; the answer is the same for everyone else |
| POST | `/api/auth/password/verify` | `{ email, code }` → 200 when the reset code is right (changes nothing; a right code keeps its guesses) so the form can ask for the new password on the next page |
| POST | `/api/auth/password/reset` | `{ email, code, password }` → 200; sets the new password and ends every session (no auto log-in) |
| POST | `/api/auth/login` | `{ email, password }` → 200 + session cookie |
| POST | `/api/auth/logout` | 204, ends the session |
| GET | `/api/auth/me` | `{ user }` or `{ user: null }` |
| GET | `/api/diagrams` | the signed-in user's ERDs: `{ diagrams: [{ id, title, updatedAt }] }`, oldest first (no content) |
| POST | `/api/diagrams` | `{ title?, data? }` → 201 `{ diagram }`; blank and "Untitled diagram" by default. Over the plan's limit → 403 `{ error, code: "plan_limit" }` (Free plan: 1 diagram, set by `FREE_PLAN_MAX_DIAGRAMS`); hard cap 50 per user (409) |
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
| `SMTP_URL` | none | SMTP connection URL for the emails, e.g. `smtps://user:password@smtp.example.com:465` |
| `MAIL_FROM` | none | From header, e.g. `erd.designer <no-reply@example.com>` |

### Email codes

Creating an account and resetting a password both need a 6-digit code emailed to the address.

- A code lives **10 minutes**, allows **5 guesses**, and is single-use. Only a salted hash is stored (`erd_email_codes`).
- A new code can be requested every **60 s**, at most **5 an hour per address** and **10 an hour per network**.
- Whether an address already has an account is **never revealed**: requests answer identically (and take at
  least `CODE_REQUEST_MIN_MS`, default 900 ms). A registered address that starts signing up gets an email saying
  so instead of a code; an unknown address asking to reset a password gets nothing.
- Without `SMTP_URL` + `MAIL_FROM`, **production sends nothing and answers 503**: sign-ups and resets are
  unavailable until email is configured. In development the email (code included) is printed to the server console.

`npm test` needs `TEST_DATABASE_URL`; see the root README.
