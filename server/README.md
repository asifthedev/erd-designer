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
| POST | `/api/diagrams` | `{ title?, data? }` → 201 `{ diagram }`; blank and "Untitled diagram" by default. Over the plan's limit → 403 `{ error, code: "plan_limit" }` (the plan's `maxDiagrams`, Free: 1); a plan's `maxTablesPerDiagram` is enforced on save too (403 `plan_limit_tables`); hard cap 50 per user (409) |
| GET | `/api/diagrams/:id` | one ERD with its content: `{ diagram: { id, title, updatedAt, data } }` |
| PUT | `/api/diagrams/:id` | `{ title?, data? }` (at least one): rename and/or save the validated workspace |
| DELETE | `/api/diagrams/:id` | 204 |
| GET | `/api/plans` | public: the plans on offer (prices, limits, features, highlight lines) |
| GET | `/api/plans/mine` | the signed-in user's plan now: `{ plan: { ..., expiresAt } }` |
| GET / POST | `/api/orders` | list the user's orders and the payment instructions / place an order `{ planId, contact? }` (asking again for a plan with an open order returns it) |
| GET | `/api/ai/models` | the AI models this account may use (Free: only the cheap tier; the rest listed as `locked`), the default one, and today's `quota` |
| POST | `/api/ai/chat` | `{ model?, canvas, messages }` → a **server-sent event stream** of ONE model call: `model`, `text`, `tool_call`, `done`, `error`. Stateless: the web app runs the tool calls on the canvas and calls again with the results. 429 `daily_limit`, 403 `model_locked`, 503 `capacity` / `not_configured` |
| PUT / POST | `/api/orders/:id`, `/api/orders/:id/cancel` | add the payment reference, or cancel a pending order |
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
| `ADMIN_EMAIL` | none | The admin panel's login email. Without it and `ADMIN_PASSWORD_HASH`, `/admin` answers "not set up" (503) |
| `ADMIN_PASSWORD_HASH` | none | scrypt hash of the admin password: run `npm run admin:hash -w server` (the password is never stored). Single-quote it in a `.env`, it contains `$` |
### AI assistant

One gateway key reaches models from many companies. Any OpenAI-compatible gateway works (OpenRouter by default, the Vercel AI Gateway, LiteLLM...). Nothing else changes without a key.

**Everything is set in the admin panel (`/admin` > AI)**: the on/off switch, the gateway address and key (stored encrypted in the database, never shown again), the models people can pick (search the gateway's list, mark cheap ones `Fast`, choose the default, and press *Try it* to check a model really calls tools), the daily limits, the spend cap, and the usage of the last 7 days. The variables below are only a **fallback** for a field left empty in the panel. Secrets are encrypted with `APP_SECRET` (or, when it is not set, a key derived from `DATABASE_URL`); changing it means pasting the key again in the panel.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_SECRET` | from `DATABASE_URL` | Encrypts the keys saved in the admin panel |
| `AI_GATEWAY_API_KEY` | none | The gateway key. Without it (and without `ANTHROPIC_API_KEY`) the assistant answers "not set up". |
| `AI_GATEWAY_BASE_URL` | `https://openrouter.ai/api/v1` | e.g. `https://ai-gateway.vercel.sh/v1` for the Vercel AI Gateway |
| `AI_MODELS` | built-in list | Models people can pick, comma separated, as `company/model`; add `\|fast` to mark a cheap one (the **only** kind the Free plan may use). `*` offers every model the gateway lists that can call tools. Models the gateway does not have, or that cannot call tools, are dropped on their own. |
| `AI_DEFAULT_MODEL` | first one | Preselected model |
| `ANTHROPIC_API_KEY` | none | Optional direct route to Anthropic (adds "(direct)" models, with prompt caching) |
| `AI_DAILY_LIMIT_FREE` / `AI_DAILY_LIMIT_PAID` | `30` / `500` | Model calls per account per UTC day (a change to the canvas takes a few calls) |
| `AI_MAX_DAILY_SPEND_USD` | none | Stops the assistant for everybody for the rest of the day once the gateway reported this much spend (OpenRouter reports cost per call) |
| `AI_REQUEST_TIMEOUT_MS` | `50000` | Time limit for one answer; keep it below the function's `maxDuration` (60 s in `vercel.json`) |

How it is built (`src/ai`): `catalog.ts` lists models and checks the gateway's live list for tool support; `router.ts` retries a blip once, fails over to another company's model before the first word is shown, and opens a circuit breaker on a model that keeps failing; `openaiCompat.ts` / `anthropic.ts` are the two wire formats; `usage.ts` keeps the daily count in Postgres (reserved atomically, handed back when a model fails before answering). The tools the model may call are defined once in `shared/aiToolSpecs.ts` and run by the web app on the canvas, so unsaved canvases work and the server never edits diagrams behind the person's back. Provider error text is never sent to the browser.


### Plans, orders and the admin panel

- **Plans** live in `erd_plans` (seeded by the migration: Free 1 diagram / 25 tables, Pro monthly 5 / 100, Lifetime) and are edited in the admin panel: name, price, currency, limits (hard caps 50 diagrams / 300 tables), the feature switches (`export`, `codeFormats`, `themes`, `localCopy`, `setup`) and the card text. Limits are enforced by the API; the paid features are gated in the web UI only.
- **Orders** are manual: no payment gateway. A buyer places an order (the price is copied onto it), pays as the admin's payment instructions say, and the admin marks it paid. That starts the plan in one transaction: a monthly plan adds a calendar month (renewing early extends from the current end), a lifetime plan never ends. A lapsed monthly plan counts as Free.
- **Admin** (`/admin`, API `/api/admin/*`): its own login and cookie (`__Host-erd_admin` in production), 12 h sessions, strict rate limits, one error message for a wrong email or password. It shows the numbers, edits plans and prices, lists the registered users (and can put one on a plan by hand), confirms or cancels orders, and edits the payment instructions.

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
