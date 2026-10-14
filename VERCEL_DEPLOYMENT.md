# Vercel deployment

This repository deploys one Vercel project with three services (Services is beta).
Set the Vercel Root Directory to the repository root containing `vercel.json`.
Use Node.js 22. Do not set top-level build overrides.

## Routes and binding

- `client`: Vite static frontend, public catch-all `/`; SPA page links resolve to `index.html`; asset paths and Vite development paths bypass the fallback.
- `backend`: Express gateway, public `/api`, `/api/*`, and `/uploads/*`.
- `server`: complete application API backed by MySQL, internal only.
- `backend` calls `server` using the runtime `SERVER_INTERNAL_URL` binding.
  Vercel injects this value. Do not configure it as an environment variable.
- The gateway preserves `/api` and `/uploads` paths, cookies, CSRF headers,
  multipart uploads and SSE streams. The frontend only calls public `/api`.
- `backend/server.js` and its scripts remain legacy utilities. Deployments use
  `backend/index.mjs` so the full client API is available through the gateway.

## Environment

Configure these in Vercel for Preview and Production:

- `DATABASE_URL`: MySQL connection URL, with a database name.
- `JWT_SECRET`: a private random signing secret of at least 16 characters.
- `NODE_ENV=production`.
- `REALTIME_TRANSPORT=sse` (Vercel Functions do not host WebSocket servers).
- `REALTIME_REDIS_URL`: Redis URL for events between function instances.
- `VITE_API_URL=/api` (public frontend setting, not a binding).
- `CORS_ORIGIN`: allowed additional browser origins if needed. Same-origin
  requests through the gateway are supported automatically.

Keep `COOKIE_DOMAIN` unset and `COOKIE_SAMESITE=lax` for same-domain hosting.
Existing root/server `.env` files use MySQL and must be updated for local MySQL
work; they are excluded from Git. Do not use sample credentials in production.

## Prepare the database

With the intended MySQL URL configured, run:

```sh
npm install
npm run prisma:generate
npm run prisma:deploy -w server
```

This creates MySQL indexes and partial unique indexes for assigned admin and
employee codes. Run it separately from builds; builds do not migrate databases.
For an existing database, follow `database/README.md` before deploying migrations.
Provision an administrator in the new `User` table before using the app.
Set `ADMIN_EMAIL` and a private `ADMIN_PASSWORD` (12 or more characters) in your
local shell, then run `npm run admin:provision -w server`. Optional settings are
`ADMIN_NAME` and `ADMIN_CODE`. The command leaves existing credentials untouched.
These one-time provisioning variables do not need to be set in Vercel.
The optional seed command deletes records and is only for a disposable database.

New venture uploads persist in MySQL and are served at `/uploads/assets/:id`.
Each file is capped at 4 MiB to leave room under Vercel's 4.5 MB request limit.
Historical filesystem uploads require a separate import.
OTP challenges persist in MySQL so verification works across instances.

## Local verification

Install the Vercel CLI, configure local MySQL and environment variables, and
set `VITE_API_URL=/api`. Then run from this root:

```sh
vercel dev -L
```

Vercel starts all services and injects the binding. Check `/api/health`, login,
`/api/auth/me`, venture creation, uploads and `/api/stream` through the same host.
A request to a frontend deep link must return the SPA. `/api/unknown` must return
an API 404 rather than `index.html`. Only backend and client receive public traffic.

For the isolated integration test, use a MySQL database whose name ends
in `_test`, run migration setup, and start `vercel dev -L` with the same URL:

```sh
TEST_BASE_URL=http://localhost:3000 node server/tests/mysql-vercel.integration.mjs
```

The integration test refuses non-test databases and creates only test records.
