# NGO Management System — Auth + Volunteer + Beneficiary Management

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
| DATABASE | Every SQL query the app runs, grouped by entity (Users, Volunteers, Volunteer Hours, Beneficiaries, Aid Log). All async — built on `db.js`'s connection pool. |
| SHARED CSS | One stylesheet, reused by every page. |
| PAGE TEMPLATES | Functions returning full HTML strings for every page. |
| MIDDLEWARE | `requireAuth`, `requireRole(...)`, and `asyncRoute()` (forwards rejected promises to Express's error handler instead of crashing). |
| APP / ROUTES | Auth → Volunteer Management → Beneficiary Management → error handler → server start. |

## Modules

**Auth** — register, login, sessions, protected dashboard, logout.

**Volunteer Management (FR2)** — self-service skills + hour logging at
`/volunteer/profile`; admin search/verify/approve at `/volunteers`
(Project Manager, Super Admin only).

**Beneficiary Management (FR4)** — new this round:
- `/beneficiaries` — searchable list (Project Manager, Super Admin only —
  per SRS Section 8, this data is never public)
- `/beneficiaries/new` — create a profile (full name, government ID / unique
  hash, location, support summary)
- `/beneficiaries/:id` — profile detail + full aid history + a form to log
  new aid delivered
- **Deduplication** is enforced twice: the app checks for an existing
  `unique_gov_hash` before inserting (friendly error message), and the
  database itself has a `UNIQUE` constraint on that column as a backstop.

## Database schema

```
users                 id, name, email, password_hash, role, created_at
volunteers            volunteer_id (FK→users), skills, verified_status, updated_at
volunteer_hours       id, volunteer_id (FK→users), task_name, hours_logged,
                       date_logged, status, approved_by, approved_at
beneficiaries         beneficiary_id, full_name, unique_gov_hash (UNIQUE),
                       location, support_received, created_by (FK→users), created_at
beneficiary_aid_log   id, beneficiary_id (FK→beneficiaries), description,
                       aid_type, date_provided, recorded_by
```

Full definitions, constraints, and indexes are in `schema.sql`.

## Migrating from the CSV version

If you were on the earlier CSV-backed build: `data/*.csv` is no longer read
or written by `app.js`. Nothing auto-imports old CSV rows into Postgres —
if you need that data, write a one-off script that reads the CSVs and calls
the equivalent `INSERT` statements, or re-register the test accounts.

## Next modules (per the SRS)

Project Monitoring → Donation Processing → Fundraising Campaigns →
Financial Transparency Dashboard. Same pattern each time: add tables to
`schema.sql`, query functions to the DATABASE section, page templates,
then routes.
