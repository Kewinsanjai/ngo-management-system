# NGO Management System — Auth Module (Single File)

Everything — server, routes, CSV storage, and the login/register/dashboard
pages — lives in **one file: `app.js`**. Only `data/users.csv` (generated
automatically) and `node_modules` sit outside it.

## Run it

```bash
npm install
node app.js
```

Then open **http://localhost:3000/login** (or `/register`).

## What's inside `app.js`

| Section | What it does |
|---|---|
| CSV STORE | Reads/writes `data/users.csv`. Swap this section for real database queries later — nothing else needs to change. |
| SHARED CSS | One stylesheet, reused by every page. |
| PAGE TEMPLATES | `loginPage()`, `registerPage()`, `dashboardPage()` — return full HTML strings. |
| APP / ROUTES | Express routes: `/login`, `/register`, `/dashboard`, and the `/api/*` endpoints they call. |

## Behavior

- Passwords are hashed with bcrypt before being written to the CSV.
- Registering signs you in automatically (session cookie set).
- `/dashboard` is server-protected — it checks your session before rendering,
  and redirects to `/login` if you're not signed in.
- Duplicate emails and wrong passwords are rejected with clear messages.

## CSV format

```
id,name,email,passwordHash,role,createdAt
```
