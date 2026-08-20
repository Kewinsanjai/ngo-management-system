# NGO Management System — Auth + Volunteer + Beneficiary + Project + Donation Management

Application code lives in one file, **`app.js`**. Storage is **PostgreSQL**
— `db.js` handles the connection and `schema.sql` defines every table.

## One-time setup

1. Install PostgreSQL if you don't have it:
   ```bash
   # macOS
   brew install postgresql@16
   brew services start postgresql@16
   ```

2. Create the database and a dedicated app user:
   ```bash
   psql postgres -c "CREATE USER ngo_app WITH PASSWORD 'ngo_dev_password';"
   psql postgres -c "CREATE DATABASE ngo_management OWNER ngo_app;"
   ```

3. Copy the env file and adjust if your setup differs:
   ```bash
   cp .env.example .env
   ```

## Run it

```bash
npm install
node app.js
```

On startup, `app.js` calls `ensureSchema()`, which runs `schema.sql` —
every table is created automatically if it doesn't already exist. No manual
migration step. Then open **http://localhost:3000/login** (or `/register`).

## What's inside `app.js`

| Section | What it does |
|---|---|
| DATABASE | Every SQL query the app runs, grouped by entity (Users, Volunteers, Volunteer Hours, Beneficiaries, Aid Log, Projects, Project Updates, Donations, Donation Status History). All async — built on `db.js`'s connection pool. |
| SHARED CSS | One stylesheet, reused by every page. |
| PAGE TEMPLATES | Functions returning full HTML strings for every page. |
| MIDDLEWARE | `requireAuth`, `requireRole(...)`, and `asyncRoute()` (forwards rejected promises to Express's error handler instead of crashing). |
| APP / ROUTES | Auth → Volunteer Management → Project Monitoring → Beneficiary Management → Donation Processing → error handler → server start. |

## Modules

**Auth** — register, login, sessions, protected dashboard, logout.

**Volunteer Management (FR2)** — self-service skills + hour logging at
`/volunteer/profile`; admin search/verify/approve at `/volunteers`
(Project Manager, Super Admin only).

**Beneficiary Management (FR4)**:
- `/beneficiaries` — searchable list (Project Manager, Super Admin only —
  per SRS Section 8, this data is never public)
- `/beneficiaries/new` — create a profile (full name, government ID / unique
  hash, location, support summary)
- `/beneficiaries/:id` — profile detail + full aid history + a form to log
  new aid delivered
- **Deduplication** is enforced twice: the app checks for an existing
  `unique_gov_hash` before inserting (friendly error message), and the
  database itself has a `UNIQUE` constraint on that column as a backstop.

**Project Monitoring** — `/projects` list + search, `/projects/new` to create
a project, `/projects/:id` for detail plus an append-only progress-update
timeline (Project Manager, Super Admin only).

**Donation Processing** — **Manual / Offline Record keeping only — no payment
gateway is integrated.** Every donation reflects money that already changed
hands elsewhere (cash, bank transfer, cheque, mobile money, etc.); nothing on
this platform charges a card or moves money.
- `/donations` — dashboard + searchable, filterable list (Project Manager,
  Super Admin only). Shows real, database-driven totals: amount received
  (grouped by currency, never fabricated into a misleading single figure),
  pending count, distinct donor count, and recent donations. Filters by
  donor (name/email), status, payment method, purpose, and date range.
- `/donations/new` — staff records a donation on a donor's behalf, with
  server-side validation (positive amount, valid currency/payment-method
  allowlists, valid email and date).
- `/donations/:id` — full detail + a status-update form (Pending → Received
  → Refunded/Cancelled) that requires an in-page confirmation step before
  submitting, plus a complete audit trail of every status change
  (`donation_status_history`: old status, new status, who changed it, when,
  and an optional note).
- `/my-donations`, `/my-donations/new`, `/my-donations/:id` — a signed-in
  **Donor** can both view their own donation history and **self-report a
  donation they've already made** ("Record My Donation"). Self-reported
  donations always start `Pending`; only a Project Manager/Super Admin can
  move one to `Received`, exactly like a staff-entered donation. The
  donor's name/email are always taken from their session — never from the
  submitted form — so a donor cannot attribute a donation to a different
  identity. Donors cannot see any other donor's records, and public
  visitors have no route into this data at all.
- The public landing page does **not** have a "Donate Now" payment button,
  because there is no payment gateway to back it yet — it instead invites
  visitors to register as a Donor and use the self-service recording flow.

## UI / UX layer (applies to every authenticated page)

- **Flash messages** — every create/update action (verify a volunteer,
  approve/reject hours, log skills or hours, create a beneficiary, log aid,
  create/update a project, record a donation, update a donation status,
  self-report a donation) sets a one-shot success/error banner via
  `setFlash()`/`popFlash()` (session-backed), shown at the top of the page
  the user lands on after the redirect.
- **Inline validation + loading state** — one shared script
  (`FORM_UX_SCRIPT`, injected once by `appShell`) runs on every authenticated
  page: it marks empty required fields the same way the login/register pages
  do (red border, matching the design system) and disables/labels the submit
  button while a POST is in flight — no per-form JavaScript needed.
- **Responsive tables** — every table on every page collapses into stacked
  cards below 700px instead of horizontally scrolling, using a CSS
  `data-label` pattern (`pageHead()`/table cells carry `data-label`
  attributes; no JS needed).
- **Icon-led empty states and page headers** — `pageHead()` and `emptyRow()`
  helpers give every page a consistent icon + title header and a friendly
  icon-based empty state instead of plain gray text.



## Database schema

```
users                      id, name, email, password_hash, role, created_at
volunteers                 volunteer_id (FK→users), skills, verified_status, updated_at
volunteer_hours            id, volunteer_id (FK→users), task_name, hours_logged,
                            date_logged, status, approved_by, approved_at
beneficiaries               beneficiary_id, full_name, unique_gov_hash (UNIQUE),
                            location, support_received, created_by (FK→users), created_at
beneficiary_aid_log        id, beneficiary_id (FK→beneficiaries), description,
                            aid_type, date_provided, recorded_by
projects                   project_id, name, description, location, status, progress,
                            start_date, end_date, created_by (FK→users), created_at, updated_at
project_updates            id, project_id (FK→projects), note, progress, status,
                            recorded_by, created_at
donations                  donation_id, donor_name, donor_email, donor_user_id (FK→users),
                            amount, currency, donation_date, payment_method, status,
                            purpose, reference_number, internal_notes, recorded_by,
                            created_at, updated_at
donation_status_history    id, donation_id (FK→donations), old_status, new_status,
                            changed_by, note, changed_at
```

Full definitions, constraints, and indexes are in `schema.sql`. All
Donation Processing tables were added additively — no existing table was
altered or dropped.

## Migrating from the CSV version

If you were on the earlier CSV-backed build: `data/*.csv` is no longer read
or written by `app.js`. Nothing auto-imports old CSV rows into Postgres —
if you need that data, write a one-off script that reads the CSVs and calls
the equivalent `INSERT` statements, or re-register the test accounts.

## Next modules (per the SRS)

Fundraising Campaigns → Financial Transparency Dashboard. Same pattern each
time: add tables to `schema.sql`, query functions to the DATABASE section,
page templates, then routes.
