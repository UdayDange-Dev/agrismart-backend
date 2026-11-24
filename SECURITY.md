# Agrismart API: security notes for deployment

This file covers what an operator must get right when deploying this API on Render behind the
Vercel storefront. The full threat model and earlier audit history are in the original project's
`SECURITY-AUDIT.md`. That report describes the earlier single-VPS (Nginx) design.

## Architecture

```
Browser ──HTTPS──> Vercel (storefront + /api/* rewrite) ──HTTPS + origin secret──> Render (this API)
                                                                                    ├──> MongoDB Atlas (TLS)
                                                                                    └──> ERPNext (HTTPS, token auth)
```

- The browser only talks to the storefront origin. `/api/*` is proxied by Vercel, so the session
  cookies (`__Host-…`, `HttpOnly`, `Secure`, `SameSite=Strict`), the CSRF token and the Origin
  checks work exactly as on a single origin. Never switch the frontend to call Render directly,
  and never relax the cookies to `SameSite=None`.
- **Origin gate.** Vercel adds `x-agrismart-origin-secret` from its server-side `ORIGIN_SECRET`
  variable. Its `set` transform replaces any value a visitor sends. The API refuses every request
  without the matching `ORIGIN_SHARED_SECRET` (403), except `GET /api/health` and
  `GET /api/health/ready`. The header is deleted after the check, so it is never logged or echoed.
  The API refuses to start in production without the secret.
- **Visitor IP** (rate limits and security logs). Vercel overwrites `X-Forwarded-For` with the
  visitor's address, and later proxies only append to it. So for a request that passed the gate,
  the first entry is the visitor. A forged `X-Forwarded-For` sent directly to Render never reaches
  a rate limiter, because the gate rejects it first. `TRUST_PROXY` is unused behind the gate; keep it 0.

## ERPNext API user (least privilege), one per site

Use a **separate test ERPNext site** for test deployments. Never put production ERPNext
credentials into a test service. Create a dedicated user, e.g. `website-api@…`, with a custom role
granting **only**:

- **Read:** Item, Website Item (with `ERPNEXT_CATALOG_SOURCE=website_item`), Item Price and Price
  List (with `ERPNEXT_PRICE_SYNC=true`), Item Group, and Lead (with `ERPNEXT_LEAD_SYNC=true`).
- **Create:** Lead and Comment, only with `ERPNEXT_LEAD_SYNC=true`. With sync off, the integration
  is strictly read-only.
- **E-commerce User:** read, create and write through the E-commerce Integration role
  (`erpnext/`), only with `ERPNEXT_USER_SYNC=true`. No delete.
- **Never** System Manager or Administrator. No Delete, Submit or Cancel. No Sales Order, Customer
  or Accounts access.

Check it with `npm run erpnext:verify` (read-only) from the Render shell. It must report
`API user least privilege: OK`. The existing production API user was found to have System
Manager-level access (original audit, section 14). Do not reuse it.

Writes are blocked by a fail-closed guard (`src/integrations/erpnext/writeGuard.ts`):

- The production ERPNext host can be written to only with `NODE_ENV=production` and
  `ERPNEXT_WRITE_APPROVED_HOST` set to that exact host.
- Any other host needs `ERPNEXT_WRITE_APPROVED_HOST` set to that host.
- `render.yaml` ships with `ERPNEXT_LEAD_SYNC=false` and `ERPNEXT_USER_SYNC=false`.

## MongoDB Atlas

- Use separate clusters, or at least separate databases **and** users, for test and production.
  The app user gets `readWrite` on its own database only.
- Use a `mongodb+srv://` URI (TLS) with a long random password, set only in the Render dashboard.
- Render's outbound IPs are not static on all plans, so Atlas often needs a broad IP access list.
  The strong credentials and TLS are then the control. Use Render's static outbound IPs where your
  plan offers them.
- Before the API serves traffic, it builds unique indexes (no duplicate accounts or orders). If it
  can't, it refuses to start.

## Operational constraints

- **One instance only.** Rate limits, the catalogue cache and the sync jobs live in the process.
  Move rate limiting to a shared store (e.g. Redis) before scaling out.
- A sleeping free-tier service pauses the inquiry and registry sync jobs. Use a paid instance for
  production.
- Rotate `ORIGIN_SHARED_SECRET`/`ORIGIN_SECRET`, the ERPNext key, the Atlas password and the SMTP
  password if they are ever exposed. Rotate the origin secret on both platforms together.
  Requests fail with 403 between the two changes.
