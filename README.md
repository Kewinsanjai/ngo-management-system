# ABC Foundation — NGO Management System

A server-rendered NGO management platform for coordinating volunteers, protecting beneficiary records, and monitoring community projects.

## Current status

**The application is functional and currently supports four modules:**

| Module | Status | What is available |
|---|---|---|
| Authentication & role access | Complete | Registration, login, logout, sessions, and role-protected routes |
| Volunteer Management | Complete | Skills, verification, working-hour logging, and manager approval workflows |
| Beneficiary Management | Complete | Secure records, duplicate prevention, searchable records, and aid history |
| Project Monitoring | Complete | Project creation, status/progress tracking, schedules, search, and update timelines |
| Donation Processing | Planned | Not implemented — no payment handling or donation data is available |
| Fundraising Campaigns | Planned | Not implemented |
| Financial Transparency Dashboard | Planned | Not implemented |

The public landing page is informational only. It does not expose beneficiary information or represent unbuilt modules as operational.

## Technology

- Node.js and Express
- PostgreSQL (`pg`)
- `express-session` for authenticated sessions
- `bcryptjs` for password hashing
- Server-rendered HTML, CSS, and vanilla JavaScript

The implementation intentionally has no frontend framework or build process. Application logic and page templates are in `app.js`; PostgreSQL access is isolated in `db.js`.

## Roles and access

| Role | Access |
|---|---|
| Super Admin | Full access to projects, volunteers, and beneficiaries |
| Project Manager | Full access to projects, volunteers, and beneficiaries |
| Volunteer | Own profile, skills, and working hours only |
| Donor | Account access only; the donation module is not yet available |
| Public Visitor | Public landing page only |

### Privacy

Beneficiary information is confidential. It is available only to Super Admin and Project Manager users. It is never shown on the public site and is not accessible to Volunteers, Donors, or Public Visitors.

## Setup

### 1. Create the PostgreSQL database

```bash
# macOS example
brew install postgresql@16
brew services start postgresql@16

psql postgres -c "CREATE USER ngo_app WITH PASSWORD 'ngo_dev_password';"
psql postgres -c "CREATE DATABASE ngo_management OWNER ngo_app;"
```

### 2. Configure the connection

```bash
cp .env.example .env
```

Set `DATABASE_URL` in `.env` if your PostgreSQL settings differ. The development default is:

```text
postgresql://ngo_app:ngo_dev_password@localhost:5432/ngo_management
```

### 3. Install and run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The schema is applied automatically at server start; all tables and indexes use safe `IF NOT EXISTS` definitions.

## Current routes

| Route | Access | Purpose |
|---|---|---|
| `/` | Public | ABC Foundation landing page |
| `/login`, `/register` | Public | Account access |
| `/dashboard` | Signed-in users | Role-aware dashboard |
| `/volunteer/profile` | Volunteer | Skills and personal working hours |
| `/volunteers` | Super Admin, Project Manager | Volunteer search, verification, and hour approvals |
| `/beneficiaries` | Super Admin, Project Manager | Secure beneficiary records |
| `/projects` | Super Admin, Project Manager | Project Monitoring dashboard |
| `/projects/new` | Super Admin, Project Manager | Create a project |
| `/projects/:id` | Super Admin, Project Manager | Project overview and progress-update timeline |

## Project Monitoring

Authorized staff can create projects with a name, description, location, dates, status, and initial progress; search projects; and record percentage progress with a dated update note. Updates form an auditable timeline showing the author, date, status, progress, and note.

There are no fabricated project statistics or public project records.

## Database tables

```text
users
volunteers
volunteer_hours
beneficiaries
beneficiary_aid_log
projects
project_updates
```

The complete definitions, validation constraints, foreign keys, and indexes are in `schema.sql`.

## Project structure

```text
app.js       Express application, SQL query helpers, templates, styles, and routes
db.js        PostgreSQL pool and automatic schema setup
schema.sql   Database schema
data/        Legacy CSV samples; not used by the live PostgreSQL application
```

## Next planned module

**Donation Processing** is the next planned feature. It should be implemented as a real, role-protected module with database-backed records before it appears as functional anywhere in the public or private interface.
