# Agrismart API (backend)

The Express 5 + TypeScript API behind the Agrismart storefront. It reads the catalogue and prices
from ERPNext, stores customer accounts, order requests and inquiries in MongoDB, and sends
inquiries to ERPNext as Leads. The storefront is a separate repository (`agrismart-frontend`) and
reaches this API only through its Vercel `/api/*` rewrite. See [SECURITY.md](SECURITY.md).

| | |
|---|---|
| Runtime | Node.js 22 (`.node-version`), Express 5, Zod, Mongoose 9, pino |
| Data | MongoDB (Atlas in hosting), ERPNext REST API (server-side only) |
| Hosting | Render web service (`render.yaml`) |

## Run locally

```bash
npm ci
npm run dev:mock     # API on :4000 with in-memory MongoDB + mock ERPNext, no .env needed
```

To run against your own MongoDB and an ERPNext **test** site, copy `.env.example` to `.env`, fill
it in, and run `npm run dev`. The `.env` file is git-ignored. Never commit it.

Low disk space on the TEMP drive breaks the in-memory MongoDB (it needs about 500 MB). Point
`TEMP`/`TMP` at a drive with space.

## Quality checks

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm audit --omit=dev
```

## Deploy to Render (test environment)

Nothing here deploys automatically. Steps for a person with access to the Render account:

1. Push this repository to GitHub (see below).
2. In Render, choose **New > Blueprint**, select the repository, and review `render.yaml`. Render
   asks for every `sync: false` value. Enter **test** values only:
   - `MONGODB_URI`: Atlas **test** database, dedicated `readWrite` user, `mongodb+srv://`.
   - `ERPNEXT_BASE_URL`, `ERPNEXT_ALLOWED_HOSTS`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`,
     `ERPNEXT_PRICE_LIST`: the **test ERPNext site** and its least-privilege API user.
     Leave `ERPNEXT_WRITE_APPROVED_HOST` empty while sync is off.
   - `ORIGIN_SHARED_SECRET`: generate with
     `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
     Put the same value in Vercel as `ORIGIN_SECRET`.
   - `CORS_ALLOWED_ORIGINS` and `APP_PUBLIC_URL`: the storefront's Vercel production origin,
     e.g. `https://agrismart-frontend.vercel.app` (https, no trailing slash).
   - `MAIL_FROM`, `SMTP_*`: a real mailbox. Production mode requires email.
3. Note the service URL (`https://<name>.onrender.com`). It must match `dest` in the frontend's
   `vercel.json`.
4. After the first deploy, in the Render **Shell**:
   - `npm run erpnext:verify` (read-only) must report `API user least privilege: OK`.
   - `npm run create-admin` creates the first back-office account.
5. Check the logs for `Origin gate: first proxied request accepted` with `forwardedForEntries` of
   1 or more, then do the post-deploy checks in the frontend README.

Settings: build `npm ci --include=dev && npm run build`, start `npm start`, health check
`/api/health/ready`, exactly **one** instance.

## Environment variables

See `.env.example` for every variable with comments. Required in production:

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` on Render |
| `PORT` | Set by Render |
| `ORIGIN_SHARED_SECRET` | 32 to 256 characters, same value as Vercel `ORIGIN_SECRET` |
| `CORS_ALLOWED_ORIGINS` | Storefront origin(s), https |
| `APP_PUBLIC_URL` | Storefront origin, used for links in emails |
| `MONGODB_URI` | Secret |
| `ERPNEXT_BASE_URL`, `ERPNEXT_ALLOWED_HOSTS` | Test site for test deployments |
| `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` | Secret, least-privilege user |
| `ERPNEXT_PRICE_LIST` | Exact selling price list name (when `ERPNEXT_PRICE_SYNC=true`) |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | `SMTP_PASS` is secret |
| `ERPNEXT_LEAD_SYNC`, `ERPNEXT_USER_SYNC`, `ERPNEXT_WRITE_APPROVED_HOST` | Writes are off by default |

There is no JWT secret: sessions are random server-side tokens stored as SHA-256 hashes.

## Push to GitHub (manual, when approved)

```bash
# Create an EMPTY private repository named agrismart-backend on GitHub first (no README/licence).
git remote add origin git@github.com:<your-org>/agrismart-backend.git
git status --short        # must be empty; confirm .env is not listed: git check-ignore -v .env
git push -u origin main
```

## Layout

- `src/` holds the application. `routes/`, `middleware/` (auth, origin gate, security), `services/`,
  `integrations/erpnext/`, `repositories/` (MongoDB + in-memory), `config/env.ts` (validated at
  startup) and `scripts/` (admin and ERPNext CLI tools).
- `test/` holds the Vitest suite: API security, auth, commerce, ERPNext, origin gate and the real
  MongoDB integration test.
- `erpnext/` holds the ERPNext "E-commerce User" registry definitions
  (`npm run erpnext:setup-user-registry`, offline unless `--apply --confirm-host`). The
  "Website server" steps in its README describe the earlier VPS setup. On Render, set the same
  variables in the dashboard instead.
