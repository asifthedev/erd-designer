# erd-designer

A visual database designer. Drag tables onto a canvas, draw relations, and get a **Prisma schema**, a **Drizzle ORM
schema** and **SQL** (PostgreSQL / MySQL / SQLite) generated live. Sign in to keep **several ERDs** in your account (listed in a collapsible
left sidebar) and open them on any device.

## Repository layout

| Path | What it is |
| --- | --- |
| [`web/`](web) | React 19 + Vite + Tailwind 4 + React Flow single-page app (state in Zustand). |
| [`server/`](server) | Express 5 + Prisma 7 + PostgreSQL API: accounts, sessions, saved diagram. |
| [`api/`](api) | Vercel serverless entry that wraps the Express app (bundled by `scripts/build-api.mjs`). |
| [`vercel.json`](vercel.json) | Build, routing and security-header config for Vercel. |
| [`docs/`](docs) | Design reference. |

The browser talks to the API on the **same origin** (`/api/*`), so the session cookie is first-party and
no CORS is needed.

## Run locally

Requirements: Node 22+, a PostgreSQL database (local, Neon, Prisma Postgres, ...).

```bash
npm install
cp server/.env.example server/.env      # put your PostgreSQL URL in DATABASE_URL
npm run db:deploy                        # creates the tables
npm run dev                              # API on :3001, web on http://localhost:5173
```

## Quality checks

```bash
npm run check          # lint + typecheck + all tests
```

The API's integration tests run against a **real PostgreSQL** (never your real data):

```bash
docker run -d --rm --name erd-test-db -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=erd_test postgres:16-alpine
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/erd_test
DATABASE_URL=$TEST_DATABASE_URL npm run db:deploy
npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) does exactly this on every push and pull request.

## Deploy to Vercel

1. Import the repository in Vercel (root directory = repo root; `vercel.json` sets everything else).
2. Add the environment variable `DATABASE_URL` (a pooled PostgreSQL URL, e.g. Neon / Prisma Postgres) and
   `NODE_ENV=production`.
3. Deploy. The build applies database migrations (`prisma migrate deploy`), builds the web app, and bundles the API.

## Security model

- **Passwords**: scrypt (N=2^15, r=8, p=1) with a random salt, constant-time comparison; unknown emails cost the
  same time as wrong passwords (no user enumeration through timing).
- **Sessions**: 256-bit random token in an `HttpOnly`, `SameSite=Lax`, `Secure`, `__Host-` prefixed cookie. Only a
  SHA-256 of the token is stored, so a leaked database can't be replayed. 30-day expiry, max 10 devices per user.
- **CSRF**: cross-site writes are rejected by an `Origin` check on top of `SameSite=Lax`.
- **Rate limiting** (shared across serverless instances through PostgreSQL):
  sign-ups 5/hour/IP (successful ones count, so bots can't farm accounts); failed logins 15 per 15 min per IP
  *and* 20 per 15 min per account (stops one-IP brute force and distributed attacks on one victim);
  saves 60/min/user; new diagrams 30 per 10 min/user (and 50 per account); coarse 300 req/min/IP for everything else.
- **Input limits**: strict Zod validation everywhere, 16 KB body cap on auth endpoints, 2 MB on authenticated saves
  (the body is only read after authentication). All queries go through Prisma (parameterised).
- **Headers**: `helmet` on the API; HSTS, CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` on the site (see `vercel.json`).
- **Secrets**: only `*.example` env files are tracked; `.env*` is git-ignored.
- Volumetric DDoS is absorbed by the hosting platform's network protection; the app-level limits above are the
  second line of defence.

Known trade-offs: sign-up reveals whether an email is already registered (it is rate limited, and the alternative
needs email verification); the per-account login limit means an attacker can briefly slow down a victim's login,
which is the usual price of protecting against distributed guessing.

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.
