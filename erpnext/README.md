# ERPNext: E-commerce User registry

A read-only copy of each website customer account in ERPNext, for staff reporting. The website
backend (MongoDB) stays the source of truth and the only system that authenticates customers.

> **Production state (read-only check, 2026-10-27).** The production site (`asfsl.sanvidhierp.in`)
> already has a custom DocType **E-commerce User** (module Setup). It is named by the naming series
> `ECU-.YYYY.-.#####`, has the nine fields below, and grants permissions to **System Manager
> only**. The roles, number cards and workspace from this folder do **not** exist there yet. The
> website has never written to it: `ERPNEXT_USER_SYNC` is off, and local runs cannot write to
> production (write guard). Anything further on production needs explicit approval; try it on a
> staging site first.

## What gets created

| File | ERPNext record | Notes |
|---|---|---|
| `roles.json` | Role **E-commerce Integration** | No desk access. Only for the website's API user. |
| `roles.json` | Role **E-commerce Registry Manager** | For staff who view the registry and dashboard. |
| `ecommerce-user.doctype.json` | Custom DocType **E-commerce User** (module Setup) | Mirrors the existing production DocType (naming series `ECU-.YYYY.-.#####`). It already exists in production, so the setup script skips it; the script never changes an existing DocType. |
| `number-cards.json` | 8 Number Cards | Counts over E-commerce User (see "Report definitions"). |
| `workspace.json` | Workspace **E-commerce Users** | The cards and a list shortcut, visible to E-commerce Registry Manager. |

### Fields

| Field (fieldname) | Type | Source on the website | Written |
|---|---|---|---|
| Series (`naming_series`) | Select `ECU-.YYYY.-.#####` | constant; ERPNext generates the record name (e.g. `ECU-2026-00001`) | on create only |
| Customer Name (`customer_name`) | Data | account name | create + update |
| Email (`email`) | Data | sign-in email, trimmed and lower case | create + update |
| Mobile (`mobile`) | Data | account mobile, E.164 (e.g. `+919876543210`) | create + update |
| Registration Date (`registration_date`) | **Date** | the account's creation date (site timezone) | on create only; never overwritten |
| Email Verified (`email_verified`) | Check | 1: only confirmed accounts are synced | create + update |
| Account Status (`account_status`) | Select: Active / Inactive / Suspended | set by staff on the website server (Active after verification) | create + update |
| Last Login (`last_login`) | Datetime | last successful sign-in (empty until the first sign-in) | create + update |
| Last Activity (`last_activity`) | Datetime | last meaningful action (see below) | create + update |

**Never stored in ERPNext:** passwords, password hashes, verification or reset tokens, session
ids or cookies, CSRF tokens, delivery addresses. The backend builds the document from a fixed
field list (`toRegistryDoc` in `Backend/src/services/userRegistry.ts`). The setup script refuses
a DocType definition with password-, token- or session-like fields.

### Permissions

Current production DocType: **System Manager** only (read, write, create, delete). For the
website to write, its API user needs access to this DocType. Recommended (least privilege):

| Role | Read | Create | Write | Delete | Report / Export |
|---|---|---|---|---|---|
| E-commerce Integration | ✓ | ✓ | ✓ | ✗ | ✗ |
| E-commerce Registry Manager | ✓ | ✗ | ✗ | ✗ | ✓ / ✓ |

- Create the two roles (`roles.json`, or the setup script), then add these permission rows to the
  existing DocType in **Role Permission Manager**. The setup script will not change the existing
  DocType for you.
- **Do not give the website API user System Manager or Administrator.** Confirmed on 2026-10-27
  by the read-only least-privilege probe: the user behind the website's key **does** have
  administrator-level access. Fix this first: see "Before production: least privilege" below.
- Managers can't edit records. Account status is changed on the website server
  (`npm run user-registry -- status …`), which also ends the customer's sessions; ERPNext then
  receives the new status. A status typed into ERPNext would be overwritten by the next sync, and
  it would not block sign-in.
- Customers have no ERPNext access at all. The browser never talks to ERPNext. The website API
  exposes no registry fields, and account routes act only on the signed-in customer.

## Synchronisation (website backend)

- **Only confirmed accounts are sent.** Registration creates the account in the website database;
  nothing reaches ERPNext until the email address is confirmed. Confirming the email queues the
  first sync, so every registry record has Email Verified = 1 (an email change also confirms the
  new address). Unconfirmed accounts are counted on the website only
  (`awaitingEmailVerification` in the health report).
- Changes that update the copy: email confirmation, email change, profile edit, sign-in (Last
  Login and Last Activity), meaningful activity, and account status.
- **Last Activity** means a sign-in, order request, inquiry or quotation request, email
  confirmation, or a profile, address or password change. Browsing and page loads don't count.
  It is written at most every 10 minutes per customer.
- **Versions.** Every change sets `version = max(version, syncedVersion) + 1` in one atomic
  MongoDB update. That includes accounts created before the registry existed, whose missing
  fields count as "version 1, never synced". The job locks a customer under a random token, sends
  the full current snapshot, and records the version it sent with `$max`, so versions never move
  backwards. A change made during a sync stays queued and is sent next. A worker whose lock
  expired can't record success; its customer is re-queued instead.
- **Idempotent upsert (naming-series DocType).** After the first sync the website stores the
  ERPNext record name (`registrySync.erpName`, e.g. `ECU-2026-00001`) and updates that record by
  name, so later email changes never create a second record. Before that (first sync, or a create
  whose response was lost), it looks for records with the normalised email:
  - exactly one: adopted and updated, including records created by staff;
  - several: a permanent `duplicate_email` failure; staff merge them, then retry; nothing is
    guessed;
  - none: created with the naming series.

  A linked record deleted in ERPNext is created again and re-linked. Updates never send
  `naming_series` or `registration_date`.

### Retry policy

| Situation | Behaviour |
|---|---|
| Timeout, network error, HTTP 5xx, malformed response | Transient: backoff 1 min doubling to at most 6 h, with jitter (half fixed, half random). |
| HTTP 429 or 503 with `Retry-After` | Transient: waits at least the `Retry-After` time (capped at 24 h). |
| 8 transient failures in a row | `exhausted`: stops until an operator retries it. |
| HTTP 400/417 (validation), 409 email owned by another record | `permanent`: never retried automatically. |
| HTTP 401/403, missing DocType, write guard | **Configuration**: the whole job pauses. No customer is charged an attempt or marked failed. A read-only access check runs before each run until it passes again. |

New customer activity during an outage does **not** reset an existing backoff, attempt count or
failure. Failures stay visible until an operator retries them; new changes are kept and sent with
the retry.

### Health and operator retry

- `GET /api/admin/customers/registry-health` (staff and admins): job state (`ready`, `blocked`
  with the problem, or `disabled`); pending, retrying, permanent and exhausted counts; customers
  awaiting email confirmation; oldest pending age; last success; highest attempt count; and
  counts per error category. Aggregates only: no emails, phone numbers or names.
- `npm run user-registry -- health`: the same figures on the server.
- `npm run user-registry -- failed`: failed syncs by customer id and error category, without
  personal data.
- **Safe retry:** fix the cause first, for example correct the conflicting email or fix the
  ERPNext permission. Then run `npm run user-registry -- retry --scope permanent|exhausted|failed`
  (optionally `--customer <id>`), or `POST /api/admin/customers/registry-sync/retry`
  (admins, CSRF-protected). Retrying sends the customer's latest data.

### Write guard (no accidental production writes)

Every ERPNext write (Lead, Comment, E-commerce User) passes a fail-closed guard
(`Backend/src/integrations/erpnext/writeGuard.ts`):

- **Automated tests** (`NODE_ENV=test` or any Vitest worker) can write only to a local stub. The
  production site is refused at the client, whatever the configuration says.
- **Local development** can never write to `asfsl.sanvidhierp.in`. If a sync flag is on while
  pointing at it, the API refuses to start. `npm run dev:erp` keeps working read-only.
- **Staging:** writes need `ERPNEXT_WRITE_APPROVED_HOST` set to the exact staging hostname.
- **Production:** writes need `NODE_ENV=production` *and* `ERPNEXT_WRITE_APPROVED_HOST=asfsl.sanvidhierp.in`.
  This includes Lead sync, so the production `.env` must have it once this version is deployed.
- Hosts are compared exactly (no substring or suffix matching). Requests never follow redirects.
  Errors name the rule, never the host or credentials.

### Before the sync starts

With `ERPNEXT_USER_SYNC=true`, the API first checks (read-only) that the DocType exists and the
integration user can read it. A missing DocType, wrong credentials or missing permissions stop
the server with a clear message. If ERPNext is merely unreachable, the website starts and the job
keeps checking. `npm run erpnext:verify` treats the check as required when the sync is on.
`ERPNEXT_USER_SYNC=false` (the default) skips all of this, and the website never depends on
ERPNext for it.

## Report definitions

All windows are calendar days in the site timezone (`ERPNEXT_TIMEZONE`, Asia/Kolkata), **today
included**. "Last 7 days" runs from 00:00 six days ago; "last 30 days" from 00:00 twenty-nine days
ago. The number cards use `frappe.datetime.add_days(frappe.datetime.now_date(), -6 / -29)`.

| Card | Definition |
|---|---|
| Registered | All E-commerce User records (confirmed accounts; the website stats also count unconfirmed ones) |
| Active / Inactive / Suspended accounts | Account Status equals that value |
| Email verified | Email Verified = 1 (equals Registered, because only confirmed accounts are synced) |
| New (7 / 30 days) | Registration Date in the window |
| Active users (30 days) | Distinct website users (one record per Website User ID) whose Last Activity is in the window |

"Active users" is **not** the same as "Active accounts". A suspended account can have been active
last week, and an Active account may not have been used for months. The website computes the same
figures from its own database at `GET /api/admin/customers/stats` (staff only) and with
`npm run user-registry -- stats`. Compare them after deployment.

## Before production: least privilege for the website API user (blocking)

**Finding (read-only probe, 2026-10-27):** the API key in the website's `.env` belongs to a user
(`ag***@…`, masked) that can read DocType definitions. In Frappe only **System Manager** or
**Administrator** can do that, so this key currently has administrator-level power over the whole
ERPNext site. It looks like a person's or the company's main account rather than a dedicated
service user, and the key has been used on developer machines. **Do not enable the registry sync
until this is fixed.**

### Read-only check (never prints credentials)
```
cd Backend
npm run build
npm run erpnext:verify
```
Look for the line `API user least privilege:`. `OK` means no administrator-level access. `WARN`
(sync off) or `FAIL` (sync on) means the user still has System Manager or similar. The check reads
one DocType definition (metadata only) and the logged-in user name (shown masked). It writes
nothing.

### Confirm in the ERPNext UI (an ERPNext administrator)
1. Sign in to `https://asfsl.sanvidhierp.in/app` as an administrator.
2. Open **User List** (search bar → "User List") and open the user shown, masked, by `erpnext:verify`.
3. Open the **Roles & Permissions** section (in v14/v15, on the **Settings** tab):
   - Look at the **Roles** checkboxes. **System Manager** must be unchecked. The user must not be
     `Administrator`.
   - Look at the **Role Profile** field. A role profile can add System Manager even when you don't
     tick it yourself; if one is set, open it and check its roles too.
4. In **API Access** you can see that an API key exists. Don't regenerate it here unless you are
   rotating it (see below); regenerating breaks the website until `.env` is updated.

### Recommended fix
1. Create a **dedicated** user, e.g. `website-api@agrismartfarm.in`: User Type System User, no
   System Manager, no Administrator, not used by any person.
2. Give it only the roles in the table below. Generate its API key and secret, and put them **only**
   in the server's env file (`/var/www/agrismart/shared/backend.env`).
3. Rotate the old key: regenerate the API secret on the account whose key is in the developers'
   `.env` files, so that copies on machines stop working. For local `dev:erp`, give developers a
   key of a **read-only** user (catalogue read roles only).
4. Run `npm run erpnext:verify` again: `API user least privilege: OK`.

### Least-privilege roles for the website API user

| Role (custom) | DocType | Read | Create | Write | Delete / Submit / Cancel | Needed when |
|---|---|---|---|---|---|---|
| Website Catalogue Reader | Item, Item Group | ✓ | | | ✗ | always |
| | Website Item | ✓ | | | ✗ | `ERPNEXT_CATALOG_SOURCE=website_item` |
| | Item Price, Price List | ✓ | | | ✗ | `ERPNEXT_PRICE_SYNC=true` |
| Website Lead Writer | Lead | ✓ | ✓ | | ✗ | `ERPNEXT_LEAD_SYNC=true` |
| | Comment | | ✓ | | ✗ | `ERPNEXT_LEAD_ADD_COMMENT=true` |
| **E-commerce Integration** | **E-commerce User** | ✓ | ✓ | ✓ | ✗ | `ERPNEXT_USER_SYNC=true` |

- Never System Manager, Administrator, or access to Customer, Sales Order, Accounts or User.
- The E-commerce User sync needs exactly **read** (find by email, access check), **create** (new
  record with the naming series) and **write** (updates). It never deletes.
- Add the E-commerce Integration and E-commerce Registry Manager rows to the existing DocType in
  **Role Permission Manager** (DocType: E-commerce User). The setup script never changes an
  existing DocType.
- To be verified on staging: Frappe derives the User Type from the roles' Desk Access setting. If
  the API user turns into a "Website User" and API calls start failing, enable Desk Access on the
  Website Catalogue Reader role, rather than adding broader roles.

## Production deployment checklist

Nothing here runs automatically. Each step is a deliberate action by the person named.

**A. Before touching production (no production writes)**
1. Written approval to enable the registry sync on `asfsl.sanvidhierp.in`.
2. Least privilege fixed and verified (section above); the new key is only on the server.
3. On the release being deployed, run (all local; the end-to-end test uses a mock ERPNext only):
   ```
   cd Backend
   npm run typecheck && npm run lint && npm test && npm run test:registry-e2e && npm run build
   ```
   On Windows, point `TEMP`/`TMP` at a drive with ~500 MB free for the in-memory MongoDB.
4. Staging rehearsal (strongly recommended): a staging copy of the site with
   `ERPNEXT_WRITE_APPROVED_HOST=<staging host>` and `ERPNEXT_USER_SYNC=true`. Verify a test
   account, then check its record, a retry, and the health checks below.

**B. ERPNext configuration (an ERPNext administrator)**

5. Roles, number cards and workspace: `npm run erpnext:setup-user-registry` (offline plan), then
   with a person's **temporary** administrator key the read-only check, then `-- --apply
   --confirm-host asfsl.sanvidhierp.in` with `NODE_ENV=production` set for that one command. The
   existing DocType is skipped. Revoke the temporary key afterwards.
6. Role Permission Manager: add the E-commerce Integration and E-commerce Registry Manager rows to
   the E-commerce User DocType.
7. Assign E-commerce Integration to the dedicated API user, and E-commerce Registry Manager to the
   staff who need the dashboard.

**C. Website server (the operator)**

8. Deploy the release with **`ERPNEXT_USER_SYNC=false`** (unchanged), and run the health checks.
   This release also updates `deploy/nginx/snippets/agrismart-proxy.conf`: it drops client-supplied
   `Forwarded` headers. Copy it to `/etc/nginx/snippets/`, then `sudo nginx -t && sudo systemctl reload nginx`.
9. `npm run erpnext:verify`. Required: `E-commerce User registry read access: OK` and
   `API user least privilege: OK`.
10. In `backend.env`: `NODE_ENV=production`, `ERPNEXT_WRITE_APPROVED_HOST=asfsl.sanvidhierp.in`
    (also needed for Lead sync) and `ERPNEXT_USER_SYNC=true`. Then `pm2 reload agrismart-api`. The
    API refuses to start if the DocType is missing or not accessible.
11. Run the health checks below now, after 15 minutes and after 24 hours.

## Health checks (production)

| Check | How | Expected |
|---|---|---|
| API up | `curl -s https://<domain>/api/health/ready` | `{"status":"ready"}` |
| Startup | `pm2 logs agrismart-api --lines 200 --nostream \| grep -Ei "registry\|Refusing\|Outgoing email"` | no `Refusing to start`, no `ERPNext user registry paused`; `Outgoing email: SMTP` |
| ERPNext access | `cd /var/www/agrismart/current/Backend && npm run erpnext:verify` | registry read `OK`, least privilege `OK` |
| Sync health | sign in at `https://<domain>/admin`, then open `https://<domain>/api/admin/customers/registry-health` in the same browser | `enabled: true`, `job.state: "ready"`, `job.problem: null`, `queue.failedPermanent: 0`, `queue.failedExhausted: 0`, `queue.oldestPendingAgeSeconds` falling to `null`, `queue.lastSuccessAt` recent |
| Queue (server) | `npm run user-registry -- health` and `npm run user-registry -- failed` | same counts; `failed` prints nothing |
| Reconcile | ERPNext **E-commerce User** list count vs `npm run user-registry -- stats` → `emailVerified` | equal once the backfill has finished (only confirmed accounts are synced) |
| Spot check | confirm a staff-owned test account, then open its ECU record in ERPNext | fields as in "Fields"; one record per email |

If `job.state` is `blocked`, `job.problem` tells you why: `permission`, `auth`, `doctype_missing`
or `write_blocked`. Fix the cause; the job resumes by itself once the access check passes. For
`failedPermanent > 0`, run `npm run user-registry -- failed`. The usual cause is `duplicate_email`
(several ERPNext records with one email): merge them in ERPNext, then
`npm run user-registry -- retry --scope permanent`.

## Rollback

1. **Stop writing:** set `ERPNEXT_USER_SYNC=false` in `backend.env` and `pm2 reload agrismart-api`.
   The website keeps working unchanged. Pending changes stay queued in MongoDB and are sent if the
   sync is turned on again.
2. **Remove access** (optional): untick E-commerce Integration on the API user. Number cards and
   the workspace can stay.
3. **Records** (optional): records created in ERPNext can stay, or an administrator can delete
   them. The website does not depend on them. If the sync is enabled again later, links to
   deleted records are re-created, and records with a matching email are adopted, not duplicated.
4. **Code rollback:** redeploy the previous release. The MongoDB fields (`registrySync.*`,
   `accountStatus`, `lastLoginAt`, `lastActivityAt`) are additive and safe to leave in place.
5. **Key exposure:** if an ERPNext key may have leaked, regenerate its secret in ERPNext
   (User → API Access) and update the server env.

## Manual alternative

Instead of the script, an administrator can build the same records in the UI
(Customize → New DocType, Role, Number Card, Workspace) from the JSON files. They must keep the
naming rule `field:website_user_id`, the unique fields and the permission table exactly as defined.
