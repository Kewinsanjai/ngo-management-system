# NGO Management System — Auth + Volunteer Management (Single File)

Everything — server, routes, CSV storage, and every page — lives in
**`app.js`**. Only `data/` (auto-generated) and `node_modules` sit outside it.

## Run it

```bash
npm install
node app.js
```

Then open **http://localhost:3000/login** (or `/register`).

## What's inside `app.js`

| Section | What it does |
|---|---|
| CSV STORE | Generic CSV-table helper (`makeCsvTable`) plus the three tables: Users, Volunteers, Volunteer Hours. Swap this section for real database queries later — nothing else changes. |
| SHARED CSS | One stylesheet, reused by every page. |
| PAGE TEMPLATES | Functions that return full HTML strings — `loginPage()`, `registerPage()`, `dashboardPage()`, `volunteerProfilePage()`, `volunteersAdminPage()`, `errorPage()`. |
| MIDDLEWARE | `requireAuth` (must be signed in) and `requireRole(...)` (must have one of the given roles). |
| APP / ROUTES | Auth routes first, then Volunteer Management routes. |

## What's functional

**Auth** (from before): register, login, sessions, protected dashboard, logout.

**Volunteer Management** (new):
- Anyone who registers as **Volunteer** gets a profile at `/volunteer/profile`
  — they can list their skills (comma-separated) and log hours against a task.
- Anyone who registers as **Project Manager** or **Super Admin** gets an
  admin view at `/volunteers` — search volunteers by skill, verify/unverify
  them, and approve or reject logged hours.
- Role checks are enforced server-side (`requireRole`) — a Volunteer hitting
  `/volunteers` gets a 403 page, not just a hidden link.
- The dashboard's "Quick actions" card links to whichever module fits the
  signed-in user's role.

## Data files

Three CSVs live in `data/`, all created automatically on first run:

```
users.csv            id, name, email, passwordHash, role, createdAt
volunteers.csv       volunteerId, skills, verifiedStatus, updatedAt
volunteer_hours.csv  id, volunteerId, taskName, hoursLogged, dateLogged, status, approvedBy, approvedAt
```

`volunteerId` in both the volunteers and hours tables references `users.csv`'s
`id` column — that's the foreign key relationship once this moves to a real
database.

## Next modules (per the SRS)

Beneficiary Management → Project Monitoring → Donation Processing →
Fundraising Campaigns → Financial Transparency Dashboard. Same pattern each
time: a CSV table in section 1, page templates in section 3, routes at the
bottom.
