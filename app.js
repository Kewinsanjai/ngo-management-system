/**
 * NGO Management System — Auth + Volunteer Management
 * -----------------------------------------------------
 * One file: Express server, CSV-backed storage, and every page's
 * HTML/CSS/JS templated inline below.
 *
 * Run it:
 *   npm install
 *   node app.js
 *   open http://localhost:3000/login
 *
 * Modules in this file:
 *   1. CSV STORE      — generic CSV table helper + Users/Volunteers/Hours tables
 *   2. SHARED CSS      — one stylesheet, reused by every page
 *   3. PAGE TEMPLATES  — functions returning full HTML strings
 *   4. MIDDLEWARE       — session auth + role guards
 *   5. APP / ROUTES    — Auth routes, then Volunteer Management routes
 *
 * When the system moves to a real database, only section 1 changes.
 */

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const VALID_ROLES = ["Super Admin", "Project Manager", "Volunteer", "Donor", "Public Visitor"];

/* ============================================================
   1. CSV STORE — swap this section for a real database later
   ============================================================ */

const DATA_DIR = path.join(__dirname, "data");

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function csvParseLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// A generic CSV-backed "table" — readAll / appendRow / writeAll / updateWhere.
// Each real module (Volunteers, Donations, Beneficiaries...) gets one of these.
function makeCsvTable(fileName, headers) {
  const filePath = path.join(DATA_DIR, fileName);

  function ensure() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, headers.join(",") + "\n", "utf8");
  }

  function readAll() {
    ensure();
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return [];
    return lines.slice(1).map((line) => {
      const fields = csvParseLine(line);
      const row = {};
      headers.forEach((h, i) => (row[h] = fields[i] ?? ""));
      return row;
    });
  }

  function writeAll(rows) {
    ensure();
    const body = rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")).join("\n");
    fs.writeFileSync(filePath, headers.join(",") + "\n" + (body ? body + "\n" : ""), "utf8");
  }

  let writeQueue = Promise.resolve();
  function appendRow(row) {
    ensure();
    writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
      const line = headers.map((h) => csvEscape(row[h])).join(",") + "\n";
      fs.appendFile(filePath, line, "utf8", (err) => (err ? reject(err) : resolve()));
    }));
    return writeQueue;
  }

  function updateWhere(predicate, updater) {
    const rows = readAll();
    let changed = false;
    const next = rows.map((row) => {
      if (predicate(row)) { changed = true; return { ...row, ...updater(row) }; }
      return row;
    });
    if (changed) writeAll(next);
    return changed;
  }

  return { ensure, readAll, writeAll, appendRow, updateWhere, filePath };
}

const usersTable = makeCsvTable("users.csv", ["id", "name", "email", "passwordHash", "role", "createdAt"]);
const volunteersTable = makeCsvTable("volunteers.csv", ["volunteerId", "skills", "verifiedStatus", "updatedAt"]);
const hoursTable = makeCsvTable("volunteer_hours.csv", ["id", "volunteerId", "taskName", "hoursLogged", "dateLogged", "status", "approvedBy", "approvedAt"]);

// ---- Users ----
function findUserByEmail(email) {
  const target = String(email).trim().toLowerCase();
  return usersTable.readAll().find((u) => u.email.trim().toLowerCase() === target);
}
function findUserById(id) {
  return usersTable.readAll().find((u) => u.id === id);
}
function appendUser(user) {
  return usersTable.appendRow(user);
}

// ---- Volunteers ----
function findVolunteerByUserId(userId) {
  return volunteersTable.readAll().find((v) => v.volunteerId === userId);
}
function upsertVolunteerSkills(userId, skills) {
  const existing = findVolunteerByUserId(userId);
  const now = new Date().toISOString();
  if (existing) {
    volunteersTable.updateWhere((v) => v.volunteerId === userId, () => ({ skills, updatedAt: now }));
  } else {
    volunteersTable.appendRow({ volunteerId: userId, skills, verifiedStatus: "Pending", updatedAt: now });
  }
}
function setVolunteerVerified(userId, verified) {
  volunteersTable.updateWhere(
    (v) => v.volunteerId === userId,
    () => ({ verifiedStatus: verified ? "Verified" : "Pending", updatedAt: new Date().toISOString() })
  );
}
// Joins volunteer rows with user name/email, optionally filtered by a skill substring.
function listVolunteers(skillFilter) {
  const users = usersTable.readAll();
  const volunteers = volunteersTable.readAll();
  const usersByRole = users.filter((u) => u.role === "Volunteer");

  const rows = usersByRole.map((u) => {
    const v = volunteers.find((row) => row.volunteerId === u.id);
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      skills: v ? v.skills : "",
      verifiedStatus: v ? v.verifiedStatus : "Pending",
    };
  });

  if (!skillFilter) return rows;
  const needle = skillFilter.trim().toLowerCase();
  return rows.filter((r) => r.skills.toLowerCase().includes(needle));
}

// ---- Volunteer hours ----
function logHours(volunteerId, taskName, hoursLogged) {
  return hoursTable.appendRow({
    id: crypto.randomUUID(),
    volunteerId,
    taskName,
    hoursLogged: String(hoursLogged),
    dateLogged: new Date().toISOString(),
    status: "Pending",
    approvedBy: "",
    approvedAt: "",
  });
}
function listHoursForVolunteer(volunteerId) {
  return hoursTable.readAll()
    .filter((h) => h.volunteerId === volunteerId)
    .sort((a, b) => new Date(b.dateLogged) - new Date(a.dateLogged));
}
function listPendingHours() {
  const users = usersTable.readAll();
  return hoursTable.readAll()
    .filter((h) => h.status === "Pending")
    .map((h) => {
      const user = users.find((u) => u.id === h.volunteerId);
      return { ...h, volunteerName: user ? user.name : "Unknown", volunteerEmail: user ? user.email : "" };
    })
    .sort((a, b) => new Date(a.dateLogged) - new Date(b.dateLogged));
}
function setHourStatus(hourId, status, approverEmail) {
  hoursTable.updateWhere(
    (h) => h.id === hourId,
    () => ({ status, approvedBy: approverEmail, approvedAt: new Date().toISOString() })
  );
}

/* ============================================================
   2. SHARED CSS
   ============================================================ */

const SHARED_CSS = `
:root{
  --navy:#05374D; --navy-2:#072F42; --teal:#028090; --seafoam:#00A896; --mint:#02C39A;
  --ink:#12262B; --muted:#5B7373; --muted-2:#8FA6A6; --bg:#F1F7F6; --white:#FFFFFF;
  --danger:#B3261E; --danger-bg:#FCEEEC; --success-bg:#E8F6F3; --warn-bg:#FFF4E0; --warn-ink:#8A5A00; --ring: rgba(2,128,144,0.35);
  --font-head: Cambria, "Times New Roman", Georgia, serif;
  --font-body: Calibri, "Segoe UI", Arial, sans-serif;
}
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; }
body{ font-family: var(--font-body); background: var(--bg); color: var(--ink); min-height:100vh;
  display:flex; align-items:center; justify-content:center; padding: 24px; }
.shell{ width:100%; max-width: 1000px; min-height: 600px; background: var(--white); border-radius: 16px;
  box-shadow: 0 24px 48px -20px rgba(5,55,77,0.30), 0 2px 10px rgba(5,55,77,0.06);
  display:flex; flex-direction:row; overflow:hidden; }
.brand{ position:relative; flex: 1 1 0; min-width: 0;
  background: linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 60%, #062A3A 100%);
  color: var(--white); padding: 44px 40px; display:flex; flex-direction:column;
  justify-content:space-between; overflow:hidden; }
.brand::before{ content:""; position:absolute; width: 300px; height:300px; border-radius:50%;
  background: radial-gradient(circle at 30% 30%, rgba(0,168,150,0.5), rgba(0,168,150,0) 70%);
  top:-130px; right:-110px; }
.brand-mark{ display:flex; align-items:center; gap:10px; margin-bottom: 36px; }
.brand-mark .glyph{ width:36px; height:36px; border-radius:10px; background: var(--teal);
  display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-right:10px; }
.brand-mark .glyph svg{ width:20px; height:20px; }
.brand-mark span{ font-family: var(--font-head); font-size: 16.5px; font-weight:700; }
.brand h1{ font-family: var(--font-head); font-size: 28px; line-height:1.28; margin: 0 0 12px 0;
  font-weight: 700; max-width: 340px; position:relative; z-index:2; }
.brand p.lede{ font-size: 13.5px; line-height:1.6; color: #CFE3E0; max-width: 320px; margin:0;
  position:relative; z-index:2; }
.snapshot{ position:relative; z-index:2; margin-top: 32px; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 16px 18px; }
.snapshot-head{ display:flex; align-items:center; gap:8px; margin-bottom: 12px; }
.snapshot-dot{ width:6px; height:6px; border-radius:50%; background: var(--mint); animation: pulse 2.2s infinite; }
@keyframes pulse{ 0%{ box-shadow: 0 0 0 0 rgba(2,195,154,0.55); } 70%{ box-shadow: 0 0 0 7px rgba(2,195,154,0); } 100%{ box-shadow: 0 0 0 0 rgba(2,195,154,0); } }
.snapshot-head span{ font-size: 10.5px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:#AFC9C6; }
.snapshot-grid{ display:grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.stat b{ display:block; font-family: var(--font-head); font-size: 19px; color:#fff; font-variant-numeric: tabular-nums; }
.stat span{ display:block; font-size: 10px; color:#9FC0BC; margin-top:2px; line-height:1.3; }
.auth{ flex: 1 1 0; min-width: 0; padding: 44px 44px; display:flex; flex-direction:column; justify-content:center; }
.auth-inner{ width:100%; max-width: 340px; margin: 0 auto; }
.auth h2{ font-family: var(--font-head); font-size: 23px; margin: 0 0 6px 0; color: var(--navy); }
.auth p.sub{ margin:0 0 22px 0; font-size: 13px; color: var(--muted); line-height:1.5; }
form{ display:flex; flex-direction:column; gap: 14px; }
.field{ display:flex; flex-direction:column; gap:6px; }
.field label{ font-size: 12.5px; font-weight:700; color: var(--navy); }
.input-wrap{ position:relative; }
.field input, .field select{ width:100%; padding: 11px 13px; font-size: 14px; font-family: var(--font-body);
  border: 1.5px solid #DDE9E7; border-radius: 8px; background: #FBFDFD; color: var(--ink);
  transition: border-color .15s ease, background .15s ease; }
.field select{ appearance: none; -webkit-appearance:none;
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%235B7373" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>');
  background-repeat:no-repeat; background-position: right 12px center; padding-right: 36px; }
.field input::placeholder{ color: var(--muted-2); }
.field input:focus, .field select:focus{ border-color: var(--teal); background: #fff; outline:none; }
.field.has-error input{ border-color: var(--danger); background: var(--danger-bg); }
.error-msg{ font-size: 11.5px; color: var(--danger); min-height: 14px; display:none; }
.field.has-error .error-msg{ display:block; }
.icon-btn{ position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none;
  cursor:pointer; width:28px; height:28px; display:flex; align-items:center; justify-content:center;
  border-radius:7px; color: var(--muted); }
.icon-btn:hover{ color: var(--teal); background: var(--bg); }
.icon-btn svg{ width:17px; height:17px; }
.row-between{ display:flex; align-items:center; justify-content:space-between; margin-top: -2px; }
.checkbox{ display:flex; align-items:center; gap:7px; font-size: 12.5px; color: var(--muted); cursor:pointer; user-select:none; }
.checkbox input{ position:absolute; opacity:0; width:16px; height:16px; }
.checkbox .box{ width:15px; height:15px; border-radius:4px; border:1.5px solid #C9DBD8; background:#fff;
  display:inline-flex; align-items:center; justify-content:center; transition: all .15s ease; flex-shrink:0; }
.checkbox input:checked + .box{ background: var(--teal); border-color: var(--teal); }
.checkbox .box svg{ width:10px; height:10px; opacity:0; transition:opacity .1s; }
.checkbox input:checked + .box svg{ opacity:1; }
.link{ font-size: 12.5px; color: var(--teal); font-weight:700; text-decoration:none; background:none;
  border:none; cursor:pointer; padding:2px; }
.link:hover{ color: var(--navy); text-decoration:underline; }
.btn-primary{ margin-top: 4px; width:100%; padding: 12px 16px; background: var(--teal); color:#fff; border:none;
  border-radius: 8px; font-family: var(--font-body); font-size: 14px; font-weight:700; cursor:pointer;
  display:flex; align-items:center; justify-content:center; gap:9px; transition: background .15s ease, transform .05s ease;
  text-decoration:none; }
.btn-primary:hover{ background: #026a77; }
.btn-primary:active{ transform: translateY(1px); }
.btn-primary:disabled{ opacity:0.85; cursor:progress; }
.spinner{ width:15px; height:15px; border-radius:50%; border: 2.5px solid rgba(255,255,255,0.35);
  border-top-color:#fff; animation: spin .7s linear infinite; display:none; }
@keyframes spin{ to{ transform: rotate(360deg); } }
.btn-primary.loading .spinner{ display:inline-block; }
.btn-primary.loading .btn-label{ opacity:0.85; }
.banner{ font-size: 12.5px; border-radius: 8px; padding: 10px 12px; display:none; line-height:1.5; }
.banner.show{ display:block; }
.banner.error{ background: var(--danger-bg); color: var(--danger); }
.banner.success{ background: var(--success-bg); color: #036B57; }
.foot-link{ margin-top: 20px; text-align:center; font-size: 13px; color: var(--muted); }
@media (prefers-reduced-motion: reduce){ .snapshot-dot, .spinner{ animation:none; } }
@media (max-width: 820px){ .shell{ flex-direction: column; min-height:auto; } .brand{ padding: 32px 28px; }
  .brand h1{ font-size: 23px; max-width:none; } .auth{ padding: 32px 28px 36px; } }
@media (max-width: 420px){ body{ padding:0; } .shell{ border-radius:0; box-shadow:none; } }

/* app-shell pages (dashboard, volunteer profile, admin) */
body.app-body{ display:block; padding:0; }
.topbar{ display:flex; align-items:center; justify-content:space-between; padding: 16px 32px;
  background: var(--white); border-bottom: 1px solid #E4EEEC; }
.topbar .brand-mark{ margin:0; }
.topbar .brand-mark .glyph{ width:32px; height:32px; border-radius:9px; }
.topbar .brand-mark .glyph svg{ width:18px; height:18px; }
.topbar .brand-mark span{ font-size:15px; color:var(--navy); }
.topbar-right{ display:flex; align-items:center; gap:14px; }
.topbar-link{ font-size:13px; font-weight:700; color:var(--muted); text-decoration:none; }
.topbar-link:hover{ color:var(--teal); }
.btn-ghost{ background:none; border:1.5px solid #DDE9E7; color:var(--muted); padding:8px 14px;
  border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; font-family:var(--font-body); }
.btn-ghost:hover{ border-color:var(--teal); color:var(--teal); }
.page{ max-width: 860px; margin: 0 auto; padding: 48px 24px 64px; }
.page h1{ font-family: var(--font-head); font-size:26px; color:var(--navy); margin:0 0 6px 0; }
.page p.lede{ color:var(--muted); font-size:14px; margin:0 0 28px 0; }
.card{ background:#fff; border:1px solid #E4EEEC; border-radius:12px; padding:22px 24px; }
.card + .card{ margin-top:20px; }
.card dl{ margin:0; display:grid; grid-template-columns: 140px 1fr; row-gap:12px; }
.card dt{ font-size:12.5px; font-weight:700; color:var(--muted); }
.card dd{ font-size:14px; color:var(--ink); margin:0; }
.card h3{ margin:0 0 4px 0; font-family:var(--font-head); font-size:16px; color:var(--navy); }
.card p.card-sub{ margin:0 0 16px 0; font-size:12.5px; color:var(--muted); }
.role-badge{ display:inline-block; padding:3px 10px; border-radius:999px; background: var(--success-bg);
  color:#036B57; font-size:12px; font-weight:700; }
.quick-actions{ display:flex; gap:10px; flex-wrap:wrap; }
.quick-actions a.btn-primary{ width:auto; padding:10px 18px; }

/* tables + badges (Volunteer Management and beyond) */
.table-wrap{ overflow-x:auto; }
.table{ width:100%; border-collapse:collapse; font-size:13px; }
.table th{ text-align:left; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase;
  letter-spacing:0.4px; padding:8px 10px; border-bottom:1.5px solid #E4EEEC; white-space:nowrap; }
.table td{ padding:10px; border-bottom:1px solid #EEF4F3; color:var(--ink); vertical-align:middle; }
.table tr:last-child td{ border-bottom:none; }
.badge{ display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap; }
.badge-verified{ background:var(--success-bg); color:#036B57; }
.badge-pending{ background:var(--warn-bg); color:var(--warn-ink); }
.badge-approved{ background:var(--success-bg); color:#036B57; }
.badge-rejected{ background:var(--danger-bg); color:var(--danger); }
.btn-small{ padding:6px 12px; font-size:12px; border-radius:6px; border:1.5px solid #DDE9E7; background:#fff;
  color:var(--muted); cursor:pointer; font-weight:700; font-family:var(--font-body); }
.btn-small:hover{ border-color:var(--teal); color:var(--teal); }
.btn-small.primary{ background:var(--teal); border-color:var(--teal); color:#fff; }
.btn-small.primary:hover{ background:#026a77; color:#fff; }
.btn-small.danger{ border-color:var(--danger); color:var(--danger); }
.btn-small.danger:hover{ background:var(--danger-bg); }
.inline-form{ display:inline; }
.search-row{ display:flex; flex-direction:row; align-items:center; gap:8px; margin-bottom:16px; }
.search-input{ padding:9px 12px; border:1.5px solid #DDE9E7; border-radius:8px; font-size:13px; width:220px;
  font-family:var(--font-body); }
.skill-tag{ display:inline-block; background:var(--bg); color:var(--teal); padding:2px 8px; border-radius:6px;
  font-size:11px; font-weight:700; margin:1px 3px 1px 0; }
.empty-state{ padding:28px; text-align:center; color:var(--muted); font-size:13px; }
.hint-text{ font-size:11.5px; color:var(--muted); margin-top:-6px; }
`;

const HEART_GLYPH = `<span class="glyph"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 21s-7.5-4.6-10-9.3C0.3 8.1 2 4.5 5.4 4c2-.3 3.7.6 4.9 2.1L12 8l1.7-1.9C15 4.6 16.7 3.7 18.6 4c3.4.5 5.1 4.1 3.4 7.7C19.5 16.4 12 21 12 21z" fill="#fff"/></svg></span>`;

const SNAPSHOT_HTML = `
  <div class="snapshot">
    <div class="snapshot-head"><span class="snapshot-dot"></span><span>Live transparency snapshot</span></div>
    <div class="snapshot-grid">
      <div class="stat"><b>₹18.4L</b><span>Raised this quarter</span></div>
      <div class="stat"><b>312</b><span>Active volunteers</span></div>
      <div class="stat"><b>1,204</b><span>Beneficiaries aided</span></div>
    </div>
  </div>`;

function topbar(activeLabel) {
  return `
  <div class="topbar">
    <div class="brand-mark">${HEART_GLYPH}<span>NGO Management System</span></div>
    <div class="topbar-right">
      <a class="topbar-link" href="/dashboard">Dashboard</a>
      <button class="btn-ghost" id="logoutBtn">Sign out</button>
    </div>
  </div>`;
}

const LOGOUT_SCRIPT = `
<script>
document.getElementById('logoutBtn').addEventListener('click', function(){
  fetch('/api/logout', { method: 'POST' }).then(function(){ window.location.href = '/login'; });
});
</script>`;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ============================================================
   3. PAGE TEMPLATES
   ============================================================ */

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sign In · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="shell">
  <aside class="brand">
    <div>
      <div class="brand-mark">${HEART_GLYPH}<span>NGO Management System</span></div>
      <h1>Manage volunteers, donations, and programs in one place.</h1>
      <p class="lede">Sign in to your account to continue.</p>
    </div>
    ${SNAPSHOT_HTML}
  </aside>
  <section class="auth">
    <div class="auth-inner">
      <h2>Sign in</h2>
      <p class="sub">Welcome back. Enter your details to continue.</p>
      <div class="banner error" id="banner"></div>
      <form id="loginForm" novalidate>
        <div class="field" id="emailField">
          <label for="email">Email address</label>
          <input type="text" id="email" name="email" placeholder="you@organization.org" autocomplete="username" />
          <span class="error-msg" id="emailError">Enter a valid email address.</span>
        </div>
        <div class="field" id="passwordField">
          <label for="password">Password</label>
          <div class="input-wrap">
            <input type="password" id="password" name="password" placeholder="Enter your password" autocomplete="current-password" />
            <button type="button" class="icon-btn" id="togglePassword" aria-label="Show password">
              <svg id="eyeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
          <span class="error-msg" id="passwordError">Enter your password.</span>
        </div>
        <div class="row-between">
          <label class="checkbox">
            <input type="checkbox" id="remember" />
            <span class="box"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
            Remember me
          </label>
          <a class="link" href="#" id="forgotBtn">Forgot password?</a>
        </div>
        <button type="submit" class="btn-primary" id="submitBtn">
          <span class="spinner"></span><span class="btn-label">Sign in</span>
        </button>
      </form>
      <p class="foot-link">Don't have an account? <a class="link" href="/register">Create one</a></p>
    </div>
  </section>
</div>
<script>
(function(){
  var form = document.getElementById('loginForm');
  var emailField = document.getElementById('emailField');
  var emailInput = document.getElementById('email');
  var passwordField = document.getElementById('passwordField');
  var passwordInput = document.getElementById('password');
  var submitBtn = document.getElementById('submitBtn');
  var banner = document.getElementById('banner');

  function isValidEmail(v){ return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v.trim()); }
  function setError(field, hasError){ field.classList.toggle('has-error', hasError); }
  function showBanner(message){ banner.textContent = message; banner.classList.add('show'); }
  function hideBanner(){ banner.classList.remove('show'); }

  document.getElementById('togglePassword').addEventListener('click', function(){
    var eyeIcon = document.getElementById('eyeIcon');
    var isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    eyeIcon.innerHTML = isHidden
      ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.4 21.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.4 21.4 0 0 1-3.54 4.5M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>'
      : '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>';
  });

  emailInput.addEventListener('input', function(){ if (isValidEmail(emailInput.value)) setError(emailField, false); });
  passwordInput.addEventListener('input', function(){ if (passwordInput.value.length > 0) setError(passwordField, false); });

  document.getElementById('forgotBtn').addEventListener('click', function(e){
    e.preventDefault();
    hideBanner();
    banner.classList.remove('error');
    banner.classList.add('success', 'show');
    banner.textContent = 'If an account exists for that email, a reset link has been sent.';
  });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    hideBanner();
    banner.classList.remove('success');
    banner.classList.add('error');

    var emailOk = isValidEmail(emailInput.value);
    var pwOk = passwordInput.value.length > 0;
    setError(emailField, !emailOk);
    setError(passwordField, !pwOk);
    if (!emailOk) { emailInput.focus(); return; }
    if (!pwOk) { passwordInput.focus(); return; }

    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        password: passwordInput.value,
        remember: document.getElementById('remember').checked
      })
    }).then(function(res){
      return res.json().then(function(data){ return { ok: res.ok, data: data }; });
    }).then(function(result){
      if (!result.ok) {
        showBanner(result.data.error || 'Unable to sign in. Please try again.');
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
        return;
      }
      window.location.href = '/dashboard';
    }).catch(function(){
      showBanner('Could not reach the server. Please try again.');
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}

function registerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Create Account · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="shell">
  <aside class="brand">
    <div>
      <div class="brand-mark">${HEART_GLYPH}<span>NGO Management System</span></div>
      <h1>Join the platform that keeps every rupee accountable.</h1>
      <p class="lede">Create an account to volunteer, donate, or track programs.</p>
    </div>
    ${SNAPSHOT_HTML}
  </aside>
  <section class="auth">
    <div class="auth-inner">
      <h2>Create your account</h2>
      <p class="sub">It only takes a minute.</p>
      <div class="banner error" id="banner"></div>
      <form id="registerForm" novalidate>
        <div class="field" id="nameField">
          <label for="name">Full name</label>
          <input type="text" id="name" name="name" placeholder="Jane Doe" autocomplete="name" />
          <span class="error-msg" id="nameError">Enter your full name.</span>
        </div>
        <div class="field" id="emailField">
          <label for="email">Email address</label>
          <input type="text" id="email" name="email" placeholder="you@organization.org" autocomplete="username" />
          <span class="error-msg" id="emailError">Enter a valid email address.</span>
        </div>
        <div class="field" id="roleField">
          <label for="role">I am registering as</label>
          <select id="role" name="role">
            <option value="" disabled selected>Select a role</option>
            <option value="Volunteer">Volunteer</option>
            <option value="Donor">Donor</option>
            <option value="Public Visitor">Public Visitor</option>
            <option value="Project Manager">Project Manager</option>
            <option value="Super Admin">Super Admin</option>
          </select>
          <span class="error-msg" id="roleError">Select a role.</span>
        </div>
        <div class="field" id="passwordField">
          <label for="password">Password</label>
          <div class="input-wrap">
            <input type="password" id="password" name="password" placeholder="At least 8 characters" autocomplete="new-password" />
            <button type="button" class="icon-btn" id="togglePassword" aria-label="Show password">
              <svg id="eyeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
          <span class="error-msg" id="passwordError">Password must be at least 8 characters.</span>
        </div>
        <div class="field" id="confirmField">
          <label for="confirmPassword">Confirm password</label>
          <input type="password" id="confirmPassword" name="confirmPassword" placeholder="Re-enter your password" autocomplete="new-password" />
          <span class="error-msg" id="confirmError">Passwords do not match.</span>
        </div>
        <button type="submit" class="btn-primary" id="submitBtn">
          <span class="spinner"></span><span class="btn-label">Create account</span>
        </button>
      </form>
      <p class="foot-link">Already have an account? <a class="link" href="/login">Sign in</a></p>
    </div>
  </section>
</div>
<script>
(function(){
  var form = document.getElementById('registerForm');
  var nameField = document.getElementById('nameField');
  var nameInput = document.getElementById('name');
  var emailField = document.getElementById('emailField');
  var emailInput = document.getElementById('email');
  var roleField = document.getElementById('roleField');
  var roleInput = document.getElementById('role');
  var passwordField = document.getElementById('passwordField');
  var passwordInput = document.getElementById('password');
  var confirmField = document.getElementById('confirmField');
  var confirmInput = document.getElementById('confirmPassword');
  var submitBtn = document.getElementById('submitBtn');
  var banner = document.getElementById('banner');

  function isValidEmail(v){ return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v.trim()); }
  function setError(field, hasError){ field.classList.toggle('has-error', hasError); }
  function showBanner(message){ banner.textContent = message; banner.classList.remove('success'); banner.classList.add('error','show'); }
  function hideBanner(){ banner.classList.remove('show'); }

  document.getElementById('togglePassword').addEventListener('click', function(){
    var eyeIcon = document.getElementById('eyeIcon');
    var isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    eyeIcon.innerHTML = isHidden
      ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.4 21.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.4 21.4 0 0 1-3.54 4.5M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>'
      : '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>';
  });

  nameInput.addEventListener('input', function(){ if (nameInput.value.trim()) setError(nameField, false); });
  emailInput.addEventListener('input', function(){ if (isValidEmail(emailInput.value)) setError(emailField, false); });
  roleInput.addEventListener('change', function(){ if (roleInput.value) setError(roleField, false); });
  passwordInput.addEventListener('input', function(){ if (passwordInput.value.length >= 8) setError(passwordField, false); });
  confirmInput.addEventListener('input', function(){ if (confirmInput.value === passwordInput.value && confirmInput.value.length > 0) setError(confirmField, false); });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    hideBanner();

    var nameOk = nameInput.value.trim().length > 0;
    var emailOk = isValidEmail(emailInput.value);
    var roleOk = !!roleInput.value;
    var pwOk = passwordInput.value.length >= 8;
    var confirmOk = confirmInput.value === passwordInput.value && confirmInput.value.length > 0;

    setError(nameField, !nameOk);
    setError(emailField, !emailOk);
    setError(roleField, !roleOk);
    setError(passwordField, !pwOk);
    setError(confirmField, !confirmOk);

    if (!nameOk) { nameInput.focus(); return; }
    if (!emailOk) { emailInput.focus(); return; }
    if (!roleOk) { roleInput.focus(); return; }
    if (!pwOk) { passwordInput.focus(); return; }
    if (!confirmOk) { confirmInput.focus(); return; }

    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        password: passwordInput.value,
        confirmPassword: confirmInput.value,
        role: roleInput.value
      })
    }).then(function(res){
      return res.json().then(function(data){ return { ok: res.ok, data: data }; });
    }).then(function(result){
      if (!result.ok) {
        showBanner(result.data.error || 'Unable to create account. Please try again.');
        submitBtn.classList.remove('loading');
        submitBtn.disabled = false;
        return;
      }
      window.location.href = '/dashboard';
    }).catch(function(){
      showBanner('Could not reach the server. Please try again.');
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`;
}

function dashboardPage(user) {
  const isVolunteer = user.role === "Volunteer";
  const isManager = user.role === "Project Manager" || user.role === "Super Admin";

  let actions = "";
  if (isVolunteer) {
    actions += `<a class="btn-primary" href="/volunteer/profile">Go to volunteer profile</a>`;
  }
  if (isManager) {
    actions += `<a class="btn-primary" href="/volunteers">Manage volunteers</a>`;
  }
  if (!actions) {
    actions = `<p class="hint-text">No modules are available for your role yet.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Dashboard · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body class="app-body">
  ${topbar()}
  <div class="page">
    <h1>Welcome, ${escapeHtml(user.name.split(" ")[0])}</h1>
    <p class="lede">You're signed in. Here's what's on file for your account.</p>

    <div class="card">
      <dl>
        <dt>Name</dt><dd>${escapeHtml(user.name)}</dd>
        <dt>Email</dt><dd>${escapeHtml(user.email)}</dd>
        <dt>Role</dt><dd><span class="role-badge">${escapeHtml(user.role)}</span></dd>
      </dl>
    </div>

    <div class="card">
      <h3>Quick actions</h3>
      <p class="card-sub">Jump into the module for your role.</p>
      <div class="quick-actions">${actions}</div>
    </div>
  </div>
${LOGOUT_SCRIPT}
</body>
</html>`;
}

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body class="app-body">
  ${topbar()}
  <div class="page">
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(message)}</p>
    <a class="btn-primary" href="/dashboard" style="width:auto;display:inline-flex;align-self:flex-start;padding:10px 18px;">Back to dashboard</a>
  </div>
${LOGOUT_SCRIPT}
</body>
</html>`;
}

function volunteerProfilePage(user, volunteerRecord, hourLogs) {
  const skills = volunteerRecord ? volunteerRecord.skills : "";
  const verified = volunteerRecord && volunteerRecord.verifiedStatus === "Verified";
  const skillTags = skills
    ? skills.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")
    : `<span class="hint-text">No skills on file yet.</span>`;

  const rows = hourLogs.length
    ? hourLogs.map((h) => `
        <tr>
          <td>${escapeHtml(h.taskName)}</td>
          <td>${escapeHtml(h.hoursLogged)}</td>
          <td>${escapeHtml(new Date(h.dateLogged).toLocaleDateString())}</td>
          <td><span class="badge badge-${h.status.toLowerCase()}">${escapeHtml(h.status)}</span></td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="empty-state">No hours logged yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Volunteer Profile · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body class="app-body">
  ${topbar()}
  <div class="page">
    <h1>Your volunteer profile</h1>
    <p class="lede">Keep your skills up to date and log the hours you've put in.</p>

    <div class="card">
      <dl>
        <dt>Name</dt><dd>${escapeHtml(user.name)}</dd>
        <dt>Email</dt><dd>${escapeHtml(user.email)}</dd>
        <dt>Status</dt><dd><span class="badge ${verified ? "badge-verified" : "badge-pending"}">${verified ? "Verified" : "Pending verification"}</span></dd>
        <dt>Skills</dt><dd>${skillTags}</dd>
      </dl>
    </div>

    <div class="card">
      <h3>Update your skills</h3>
      <p class="card-sub">Separate each skill with a comma — this is what project managers search by.</p>
      <form method="POST" action="/volunteer/skills">
        <div class="field">
          <label for="skills">Skills</label>
          <input type="text" id="skills" name="skills" placeholder="First aid, Event coordination, Teaching" value="${escapeHtml(skills)}" />
        </div>
        <button type="submit" class="btn-primary" style="width:auto;align-self:flex-start;padding:10px 18px;">Save skills</button>
      </form>
    </div>

    <div class="card">
      <h3>Log hours</h3>
      <p class="card-sub">Submitted hours are reviewed by a project manager before they're approved.</p>
      <form method="POST" action="/volunteer/hours">
        <div class="field">
          <label for="taskName">Task</label>
          <input type="text" id="taskName" name="taskName" placeholder="Flood relief distribution" required />
        </div>
        <div class="field">
          <label for="hoursLogged">Hours</label>
          <input type="number" id="hoursLogged" name="hoursLogged" min="0.5" step="0.5" placeholder="3" required />
        </div>
        <button type="submit" class="btn-primary" style="width:auto;align-self:flex-start;padding:10px 18px;">Log hours</button>
      </form>
    </div>

    <div class="card">
      <h3>Your hour history</h3>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Task</th><th>Hours</th><th>Date</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>
${LOGOUT_SCRIPT}
</body>
</html>`;
}

function volunteersAdminPage(user, volunteers, pendingHours, skillFilter) {
  const volunteerRows = volunteers.length
    ? volunteers.map((v) => {
        const skillTags = v.skills
          ? v.skills.split(",").map((s) => s.trim()).filter(Boolean)
            .map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")
          : `<span class="hint-text">—</span>`;
        const verified = v.verifiedStatus === "Verified";
        return `
        <tr>
          <td>${escapeHtml(v.name)}</td>
          <td>${escapeHtml(v.email)}</td>
          <td>${skillTags}</td>
          <td><span class="badge ${verified ? "badge-verified" : "badge-pending"}">${verified ? "Verified" : "Pending"}</span></td>
          <td>
            <form class="inline-form" method="POST" action="/volunteers/${encodeURIComponent(v.userId)}/${verified ? "unverify" : "verify"}">
              <button type="submit" class="btn-small ${verified ? "" : "primary"}">${verified ? "Unverify" : "Verify"}</button>
            </form>
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5" class="empty-state">No volunteers match this search.</td></tr>`;

  const hourRows = pendingHours.length
    ? pendingHours.map((h) => `
        <tr>
          <td>${escapeHtml(h.volunteerName)}</td>
          <td>${escapeHtml(h.taskName)}</td>
          <td>${escapeHtml(h.hoursLogged)}</td>
          <td>${escapeHtml(new Date(h.dateLogged).toLocaleDateString())}</td>
          <td>
            <form class="inline-form" method="POST" action="/hours/${encodeURIComponent(h.id)}/approve">
              <button type="submit" class="btn-small primary">Approve</button>
            </form>
            <form class="inline-form" method="POST" action="/hours/${encodeURIComponent(h.id)}/reject">
              <button type="submit" class="btn-small danger">Reject</button>
            </form>
          </td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="empty-state">No hours awaiting approval.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Manage Volunteers · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body class="app-body">
  ${topbar()}
  <div class="page">
    <h1>Manage volunteers</h1>
    <p class="lede">Search by skill, verify volunteers, and approve logged hours.</p>

    <div class="card">
      <h3>All volunteers</h3>
      <p class="card-sub">Search matches against each volunteer's listed skills.</p>
      <form class="search-row" method="GET" action="/volunteers">
        <input type="text" class="search-input" name="skill" placeholder="Search by skill, e.g. First aid" value="${escapeHtml(skillFilter || "")}" />
        <button type="submit" class="btn-small primary">Search</button>
        ${skillFilter ? `<a class="btn-small" href="/volunteers">Clear</a>` : ""}
      </form>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Skills</th><th>Status</th><th></th></tr></thead>
          <tbody>${volunteerRows}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>Pending hour approvals</h3>
      <p class="card-sub">Approve or reject hours volunteers have logged.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Volunteer</th><th>Task</th><th>Hours</th><th>Date</th><th></th></tr></thead>
          <tbody>${hourRows}</tbody>
        </table>
      </div>
    </div>
  </div>
${LOGOUT_SCRIPT}
</body>
</html>`;
}

/* ============================================================
   4. MIDDLEWARE
   ============================================================ */

function requireAuth(req, res, next) {
  if (!req.session.userEmail) return res.redirect("/login");
  const user = findUserByEmail(req.session.userEmail);
  if (!user) return res.redirect("/login");
  req.currentUser = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.currentUser.role)) {
      return res.status(403).type("html").send(
        errorPage("Access denied", "You don't have permission to view this page.")
      );
    }
    next();
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

/* ============================================================
   5. APP / ROUTES
   ============================================================ */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: "ngo.sid",
  secret: "ngo-management-system-demo-secret", // demo only — move to env var in production
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
}));

/* ---------- Auth: pages ---------- */
app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.type("html").send(loginPage()));
app.get("/register", (req, res) => res.type("html").send(registerPage()));
app.get("/dashboard", requireAuth, (req, res) => res.type("html").send(dashboardPage(req.currentUser)));

/* ---------- Auth: API ---------- */
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, confirmPassword, role } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Full name is required." });
    if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "Select a valid role." });

    if (findUserByEmail(email)) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role,
      createdAt: new Date().toISOString(),
    };
    await appendUser(user);

    req.session.userEmail = user.email;
    return res.status(201).json({
      message: "Account created successfully.",
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password, remember } = req.body || {};
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: "Enter a valid email and password." });
    }
    const user = findUserByEmail(email);
    if (!user) return res.status(401).json({ error: "Incorrect email or password." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Incorrect email or password." });

    req.session.userEmail = user.email;
    if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;

    return res.json({
      message: "Signed in successfully.",
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.userEmail) return res.status(401).json({ error: "Not signed in." });
  const user = findUserByEmail(req.session.userEmail);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  return res.json({ user: { name: user.name, email: user.email, role: user.role } });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ngo.sid");
    res.json({ message: "Signed out." });
  });
});

/* ---------- Volunteer Management: self-service (role: Volunteer) ---------- */

app.get("/volunteer/profile", requireAuth, requireRole("Volunteer"), (req, res) => {
  const volunteerRecord = findVolunteerByUserId(req.currentUser.id);
  const hourLogs = listHoursForVolunteer(req.currentUser.id);
  res.type("html").send(volunteerProfilePage(req.currentUser, volunteerRecord, hourLogs));
});

app.post("/volunteer/skills", requireAuth, requireRole("Volunteer"), (req, res) => {
  const skills = String(req.body.skills || "").trim();
  upsertVolunteerSkills(req.currentUser.id, skills);
  res.redirect("/volunteer/profile");
});

app.post("/volunteer/hours", requireAuth, requireRole("Volunteer"), (req, res) => {
  const taskName = String(req.body.taskName || "").trim();
  const hoursLogged = parseFloat(req.body.hoursLogged);
  if (taskName && hoursLogged > 0) {
    logHours(req.currentUser.id, taskName, hoursLogged);
  }
  res.redirect("/volunteer/profile");
});

/* ---------- Volunteer Management: admin (role: Project Manager, Super Admin) ---------- */

app.get("/volunteers", requireAuth, requireRole("Project Manager", "Super Admin"), (req, res) => {
  const skillFilter = req.query.skill ? String(req.query.skill) : "";
  const volunteers = listVolunteers(skillFilter);
  const pendingHours = listPendingHours();
  res.type("html").send(volunteersAdminPage(req.currentUser, volunteers, pendingHours, skillFilter));
});

app.post("/volunteers/:id/verify", requireAuth, requireRole("Project Manager", "Super Admin"), (req, res) => {
  setVolunteerVerified(req.params.id, true);
  res.redirect("/volunteers");
});

app.post("/volunteers/:id/unverify", requireAuth, requireRole("Project Manager", "Super Admin"), (req, res) => {
  setVolunteerVerified(req.params.id, false);
  res.redirect("/volunteers");
});

app.post("/hours/:id/approve", requireAuth, requireRole("Project Manager", "Super Admin"), (req, res) => {
  setHourStatus(req.params.id, "Approved", req.currentUser.email);
  res.redirect("/volunteers");
});

app.post("/hours/:id/reject", requireAuth, requireRole("Project Manager", "Super Admin"), (req, res) => {
  setHourStatus(req.params.id, "Rejected", req.currentUser.email);
  res.redirect("/volunteers");
});

app.listen(PORT, () => {
  console.log(`NGO Management System running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/login to sign in.`);
  console.log(`Data is stored in the data/ folder (users.csv, volunteers.csv, volunteer_hours.csv)`);
});
