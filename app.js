/**
 * NGO Management System — Auth + Volunteer Management + Beneficiary Management
 * -------------------------------------------------------------------------
 * One file for application logic: Express server, and every page's
 * HTML/CSS/JS templated inline below. Storage lives in PostgreSQL —
 * see db.js (connection + auto-migration) and schema.sql (table definitions).
 *
 * Run it:
 *   npm install
 *   node app.js
 *   open http://localhost:3000/login
 *
 * (First-time setup — create the database once: see README.md)
 *
 * Modules in this file:
 *   1. DATABASE         — query functions built on db.js / schema.sql
 *   2. SHARED CSS        — one stylesheet, reused by every page
 *   3. PAGE TEMPLATES    — functions returning full HTML strings
 *   4. MIDDLEWARE        — session auth + role guards
 *   5. APP / ROUTES      — Auth, Volunteer Management, Beneficiary Management
 */

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { query, ensureSchema } = require("./db");

const PORT = process.env.PORT || 3000;
const VALID_ROLES = ["Super Admin", "Project Manager", "Volunteer", "Donor", "Public Visitor"];

/* ============================================================
   1. DATABASE — all SQL lives here. Swap this section again later
      (e.g. add caching, a different driver) without touching routes.
   ============================================================ */

// ---- Users ----
async function findUserByEmail(email) {
  const res = await query(
    `SELECT id, name, email, password_hash AS "passwordHash", role, created_at AS "createdAt"
     FROM users WHERE lower(email) = lower($1)`,
    [String(email).trim()]
  );
  return res.rows[0] || null;
}

async function findUserById(id) {
  const res = await query(
    `SELECT id, name, email, password_hash AS "passwordHash", role, created_at AS "createdAt"
     FROM users WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function createUser({ name, email, passwordHash, role }) {
  const res = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role, created_at AS "createdAt"`,
    [name, email.toLowerCase(), passwordHash, role]
  );
  return res.rows[0];
}

// ---- Volunteers (FR2) ----
async function findVolunteerByUserId(userId) {
  const res = await query(
    `SELECT volunteer_id AS "volunteerId", skills,
            CASE WHEN verified_status THEN 'Verified' ELSE 'Pending' END AS "verifiedStatus",
            updated_at AS "updatedAt"
     FROM volunteers WHERE volunteer_id = $1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function upsertVolunteerSkills(userId, skills) {
  await query(
    `INSERT INTO volunteers (volunteer_id, skills, verified_status, updated_at)
     VALUES ($1, $2, FALSE, now())
     ON CONFLICT (volunteer_id) DO UPDATE SET skills = EXCLUDED.skills, updated_at = now()`,
    [userId, skills]
  );
}

async function setVolunteerVerified(userId, verified) {
  await query(
    `UPDATE volunteers SET verified_status = $2, updated_at = now() WHERE volunteer_id = $1`,
    [userId, verified]
  );
}

async function listVolunteers(skillFilter) {
  const res = await query(
    `SELECT u.id AS "userId", u.name, u.email,
            COALESCE(v.skills, '') AS skills,
            CASE WHEN v.verified_status THEN 'Verified' ELSE 'Pending' END AS "verifiedStatus"
     FROM users u
     LEFT JOIN volunteers v ON v.volunteer_id = u.id
     WHERE u.role = 'Volunteer'
       AND ($1 = '' OR COALESCE(v.skills, '') ILIKE '%' || $1 || '%')
     ORDER BY u.name`,
    [skillFilter || ""]
  );
  return res.rows;
}

// ---- Volunteer hours (FR2) ----
async function logHours(volunteerId, taskName, hoursLogged) {
  await query(
    `INSERT INTO volunteer_hours (volunteer_id, task_name, hours_logged)
     VALUES ($1, $2, $3)`,
    [volunteerId, taskName, hoursLogged]
  );
}

async function listHoursForVolunteer(volunteerId) {
  const res = await query(
    `SELECT id, task_name AS "taskName", hours_logged AS "hoursLogged",
            date_logged AS "dateLogged", status
     FROM volunteer_hours WHERE volunteer_id = $1
     ORDER BY date_logged DESC`,
    [volunteerId]
  );
  return res.rows;
}

async function listPendingHours() {
  const res = await query(
    `SELECT h.id, h.task_name AS "taskName", h.hours_logged AS "hoursLogged", h.date_logged AS "dateLogged",
            u.name AS "volunteerName", u.email AS "volunteerEmail"
     FROM volunteer_hours h
     JOIN users u ON u.id = h.volunteer_id
     WHERE h.status = 'Pending'
     ORDER BY h.date_logged ASC`
  );
  return res.rows;
}

async function setHourStatus(hourId, status, approverEmail) {
  await query(
    `UPDATE volunteer_hours SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1`,
    [hourId, status, approverEmail]
  );
}

// ---- Beneficiaries (FR4) ----
async function findBeneficiaryByHash(uniqueGovHash) {
  const res = await query(
    `SELECT beneficiary_id AS "beneficiaryId" FROM beneficiaries WHERE unique_gov_hash = $1`,
    [uniqueGovHash]
  );
  return res.rows[0] || null;
}

async function createBeneficiary({ fullName, uniqueGovHash, location, supportReceived, createdBy }) {
  const res = await query(
    `INSERT INTO beneficiaries (full_name, unique_gov_hash, location, support_received, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING beneficiary_id AS "beneficiaryId"`,
    [fullName, uniqueGovHash, location, supportReceived || "", createdBy]
  );
  return res.rows[0];
}

async function listBeneficiaries(search) {
  const res = await query(
    `SELECT beneficiary_id AS "beneficiaryId", full_name AS "fullName", unique_gov_hash AS "uniqueGovHash",
            location, support_received AS "supportReceived", created_at AS "createdAt"
     FROM beneficiaries
     WHERE ($1 = '' OR full_name ILIKE '%' || $1 || '%' OR location ILIKE '%' || $1 || '%')
     ORDER BY created_at DESC`,
    [search || ""]
  );
  return res.rows;
}

async function findBeneficiaryById(id) {
  const res = await query(
    `SELECT beneficiary_id AS "beneficiaryId", full_name AS "fullName", unique_gov_hash AS "uniqueGovHash",
            location, support_received AS "supportReceived", created_at AS "createdAt"
     FROM beneficiaries WHERE beneficiary_id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function logAid(beneficiaryId, description, aidType, recordedBy) {
  await query(
    `INSERT INTO beneficiary_aid_log (beneficiary_id, description, aid_type, recorded_by)
     VALUES ($1, $2, $3, $4)`,
    [beneficiaryId, description, aidType || "", recordedBy]
  );
}

async function listAidForBeneficiary(beneficiaryId) {
  const res = await query(
    `SELECT id, description, aid_type AS "aidType", date_provided AS "dateProvided", recorded_by AS "recordedBy"
     FROM beneficiary_aid_log WHERE beneficiary_id = $1
     ORDER BY date_provided DESC`,
    [beneficiaryId]
  );
  return res.rows;
}

// ---- Dashboard summary (Super Admin / Project Manager) ----
// Read-only aggregates over existing tables — no schema changes, no new routes.
async function getVolunteerStats() {
  const res = await query(
    `SELECT
       COUNT(*) FILTER (WHERE u.role = 'Volunteer') AS "totalVolunteers",
       COUNT(*) FILTER (WHERE u.role = 'Volunteer' AND v.verified_status) AS "verifiedVolunteers",
       COUNT(*) FILTER (WHERE u.role = 'Volunteer' AND COALESCE(v.verified_status, FALSE) = FALSE) AS "pendingVolunteers"
     FROM users u
     LEFT JOIN volunteers v ON v.volunteer_id = u.id`
  );
  const row = res.rows[0];
  return {
    totalVolunteers: Number(row.totalVolunteers),
    verifiedVolunteers: Number(row.verifiedVolunteers),
    pendingVolunteers: Number(row.pendingVolunteers),
  };
}

async function countBeneficiaries() {
  const res = await query(`SELECT COUNT(*) AS "count" FROM beneficiaries`);
  return Number(res.rows[0].count);
}

async function listRecentVolunteerActivity(limit) {
  const res = await query(
    `SELECT h.task_name AS "taskName", h.hours_logged AS "hoursLogged", h.status,
            u.name AS "volunteerName",
            COALESCE(v.skills, '') AS skills,
            CASE WHEN v.verified_status THEN 'Verified' ELSE 'Pending' END AS "verifiedStatus"
     FROM volunteer_hours h
     JOIN users u ON u.id = h.volunteer_id
     LEFT JOIN volunteers v ON v.volunteer_id = u.id
     ORDER BY h.date_logged DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function listRecentBeneficiaries(limit) {
  const res = await query(
    `SELECT full_name AS "fullName", location, support_received AS "supportReceived", created_at AS "createdAt"
     FROM beneficiaries ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/* ============================================================
   2. SHARED CSS — one design system for every page
   ============================================================ */

const SHARED_CSS = `
:root{
  --navy:#05374D; --navy-2:#072F42; --teal:#028090; --seafoam:#00A896; --mint:#02C39A;
  --ink:#12262B; --muted:#5B7373; --muted-2:#8FA6A6; --bg:#F1F7F6; --white:#FFFFFF;
  --danger:#B3261E; --danger-bg:#FCEEEC; --success-bg:#E8F6F3; --warn-bg:#FFF4E0; --warn-ink:#8A5A00;
  --border:#E4EEEC; --ring: rgba(2,128,144,0.35);
  --font-head: Cambria, "Times New Roman", Georgia, serif;
  --font-body: Calibri, "Segoe UI", Arial, sans-serif;
  --radius: 10px;
  --shadow-sm: 0 1px 2px rgba(5,55,77,0.06);
  --shadow-md: 0 8px 24px -8px rgba(5,55,77,0.18);
}
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; }
body{ font-family: var(--font-body); background: var(--bg); color: var(--ink); }
a{ color:inherit; }
img{ max-width:100%; display:block; }

/* ---------- shared bits ---------- */
.link{ font-size: 12.5px; color: var(--teal); font-weight:700; text-decoration:none; background:none;
  border:none; cursor:pointer; padding:2px; }
.link:hover{ color: var(--navy); text-decoration:underline; }
.btn-primary{ padding: 12px 20px; background: var(--teal); color:#fff; border:none;
  border-radius: 8px; font-family: var(--font-body); font-size: 14px; font-weight:700; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:9px;
  transition: background .15s ease, transform .05s ease; text-decoration:none; white-space:nowrap; }
.btn-primary:hover{ background: #026a77; color:#fff; }
.btn-primary:active{ transform: translateY(1px); }
.btn-primary:disabled{ opacity:0.85; cursor:progress; }
.btn-primary.block{ width:100%; }
.btn-outline{ padding:11px 20px; background:transparent; color:var(--white); border:1.5px solid rgba(255,255,255,0.6);
  border-radius:8px; font-family:var(--font-body); font-size:14px; font-weight:700; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; text-decoration:none; white-space:nowrap; }
.btn-outline:hover{ background:rgba(255,255,255,0.12); }
.btn-outline.dark{ color:var(--teal); border-color:var(--teal); }
.btn-outline.dark:hover{ background:var(--success-bg); }
.btn-small{ padding:6px 12px; font-size:12px; border-radius:6px; border:1.5px solid var(--border); background:#fff;
  color:var(--muted); cursor:pointer; font-weight:700; font-family:var(--font-body); text-decoration:none;
  display:inline-flex; align-items:center; }
.btn-small:hover{ border-color:var(--teal); color:var(--teal); }
.btn-small.primary{ background:var(--teal); border-color:var(--teal); color:#fff; }
.btn-small.primary:hover{ background:#026a77; color:#fff; }
.btn-small.danger{ border-color:var(--danger); color:var(--danger); }
.btn-small.danger:hover{ background:var(--danger-bg); }
.spinner{ width:15px; height:15px; border-radius:50%; border: 2.5px solid rgba(255,255,255,0.35);
  border-top-color:#fff; animation: spin .7s linear infinite; display:none; }
@keyframes spin{ to{ transform: rotate(360deg); } }
.btn-primary.loading .spinner{ display:inline-block; }
.btn-primary.loading .btn-label{ opacity:0.85; }
@media (prefers-reduced-motion: reduce){ .spinner{ animation:none; } }

.badge{ display:inline-block; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap; }
.badge-verified{ background:var(--success-bg); color:#036B57; }
.badge-pending{ background:var(--warn-bg); color:var(--warn-ink); }
.badge-approved{ background:var(--success-bg); color:#036B57; }
.badge-rejected{ background:var(--danger-bg); color:var(--danger); }

.alert{ font-size: 13px; border-radius: 8px; padding: 11px 14px; line-height:1.5; margin-bottom:16px; }
.alert-error{ background: var(--danger-bg); color: var(--danger); }
.alert-success{ background: var(--success-bg); color: #036B57; }
.banner{ font-size: 12.5px; border-radius: 8px; padding: 10px 12px; display:none; line-height:1.5; }
.banner.show{ display:block; }
.banner.error{ background: var(--danger-bg); color: var(--danger); }
.banner.success{ background: var(--success-bg); color: #036B57; }

.skill-tag{ display:inline-block; background:var(--bg); color:var(--teal); padding:3px 10px; border-radius:6px;
  font-size:11.5px; font-weight:700; margin:2px 4px 2px 0; }
.hint-text{ font-size:11.5px; color:var(--muted); margin-top:-6px; display:block; margin-bottom:6px; }
.empty-state{ padding:28px; text-align:center; color:var(--muted); font-size:13px; }

/* ---------- form elements (auth pages + in-app forms) ---------- */
form.stack{ display:flex; flex-direction:column; gap: 14px; }
.field{ display:flex; flex-direction:column; gap:6px; }
.field label{ font-size: 12.5px; font-weight:700; color: var(--navy); }
.input-wrap{ position:relative; }
.field input, .field select{ width:100%; padding: 11px 13px; font-size: 14px; font-family: var(--font-body);
  border: 1.5px solid var(--border); border-radius: 8px; background: #FBFDFD; color: var(--ink);
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
.row-between{ display:flex; align-items:center; justify-content:space-between; }
.checkbox{ display:flex; align-items:center; gap:7px; font-size: 12.5px; color: var(--muted); cursor:pointer; user-select:none; }
.checkbox input{ position:absolute; opacity:0; width:16px; height:16px; }
.checkbox .box{ width:15px; height:15px; border-radius:4px; border:1.5px solid #C9DBD8; background:#fff;
  display:inline-flex; align-items:center; justify-content:center; transition: all .15s ease; flex-shrink:0; }
.checkbox input:checked + .box{ background: var(--teal); border-color: var(--teal); }
.checkbox .box svg{ width:10px; height:10px; opacity:0; transition:opacity .1s; }
.checkbox input:checked + .box svg{ opacity:1; }
:focus-visible{ outline: 3px solid var(--ring); outline-offset: 2px; }

/* ---------- tables ---------- */
.table-wrap{ overflow-x:auto; }
.table{ width:100%; border-collapse:collapse; font-size:13px; min-width:520px; }
.table th{ text-align:left; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase;
  letter-spacing:0.4px; padding:8px 10px; border-bottom:1.5px solid var(--border); white-space:nowrap; }
.table td{ padding:10px; border-bottom:1px solid #EEF4F3; color:var(--ink); vertical-align:middle; }
.table tr:last-child td{ border-bottom:none; }
.inline-form{ display:inline; }
.search-row{ display:flex; flex-direction:row; align-items:center; gap:8px; flex-wrap:wrap; }
.search-input{ padding:9px 12px; border:1.5px solid var(--border); border-radius:8px; font-size:13px; width:240px;
  font-family:var(--font-body); }

/* ============================================================
   PUBLIC SITE (landing page)
   ============================================================ */
.site-header{ position:sticky; top:0; z-index:40; background:rgba(255,255,255,0.96); backdrop-filter:blur(6px);
  border-bottom:1px solid var(--border); }
.site-header-inner{ max-width:1140px; margin:0 auto; padding:16px 24px; display:flex; align-items:center;
  justify-content:space-between; gap:20px; }
.site-brand{ display:flex; align-items:center; gap:10px; text-decoration:none; }
.site-brand .glyph{ width:34px; height:34px; border-radius:9px; background:var(--teal); display:flex;
  align-items:center; justify-content:center; flex-shrink:0; }
.site-brand .glyph svg{ width:19px; height:19px; }
.site-brand span{ font-family:var(--font-head); font-size:16px; font-weight:700; color:var(--navy); }
.site-nav{ display:flex; align-items:center; gap:28px; }
.site-nav a{ font-size:13.5px; font-weight:700; color:var(--muted); text-decoration:none; }
.site-nav a:hover{ color:var(--teal); }
.site-nav-actions{ display:flex; align-items:center; gap:10px; }
.site-nav-actions .btn-outline{ color:var(--teal); border-color:var(--teal); padding:8px 16px; }
.site-nav-actions .btn-outline:hover{ background:var(--success-bg); }
.site-nav-actions .btn-primary{ padding:8px 18px; }
.nav-toggle-btn{ display:none; background:none; border:1.5px solid var(--border); border-radius:8px; width:38px; height:38px;
  align-items:center; justify-content:center; cursor:pointer; }

.hero{ position:relative; overflow:hidden; background: linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 60%, #062A3A 100%); }
.hero::before{ content:""; position:absolute; width:520px; height:520px; border-radius:50%;
  background: radial-gradient(circle at 30% 30%, rgba(0,168,150,0.45), rgba(0,168,150,0) 70%); top:-220px; right:-160px; }
.hero-inner{ position:relative; z-index:2; max-width:1140px; margin:0 auto; padding:88px 24px 96px;
  display:grid; grid-template-columns: 1.1fr 0.9fr; gap:48px; align-items:center; }
.hero-eyebrow{ font-size:12.5px; font-weight:700; letter-spacing:2px; color:var(--mint); text-transform:uppercase; margin:0 0 16px 0; }
.hero h1{ font-family:var(--font-head); font-size:44px; line-height:1.18; color:#fff; margin:0 0 18px 0; font-weight:700; }
.hero p.lede{ font-size:16px; line-height:1.65; color:#CFE3E0; max-width:480px; margin:0 0 32px 0; }
.hero-actions{ display:flex; gap:14px; flex-wrap:wrap; }
.hero-visual{ background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); border-radius:16px;
  padding:28px; }
.hero-stat-grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:16px; }
.hero-stat{ background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:18px; }
.hero-stat b{ display:block; font-family:var(--font-head); font-size:26px; color:#fff; }
.hero-stat span{ display:block; font-size:11.5px; color:#9FC0BC; margin-top:4px; line-height:1.4; }

.section{ max-width:1140px; margin:0 auto; padding:80px 24px; }
.section-head{ text-align:center; max-width:640px; margin:0 auto 48px; }
.section-eyebrow{ font-size:12px; font-weight:700; letter-spacing:2px; color:var(--seafoam); text-transform:uppercase; margin:0 0 12px 0; }
.section-head h2{ font-family:var(--font-head); font-size:30px; color:var(--navy); margin:0 0 12px 0; }
.section-head p{ font-size:14.5px; color:var(--muted); line-height:1.6; margin:0; }

.feature-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:24px; }
.feature-card{ background:#fff; border:1px solid var(--border); border-radius:14px; padding:28px; box-shadow:var(--shadow-sm); }
.feature-card .icon{ width:48px; height:48px; border-radius:12px; background:var(--success-bg); display:flex;
  align-items:center; justify-content:center; margin-bottom:18px; }
.feature-card .icon svg{ width:24px; height:24px; color:var(--teal); }
.feature-card h3{ font-family:var(--font-head); font-size:18px; color:var(--navy); margin:0 0 10px 0; }
.feature-card ul{ margin:0; padding-left:18px; color:var(--muted); font-size:13.5px; line-height:1.9; }

.coming-soon{ background:var(--bg); border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
.coming-soon-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
.coming-soon-card{ background:#fff; border:1.5px dashed var(--border); border-radius:12px; padding:20px;
  text-align:center; color:var(--muted-2); }
.coming-soon-card .dot{ width:8px; height:8px; border-radius:50%; background:var(--muted-2); margin:0 auto 12px; }
.coming-soon-card span{ font-size:13px; font-weight:700; color:var(--muted); }
.coming-soon-tag{ display:inline-block; margin-top:8px; font-size:10.5px; font-weight:700; letter-spacing:0.6px;
  text-transform:uppercase; color:var(--muted-2); background:var(--bg); border:1px solid var(--border);
  padding:2px 8px; border-radius:999px; }

.site-footer{ background:var(--navy); color:#AFC9C6; }
.site-footer-inner{ max-width:1140px; margin:0 auto; padding:40px 24px; display:flex; align-items:center;
  justify-content:space-between; flex-wrap:wrap; gap:16px; }
.site-footer .site-brand span{ color:#fff; }
.site-footer p{ font-size:12.5px; margin:0; }

@media (max-width: 900px){
  .hero-inner{ grid-template-columns:1fr; padding:56px 24px 64px; }
  .hero h1{ font-size:32px; }
  .feature-grid{ grid-template-columns:1fr; }
  .coming-soon-grid{ grid-template-columns:repeat(2,1fr); }
  .site-nav{ display:none; }
  .nav-toggle-btn{ display:inline-flex; }
}

/* ============================================================
   AUTHENTICATED APP SHELL
   ============================================================ */
body.app-body{ margin:0; }
.app-shell{ display:flex; min-height:100vh; align-items:stretch; }
.nav-toggle{ display:none; }

.sidebar{ width:240px; flex-shrink:0; background:var(--navy); color:#fff; display:flex; flex-direction:column;
  padding:22px 16px; gap:6px; }
.sidebar-brand{ display:flex; align-items:center; gap:10px; padding:0 8px; margin-bottom:28px; }
.sidebar-brand .glyph{ width:32px; height:32px; border-radius:9px; background:var(--teal); display:flex;
  align-items:center; justify-content:center; flex-shrink:0; }
.sidebar-brand .glyph svg{ width:18px; height:18px; }
.sidebar-brand span{ font-family:var(--font-head); font-size:14.5px; font-weight:700; color:#fff; }
.sidebar-role-tag{ font-size:10px; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; color:#8FC7BE;
  padding:0 8px; margin-bottom:14px; }
.sidebar-link{ display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; font-size:13.5px;
  font-weight:700; color:#CFE3E0; text-decoration:none; cursor:pointer; background:none; border:none;
  text-align:left; width:100%; font-family:var(--font-body); }
.sidebar-link:hover{ background:rgba(255,255,255,0.08); color:#fff; }
.sidebar-link.active{ background:var(--teal); color:#fff; }
.sidebar-spacer{ flex:1; }
.sidebar-logout{ border-top:1px solid rgba(255,255,255,0.12); margin-top:8px; padding-top:14px; }

.shell-main{ flex:1; min-width:0; display:flex; flex-direction:column; }
.topbar{ display:flex; align-items:center; justify-content:space-between; padding:14px 28px;
  background:#fff; border-bottom:1px solid var(--border); gap:16px; }
.hamburger{ display:none; background:none; border:1.5px solid var(--border); border-radius:8px; width:36px; height:36px;
  align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; }
.topbar-user{ display:flex; align-items:center; gap:10px; margin-left:auto; }
.user-avatar{ width:32px; height:32px; border-radius:50%; background:var(--success-bg); color:#036B57;
  display:flex; align-items:center; justify-content:center; font-size:12.5px; font-weight:700; flex-shrink:0; }
.user-meta{ display:flex; flex-direction:column; line-height:1.3; }
.user-meta .user-name{ font-size:13px; font-weight:700; color:var(--navy); }
.user-meta .user-role{ font-size:11px; color:var(--muted); }

.content-area{ flex:1; padding:32px; max-width:1100px; width:100%; margin:0 auto; }
.page-head{ margin-bottom:24px; }
.page-head h1{ font-family:var(--font-head); font-size:25px; color:var(--navy); margin:0 0 6px 0; }
.page-head p{ font-size:13.5px; color:var(--muted); margin:0; }

.card{ background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:22px 24px;
  box-shadow:var(--shadow-sm); }
.card + .card{ margin-top:20px; }
.card dl{ margin:0; display:grid; grid-template-columns: 150px 1fr; row-gap:12px; }
.card dt{ font-size:12.5px; font-weight:700; color:var(--muted); }
.card dd{ font-size:14px; color:var(--ink); margin:0; }
.card h3{ margin:0 0 4px 0; font-family:var(--font-head); font-size:16px; color:var(--navy); }
.card p.card-sub{ margin:0 0 16px 0; font-size:12.5px; color:var(--muted); }
.role-badge{ display:inline-block; padding:3px 10px; border-radius:999px; background: var(--success-bg);
  color:#036B57; font-size:12px; font-weight:700; }
.quick-actions{ display:flex; gap:10px; flex-wrap:wrap; }

.stat-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:20px; }
.stat-card{ background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:20px;
  box-shadow:var(--shadow-sm); }
.stat-card .stat-label{ font-size:11.5px; font-weight:700; color:var(--muted); text-transform:uppercase;
  letter-spacing:0.4px; margin-bottom:8px; }
.stat-card .stat-value{ font-family:var(--font-head); font-size:30px; color:var(--navy); }
.section-title-row{ display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }

@media (max-width: 980px){
  .stat-grid{ grid-template-columns:repeat(2,1fr); }
}
@media (max-width: 860px){
  .hamburger{ display:flex; }
  .sidebar{ position:fixed; top:0; left:-260px; height:100vh; z-index:100; box-shadow:var(--shadow-md);
    transition:left .2s ease; }
  .nav-toggle:checked ~ .sidebar{ left:0; }
  .content-area{ padding:20px; }
  .card dl{ grid-template-columns:120px 1fr; }
}
@media (max-width: 560px){
  .stat-grid{ grid-template-columns:1fr; }
  .topbar{ padding:12px 16px; }
  .user-meta{ display:none; }
}
`;

const HEART_GLYPH = `<span class="glyph"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 21s-7.5-4.6-10-9.3C0.3 8.1 2 4.5 5.4 4c2-.3 3.7.6 4.9 2.1L12 8l1.7-1.9C15 4.6 16.7 3.7 18.6 4c3.4.5 5.1 4.1 3.4 7.7C19.5 16.4 12 21 12 21z" fill="#fff"/></svg></span>`;

const ICONS = {
  volunteers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  beneficiaries: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z"/></svg>`,
  auth: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

const LOGOUT_SCRIPT = `
<script>
document.getElementById('logoutBtn').addEventListener('click', function(){
  fetch('/api/logout', { method: 'POST' }).then(function(){ window.location.href = '/login'; });
});
</script>`;

/* ============================================================
   3. PAGE TEMPLATES
   ============================================================ */

/* ---------- Public landing page (no auth) ---------- */
function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body>
  <header class="site-header">
    <div class="site-header-inner">
      <a class="site-brand" href="/">${HEART_GLYPH}<span>NGO Management System</span></a>
      <nav class="site-nav">
        <a href="/">Home</a>
        <a href="#about">About</a>
        <a href="#our-work">Our Work</a>
        <a href="#get-involved">Get Involved</a>
      </nav>
      <div class="site-nav-actions">
        <a class="btn-outline dark" href="/login">Login</a>
        <a class="btn-primary" href="/register">Register</a>
      </div>
    </div>
  </header>

  <section class="hero" id="about">
    <div class="hero-inner">
      <div>
        <p class="hero-eyebrow">NGO Management System</p>
        <h1>Empowering Communities Through Action</h1>
        <p class="lede">We connect volunteers, staff, and the communities they support through one centralized
          platform — built to make coordination simple and every contribution accountable.</p>
        <div class="hero-actions">
          <a class="btn-primary" href="/register?role=Volunteer">Become a Volunteer</a>
          <a class="btn-outline" href="/login">Login</a>
        </div>
      </div>
      <div class="hero-visual">
        <div class="hero-stat-grid">
          <div class="hero-stat"><b>Registered</b><span>Volunteers build a profile, list their skills, and log hours in one place.</span></div>
          <div class="hero-stat"><b>Verified</b><span>Every volunteer is verified by staff before hours are approved.</span></div>
          <div class="hero-stat"><b>Tracked</b><span>Beneficiary support and aid history stay organized and searchable.</span></div>
          <div class="hero-stat"><b>Secure</b><span>Role-based access keeps sensitive records with authorized staff only.</span></div>
        </div>
      </div>
    </div>
  </section>

  <section class="section" id="our-work">
    <div class="section-head">
      <p class="section-eyebrow">What's live today</p>
      <h2>One system, built module by module</h2>
      <p>These are the parts of the platform that are up and running right now.</p>
    </div>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="icon">${ICONS.volunteers}</div>
        <h3>Volunteer Management</h3>
        <ul>
          <li>Manage volunteer profiles</li>
          <li>Track skills</li>
          <li>Track working hours</li>
          <li>Verification and approval</li>
        </ul>
      </div>
      <div class="feature-card">
        <div class="icon">${ICONS.beneficiaries}</div>
        <h3>Beneficiary Management</h3>
        <ul>
          <li>Maintain beneficiary records</li>
          <li>Search beneficiaries</li>
          <li>Track support provided</li>
          <li>Maintain aid history</li>
          <li>Prevent duplicate records</li>
        </ul>
      </div>
      <div class="feature-card">
        <div class="icon">${ICONS.auth}</div>
        <h3>Secure Authentication</h3>
        <ul>
          <li>Registration</li>
          <li>Login</li>
          <li>Sessions</li>
          <li>Role-based access</li>
        </ul>
      </div>
    </div>
  </section>

  <section class="coming-soon">
    <div class="section" style="padding:56px 24px;">
      <div class="section-head" style="margin-bottom:32px;">
        <p class="section-eyebrow">What's next</p>
        <h2>Coming soon</h2>
        <p>These modules are part of the roadmap and aren't available yet.</p>
      </div>
      <div class="coming-soon-grid">
        <div class="coming-soon-card"><div class="dot"></div><span>Project Monitoring</span><br/><span class="coming-soon-tag">Planned</span></div>
        <div class="coming-soon-card"><div class="dot"></div><span>Donation Processing</span><br/><span class="coming-soon-tag">Planned</span></div>
        <div class="coming-soon-card"><div class="dot"></div><span>Fundraising Campaigns</span><br/><span class="coming-soon-tag">Planned</span></div>
        <div class="coming-soon-card"><div class="dot"></div><span>Financial Transparency</span><br/><span class="coming-soon-tag">Planned</span></div>
      </div>
    </div>
  </section>

  <section class="section" id="get-involved" style="text-align:center; padding-bottom:96px;">
    <p class="section-eyebrow">Get involved</p>
    <h2 style="font-family:var(--font-head); font-size:28px; color:var(--navy); margin:0 0 14px 0;">Ready to help out?</h2>
    <p style="font-size:14.5px; color:var(--muted); max-width:480px; margin:0 auto 28px;">Create an account as a volunteer, donor, or community member — it only takes a minute.</p>
    <div class="hero-actions" style="justify-content:center;">
      <a class="btn-primary" href="/register">Create an account</a>
      <a class="btn-outline dark" href="/login">Login</a>
    </div>
  </section>

  <footer class="site-footer">
    <div class="site-footer-inner">
      <a class="site-brand" href="/">${HEART_GLYPH}<span>NGO Management System</span></a>
      <p>&copy; ${new Date().getFullYear()} NGO Management System. Built for communities, by volunteers.</p>
    </div>
  </footer>
</body>
</html>`;
}

/* ---------- Auth pages ---------- */
function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sign In · NGO Management System</title>
<style>${SHARED_CSS}
.auth-shell{ min-height:100vh; display:flex; }
.auth-brand{ flex:1 1 0; min-width:0; position:relative; overflow:hidden;
  background: linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 60%, #062A3A 100%);
  color:#fff; padding:48px 44px; display:flex; flex-direction:column; justify-content:space-between; }
.auth-brand::before{ content:""; position:absolute; width:320px; height:320px; border-radius:50%;
  background: radial-gradient(circle at 30% 30%, rgba(0,168,150,0.5), rgba(0,168,150,0) 70%); top:-140px; right:-110px; }
.auth-brand-top{ position:relative; z-index:2; }
.auth-brand .brand-mark{ display:flex; align-items:center; gap:10px; margin-bottom:40px; text-decoration:none; }
.auth-brand .brand-mark .glyph{ width:36px; height:36px; border-radius:10px; background:var(--teal);
  display:flex; align-items:center; justify-content:center; }
.auth-brand .brand-mark .glyph svg{ width:20px; height:20px; }
.auth-brand .brand-mark span{ font-family:var(--font-head); font-size:16.5px; font-weight:700; color:#fff; }
.auth-brand h1{ font-family:var(--font-head); font-size:30px; line-height:1.28; margin:0 0 14px 0; max-width:360px; }
.auth-brand p{ font-size:14px; line-height:1.65; color:#CFE3E0; max-width:340px; margin:0; }
.auth-brand-foot{ position:relative; z-index:2; font-size:12px; color:#9FC0BC; }
.auth-form{ flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; padding:44px; }
.auth-form-inner{ width:100%; max-width:360px; }
.auth-form h2{ font-family:var(--font-head); font-size:23px; margin:0 0 6px 0; color:var(--navy); }
.auth-form p.sub{ margin:0 0 22px 0; font-size:13px; color:var(--muted); line-height:1.5; }
.foot-link{ margin-top:20px; text-align:center; font-size:13px; color:var(--muted); }
@media (max-width:820px){ .auth-shell{ flex-direction:column; } .auth-brand{ padding:32px 28px; }
  .auth-brand h1{ font-size:23px; max-width:none; } .auth-form{ padding:32px 28px; } }
</style>
</head>
<body>
<div class="auth-shell">
  <aside class="auth-brand">
    <div class="auth-brand-top">
      <a class="brand-mark" href="/">${HEART_GLYPH}<span>NGO Management System</span></a>
      <h1>Welcome back to the platform that keeps your work organized.</h1>
      <p>Sign in to manage volunteers, beneficiaries, and the programs you run.</p>
    </div>
    <p class="auth-brand-foot">Role-based access keeps every account limited to what it needs.</p>
  </aside>
  <section class="auth-form">
    <div class="auth-form-inner">
      <h2>Sign in</h2>
      <p class="sub">Welcome back. Enter your details to continue.</p>
      <div class="alert alert-error banner error" id="banner"></div>
      <form id="loginForm" class="stack" novalidate>
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
        <button type="submit" class="btn-primary block" id="submitBtn">
          <span class="spinner"></span><span class="btn-label">Login</span>
        </button>
      </form>
      <p class="foot-link">Don't have an account? <a class="link" href="/register">Register</a></p>
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

function registerPage(presetRole) {
  const roles = ["Volunteer", "Donor", "Public Visitor", "Project Manager", "Super Admin"];
  const optionsHtml = roles.map((r) =>
    `<option value="${r}" ${presetRole === r ? "selected" : ""}>${r}</option>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Create Account · NGO Management System</title>
<style>${SHARED_CSS}
.auth-shell{ min-height:100vh; display:flex; }
.auth-brand{ flex:1 1 0; min-width:0; position:relative; overflow:hidden;
  background: linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 60%, #062A3A 100%);
  color:#fff; padding:48px 44px; display:flex; flex-direction:column; justify-content:space-between; }
.auth-brand::before{ content:""; position:absolute; width:320px; height:320px; border-radius:50%;
  background: radial-gradient(circle at 30% 30%, rgba(0,168,150,0.5), rgba(0,168,150,0) 70%); top:-140px; right:-110px; }
.auth-brand-top{ position:relative; z-index:2; }
.auth-brand .brand-mark{ display:flex; align-items:center; gap:10px; margin-bottom:40px; text-decoration:none; }
.auth-brand .brand-mark .glyph{ width:36px; height:36px; border-radius:10px; background:var(--teal);
  display:flex; align-items:center; justify-content:center; }
.auth-brand .brand-mark .glyph svg{ width:20px; height:20px; }
.auth-brand .brand-mark span{ font-family:var(--font-head); font-size:16.5px; font-weight:700; color:#fff; }
.auth-brand h1{ font-family:var(--font-head); font-size:30px; line-height:1.28; margin:0 0 14px 0; max-width:360px; }
.auth-brand p{ font-size:14px; line-height:1.65; color:#CFE3E0; max-width:340px; margin:0; }
.auth-form{ flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; padding:44px; }
.auth-form-inner{ width:100%; max-width:380px; }
.auth-form h2{ font-family:var(--font-head); font-size:23px; margin:0 0 6px 0; color:var(--navy); }
.auth-form p.sub{ margin:0 0 22px 0; font-size:13px; color:var(--muted); line-height:1.5; }
.foot-link{ margin-top:20px; text-align:center; font-size:13px; color:var(--muted); }
@media (max-width:820px){ .auth-shell{ flex-direction:column; } .auth-brand{ padding:32px 28px; }
  .auth-brand h1{ font-size:23px; max-width:none; } .auth-form{ padding:32px 28px; } }
</style>
</head>
<body>
<div class="auth-shell">
  <aside class="auth-brand">
    <div class="auth-brand-top">
      <a class="brand-mark" href="/">${HEART_GLYPH}<span>NGO Management System</span></a>
      <h1>Join the platform that keeps every contribution accountable.</h1>
      <p>Create an account to volunteer, donate, or track programs.</p>
    </div>
  </aside>
  <section class="auth-form">
    <div class="auth-form-inner">
      <h2>Create account</h2>
      <p class="sub">It only takes a minute.</p>
      <div class="alert alert-error banner error" id="banner"></div>
      <form id="registerForm" class="stack" novalidate>
        <div class="field" id="nameField">
          <label for="name">Full Name</label>
          <input type="text" id="name" name="name" placeholder="Jane Doe" autocomplete="name" />
          <span class="error-msg" id="nameError">Enter your full name.</span>
        </div>
        <div class="field" id="emailField">
          <label for="email">Email</label>
          <input type="text" id="email" name="email" placeholder="you@organization.org" autocomplete="username" />
          <span class="error-msg" id="emailError">Enter a valid email address.</span>
        </div>
        <div class="field" id="roleField">
          <label for="role">Role</label>
          <select id="role" name="role">
            <option value="" disabled ${presetRole ? "" : "selected"}>Select a role</option>
            ${optionsHtml}
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
        <button type="submit" class="btn-primary block" id="submitBtn">
          <span class="spinner"></span><span class="btn-label">Create Account</span>
        </button>
      </form>
      <p class="foot-link">Already have an account? <a class="link" href="/login">Login</a></p>
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

/* ---------- App shell (sidebar + topbar) for every authenticated page ---------- */
function sidebarLinks(role) {
  if (role === "Volunteer") {
    return [
      { key: "dashboard", href: "/dashboard", label: "Dashboard" },
      { key: "profile", href: "/volunteer/profile", label: "My Profile" },
      { key: "hours", href: "/volunteer/profile#hours", label: "My Hours" },
    ];
  }
  // Project Manager, Super Admin
  return [
    { key: "dashboard", href: "/dashboard", label: "Dashboard" },
    { key: "volunteers", href: "/volunteers", label: "Volunteers" },
    { key: "beneficiaries", href: "/beneficiaries", label: "Beneficiaries" },
  ];
}

function appShell(user, activeNav, innerHtml, titleSuffix) {
  const links = sidebarLinks(user.role);
  const navHtml = links.map((l) =>
    `<a class="sidebar-link ${activeNav === l.key ? "active" : ""}" href="${l.href}">${escapeHtml(l.label)}</a>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(titleSuffix || "Dashboard")} · NGO Management System</title>
<style>${SHARED_CSS}</style>
</head>
<body class="app-body">
  <div class="app-shell">
    <input type="checkbox" id="navToggle" class="nav-toggle" />
    <aside class="sidebar">
      <div class="sidebar-brand">${HEART_GLYPH}<span>NGO Management</span></div>
      <div class="sidebar-role-tag">${escapeHtml(user.role)}</div>
      ${navHtml}
      <div class="sidebar-spacer"></div>
      <button type="button" id="logoutBtn" class="sidebar-link sidebar-logout">Logout</button>
    </aside>
    <div class="shell-main">
      <header class="topbar">
        <label for="navToggle" class="hamburger" aria-label="Toggle menu">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </label>
        <div class="topbar-user">
          <span class="user-avatar">${escapeHtml(initials(user.name))}</span>
          <span class="user-meta"><span class="user-name">${escapeHtml(user.name)}</span><span class="user-role">${escapeHtml(user.role)}</span></span>
        </div>
      </header>
      <main class="content-area">
        ${innerHtml}
      </main>
    </div>
  </div>
${LOGOUT_SCRIPT}
</body>
</html>`;
}

/* ---------- Dashboard ---------- */
function dashboardPage(user, data) {
  const isVolunteer = user.role === "Volunteer";

  let content;
  if (isVolunteer) {
    const v = data.volunteerRecord;
    const verified = v && v.verifiedStatus === "Verified";
    const skillTags = v && v.skills
      ? v.skills.split(",").map((s) => s.trim()).filter(Boolean).map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")
      : `<span class="hint-text">No skills on file yet.</span>`;

    content = `
      <div class="page-head">
        <h1>Welcome, ${escapeHtml(user.name.split(" ")[0])}</h1>
        <p>Here's a snapshot of your volunteer profile.</p>
      </div>
      <div class="card">
        <dl>
          <dt>Status</dt><dd><span class="badge ${verified ? "badge-verified" : "badge-pending"}">${verified ? "Verified" : "Pending verification"}</span></dd>
          <dt>Skills</dt><dd>${skillTags}</dd>
          <dt>Hours logged</dt><dd>${data.hourCount}</dd>
        </dl>
      </div>
      <div class="card">
        <h3>Quick actions</h3>
        <p class="card-sub">Update your profile or log new hours.</p>
        <div class="quick-actions">
          <a class="btn-primary" href="/volunteer/profile">Go to my profile</a>
          <a class="btn-primary" href="/volunteer/profile#hours">Log hours</a>
        </div>
      </div>`;
  } else {
    const { stats, beneficiaryCount, recentActivity, recentBeneficiaries } = data;

    const activityRows = recentActivity.length
      ? recentActivity.map((r) => `
          <tr>
            <td>${escapeHtml(r.volunteerName)}</td>
            <td>${r.skills ? escapeHtml(r.skills.split(",")[0].trim()) : "—"}</td>
            <td><span class="badge ${r.verifiedStatus === "Verified" ? "badge-verified" : "badge-pending"}">${escapeHtml(r.verifiedStatus)}</span></td>
            <td>${escapeHtml(r.hoursLogged)}</td>
            <td><span class="badge badge-${r.status.toLowerCase()}">${escapeHtml(r.status)}</span></td>
          </tr>`).join("")
      : `<tr><td colspan="5" class="empty-state">No volunteer activity yet.</td></tr>`;

    const beneficiaryRows = recentBeneficiaries.length
      ? recentBeneficiaries.map((b) => `
          <tr>
            <td>${escapeHtml(b.fullName)}</td>
            <td>${escapeHtml(b.location)}</td>
            <td>${escapeHtml(b.supportReceived || "—")}</td>
            <td>${escapeHtml(new Date(b.createdAt).toLocaleDateString())}</td>
          </tr>`).join("")
      : `<tr><td colspan="4" class="empty-state">No beneficiaries yet.</td></tr>`;

    content = `
      <div class="page-head">
        <h1>Welcome, ${escapeHtml(user.name.split(" ")[0])}</h1>
        <p>Here's what's happening across the platform.</p>
      </div>

      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Total Volunteers</div><div class="stat-value">${stats.totalVolunteers}</div></div>
        <div class="stat-card"><div class="stat-label">Verified Volunteers</div><div class="stat-value">${stats.verifiedVolunteers}</div></div>
        <div class="stat-card"><div class="stat-label">Total Beneficiaries</div><div class="stat-value">${beneficiaryCount}</div></div>
        <div class="stat-card"><div class="stat-label">Pending Volunteer Approvals</div><div class="stat-value">${stats.pendingVolunteers}</div></div>
      </div>

      <div class="card">
        <h3>Recent volunteer activity</h3>
        <p class="card-sub">The latest hours logged across all volunteers.</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Volunteer</th><th>Skill</th><th>Verification</th><th>Hours</th><th>Status</th></tr></thead>
            <tbody>${activityRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3>Beneficiary overview</h3>
        <p class="card-sub">Recently added beneficiary records.</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>Location</th><th>Support received</th><th>Created</th></tr></thead>
            <tbody>${beneficiaryRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3>Quick actions</h3>
        <div class="quick-actions">
          <a class="btn-primary" href="/volunteers">Manage Volunteers</a>
          <a class="btn-primary" href="/beneficiaries">Manage Beneficiaries</a>
        </div>
      </div>`;
  }

  return appShell(user, "dashboard", content, "Dashboard");
}

/* ---------- Error page ---------- */
function errorPage(title, message, user) {
  const content = `
    <div class="page-head">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </div>
    <a class="btn-primary" href="/dashboard">Back to dashboard</a>`;

  if (user) return appShell(user, "", content, title);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · NGO Management System</title>
<style>${SHARED_CSS}
body{ min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); padding:24px; }
.error-card{ background:#fff; border:1px solid var(--border); border-radius:14px; padding:40px; max-width:420px;
  text-align:center; box-shadow:var(--shadow-sm); }
.error-card h1{ font-family:var(--font-head); font-size:22px; color:var(--navy); margin:0 0 10px 0; }
.error-card p{ font-size:13.5px; color:var(--muted); margin:0 0 22px 0; line-height:1.6; }
</style>
</head>
<body>
  <div class="error-card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="btn-primary" href="/login">Back to login</a>
  </div>
</body>
</html>`;
}

/* ---------- Volunteer: self-service profile ---------- */
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
          <td>${escapeHtml(new Date(h.dateLogged).toLocaleDateString())}</td>
          <td>${escapeHtml(h.hoursLogged)}</td>
          <td><span class="badge badge-${h.status.toLowerCase()}">${escapeHtml(h.status)}</span></td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="empty-state">No hours logged yet.</td></tr>`;

  const content = `
    <div class="page-head">
      <h1>My Profile</h1>
      <p>Keep your skills current and review your working hours.</p>
    </div>

    <div class="card">
      <h3>My Profile</h3>
      <p class="card-sub">Visible to project managers when they search for volunteers.</p>
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
      <form method="POST" action="/volunteer/skills" class="stack">
        <div class="field">
          <label for="skills">Skills</label>
          <input type="text" id="skills" name="skills" placeholder="First aid, Event coordination, Teaching" value="${escapeHtml(skills)}" />
        </div>
        <button type="submit" class="btn-primary" style="align-self:flex-start;">Save skills</button>
      </form>
    </div>

    <div class="card" id="hours">
      <h3>My Working Hours</h3>
      <p class="card-sub">Log new hours below — a project manager reviews each submission before it's approved.</p>
      <form method="POST" action="/volunteer/hours" class="stack" style="margin-bottom:24px;">
        <div class="field">
          <label for="taskName">Task</label>
          <input type="text" id="taskName" name="taskName" placeholder="Flood relief distribution" required />
        </div>
        <div class="field">
          <label for="hoursLogged">Hours</label>
          <input type="number" id="hoursLogged" name="hoursLogged" min="0.5" step="0.5" placeholder="3" required />
        </div>
        <button type="submit" class="btn-primary" style="align-self:flex-start;">Log hours</button>
      </form>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Task</th><th>Date</th><th>Hours</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  return appShell(user, "profile", content, "My Profile");
}

/* ---------- Volunteers: admin ---------- */
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

  const content = `
    <div class="page-head">
      <h1>Volunteer Management</h1>
      <p>Search, verify and manage registered volunteers.</p>
    </div>

    <div class="card">
      <div class="section-title-row">
        <h3>All volunteers</h3>
      </div>
      <p class="card-sub">Search matches against each volunteer's listed skills.</p>
      <form class="search-row" method="GET" action="/volunteers" style="margin-bottom:16px;">
        <input type="text" class="search-input" name="skill" placeholder="Search volunteers..." value="${escapeHtml(skillFilter || "")}" />
        <button type="submit" class="btn-small primary">Search</button>
        ${skillFilter ? `<a class="btn-small" href="/volunteers">Clear</a>` : ""}
      </form>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Skills</th><th>Verification Status</th><th>Actions</th></tr></thead>
          <tbody>${volunteerRows}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>Pending hour approvals</h3>
      <p class="card-sub">Approve or reject hours volunteers have logged.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Volunteer</th><th>Task</th><th>Hours</th><th>Date</th><th>Actions</th></tr></thead>
          <tbody>${hourRows}</tbody>
        </table>
      </div>
    </div>`;

  return appShell(user, "volunteers", content, "Volunteer Management");
}

/* ---------- Beneficiaries: list ---------- */
function beneficiariesListPage(user, beneficiaries, search) {
  const rows = beneficiaries.length
    ? beneficiaries.map((b) => `
        <tr>
          <td>${escapeHtml(b.beneficiaryId.slice(0, 8))}</td>
          <td>${escapeHtml(b.fullName)}</td>
          <td>${escapeHtml(b.location)}</td>
          <td>${escapeHtml(b.supportReceived || "—")}</td>
          <td>${escapeHtml(new Date(b.createdAt).toLocaleDateString())}</td>
          <td><a class="btn-small" href="/beneficiaries/${encodeURIComponent(b.beneficiaryId)}">View</a></td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty-state">No beneficiaries match this search.</td></tr>`;

  const content = `
    <div class="page-head">
      <h1>Beneficiary Management</h1>
      <p>Securely manage beneficiary records and support history.</p>
    </div>

    <div class="card">
      <div class="row-between" style="margin-bottom:16px; flex-wrap:wrap; gap:12px;">
        <form class="search-row" method="GET" action="/beneficiaries" style="margin-bottom:0;">
          <input type="text" class="search-input" name="search" placeholder="Search beneficiaries..." value="${escapeHtml(search || "")}" />
          <button type="submit" class="btn-small primary">Search</button>
          ${search ? `<a class="btn-small" href="/beneficiaries">Clear</a>` : ""}
        </form>
        <a class="btn-primary" href="/beneficiaries/new">+ Add Beneficiary</a>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Beneficiary ID</th><th>Full Name</th><th>Location</th><th>Support Received</th><th>Created Date</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  return appShell(user, "beneficiaries", content, "Beneficiary Management");
}

/* ---------- Beneficiaries: create ---------- */
function beneficiaryNewPage(user, errorMessage) {
  const content = `
    <div class="page-head">
      <h1>Add New Beneficiary</h1>
      <p>Beneficiary information is restricted to authorized NGO personnel.</p>
    </div>

    <div class="card" style="max-width:520px;">
      ${errorMessage ? `<div class="alert alert-error">${escapeHtml(errorMessage)}</div>` : ""}
      <form method="POST" action="/beneficiaries" class="stack">
        <div class="field">
          <label for="fullName">Full Name</label>
          <input type="text" id="fullName" name="fullName" placeholder="Deepa Nair" required />
        </div>
        <div class="field">
          <label for="uniqueGovHash">Government ID / Unique Identifier</label>
          <input type="text" id="uniqueGovHash" name="uniqueGovHash" placeholder="e.g. hashed Aadhaar / ration card ID" required />
          <span class="hint-text">Used to prevent duplicate profiles — must be unique per person.</span>
        </div>
        <div class="field">
          <label for="location">Location</label>
          <input type="text" id="location" name="location" placeholder="Region or district" required />
        </div>
        <div class="field">
          <label for="supportReceived">Support Summary</label>
          <input type="text" id="supportReceived" name="supportReceived" placeholder="e.g. Monthly food ration, school supplies" />
        </div>
        <button type="submit" class="btn-primary" style="align-self:flex-start;">Create Beneficiary</button>
      </form>
    </div>`;

  return appShell(user, "beneficiaries", content, "Add Beneficiary");
}

/* ---------- Beneficiaries: detail ---------- */
function beneficiaryDetailPage(user, beneficiary, aidLog) {
  const rows = aidLog.length
    ? aidLog.map((a) => `
        <tr>
          <td>${escapeHtml(new Date(a.dateProvided).toLocaleDateString())}</td>
          <td>${escapeHtml(a.aidType || "—")}</td>
          <td>${escapeHtml(a.description)}</td>
          <td>${escapeHtml(a.recordedBy || "—")}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" class="empty-state">No aid logged yet.</td></tr>`;

  const content = `
    <div class="page-head">
      <h1>Beneficiary Profile</h1>
      <p><a class="link" href="/beneficiaries">← Back to all beneficiaries</a></p>
    </div>

    <div class="card">
      <dl>
        <dt>Full Name</dt><dd>${escapeHtml(beneficiary.fullName)}</dd>
        <dt>Beneficiary ID</dt><dd>${escapeHtml(beneficiary.beneficiaryId.slice(0, 8))}</dd>
        <dt>Location</dt><dd>${escapeHtml(beneficiary.location)}</dd>
        <dt>Support Received</dt><dd>${escapeHtml(beneficiary.supportReceived || "—")}</dd>
      </dl>
    </div>

    <div class="card">
      <h3>Aid History</h3>
      <p class="card-sub">A complete record of aid delivered to this beneficiary.</p>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Date</th><th>Aid Type</th><th>Description</th><th>Recorded By</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>Record New Aid</h3>
      <form method="POST" action="/beneficiaries/${encodeURIComponent(beneficiary.beneficiaryId)}/aid" class="stack">
        <div class="field">
          <label for="aidType">Aid Type</label>
          <input type="text" id="aidType" name="aidType" placeholder="Food, Medical, Education, Shelter..." />
        </div>
        <div class="field">
          <label for="description">Description</label>
          <input type="text" id="description" name="description" placeholder="e.g. 10kg rice, 2L cooking oil" required />
        </div>
        <button type="submit" class="btn-primary" style="align-self:flex-start;">Record Aid</button>
      </form>
    </div>`;

  return appShell(user, "beneficiaries", content, escapeHtml(beneficiary.fullName));
}

/* ============================================================
   4. MIDDLEWARE
   ============================================================ */

// Wraps an async route/middleware so a rejected promise reaches Express's
// error handler instead of crashing the process or hanging the request.
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const requireAuth = asyncRoute(async (req, res, next) => {
  if (!req.session.userEmail) return res.redirect("/login");
  const user = await findUserByEmail(req.session.userEmail);
  if (!user) return res.redirect("/login");
  req.currentUser = user;
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.currentUser.role)) {
      return res.status(403).type("html").send(
        errorPage("Access denied", "You don't have permission to view this page.", req.currentUser)
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
app.get("/", (req, res) => res.type("html").send(landingPage()));
app.get("/login", (req, res) => res.type("html").send(loginPage()));
app.get("/register", (req, res) => {
  const presetRole = VALID_ROLES.includes(req.query.role) ? req.query.role : null;
  res.type("html").send(registerPage(presetRole));
});
app.get("/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const user = req.currentUser;
  if (user.role === "Volunteer") {
    const volunteerRecord = await findVolunteerByUserId(user.id);
    const hourLogs = await listHoursForVolunteer(user.id);
    res.type("html").send(dashboardPage(user, { volunteerRecord, hourCount: hourLogs.length }));
    return;
  }
  const [stats, beneficiaryCount, recentActivity, recentBeneficiaries] = await Promise.all([
    getVolunteerStats(),
    countBeneficiaries(),
    listRecentVolunteerActivity(5),
    listRecentBeneficiaries(5),
  ]);
  res.type("html").send(dashboardPage(user, { stats, beneficiaryCount, recentActivity, recentBeneficiaries }));
}));

/* ---------- Auth: API ---------- */
app.post("/api/register", asyncRoute(async (req, res) => {
  const { name, email, password, confirmPassword, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Full name is required." });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "Select a valid role." });

  if (await findUserByEmail(email)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({ name: name.trim(), email, passwordHash, role });

  req.session.userEmail = user.email;
  return res.status(201).json({
    message: "Account created successfully.",
    user: { name: user.name, email: user.email, role: user.role },
  });
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const { email, password, remember } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }
  const user = await findUserByEmail(email);
  if (!user) return res.status(401).json({ error: "Incorrect email or password." });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Incorrect email or password." });

  req.session.userEmail = user.email;
  if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;

  return res.json({
    message: "Signed in successfully.",
    user: { name: user.name, email: user.email, role: user.role },
  });
}));

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.session.userEmail) return res.status(401).json({ error: "Not signed in." });
  const user = await findUserByEmail(req.session.userEmail);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  return res.json({ user: { name: user.name, email: user.email, role: user.role } });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ngo.sid");
    res.json({ message: "Signed out." });
  });
});

/* ---------- Volunteer Management: self-service (role: Volunteer) ---------- */

app.get("/volunteer/profile", requireAuth, requireRole("Volunteer"), asyncRoute(async (req, res) => {
  const volunteerRecord = await findVolunteerByUserId(req.currentUser.id);
  const hourLogs = await listHoursForVolunteer(req.currentUser.id);
  res.type("html").send(volunteerProfilePage(req.currentUser, volunteerRecord, hourLogs));
}));

app.post("/volunteer/skills", requireAuth, requireRole("Volunteer"), asyncRoute(async (req, res) => {
  const skills = String(req.body.skills || "").trim();
  await upsertVolunteerSkills(req.currentUser.id, skills);
  res.redirect("/volunteer/profile");
}));

app.post("/volunteer/hours", requireAuth, requireRole("Volunteer"), asyncRoute(async (req, res) => {
  const taskName = String(req.body.taskName || "").trim();
  const hoursLogged = parseFloat(req.body.hoursLogged);
  if (taskName && hoursLogged > 0) {
    await logHours(req.currentUser.id, taskName, hoursLogged);
  }
  res.redirect("/volunteer/profile");
}));

/* ---------- Volunteer Management: admin (role: Project Manager, Super Admin) ---------- */

app.get("/volunteers", requireAuth, requireRole("Project Manager", "Super Admin"), asyncRoute(async (req, res) => {
  const skillFilter = req.query.skill ? String(req.query.skill) : "";
  const volunteers = await listVolunteers(skillFilter);
  const pendingHours = await listPendingHours();
  res.type("html").send(volunteersAdminPage(req.currentUser, volunteers, pendingHours, skillFilter));
}));

app.post("/volunteers/:id/verify", requireAuth, requireRole("Project Manager", "Super Admin"), asyncRoute(async (req, res) => {
  await setVolunteerVerified(req.params.id, true);
  res.redirect("/volunteers");
}));

app.post("/volunteers/:id/unverify", requireAuth, requireRole("Project Manager", "Super Admin"), asyncRoute(async (req, res) => {
  await setVolunteerVerified(req.params.id, false);
  res.redirect("/volunteers");
}));

app.post("/hours/:id/approve", requireAuth, requireRole("Project Manager", "Super Admin"), asyncRoute(async (req, res) => {
  await setHourStatus(req.params.id, "Approved", req.currentUser.email);
  res.redirect("/volunteers");
}));

app.post("/hours/:id/reject", requireAuth, requireRole("Project Manager", "Super Admin"), asyncRoute(async (req, res) => {
  await setHourStatus(req.params.id, "Rejected", req.currentUser.email);
  res.redirect("/volunteers");
}));

/* ---------- Beneficiary Management (role: Project Manager, Super Admin) ---------- */
/* Restricted per SRS Section 8: "Unregistered public browsers cannot look up
   personal beneficiary identification details." Volunteers/Donors/Public
   Visitors don't get access either, at least until a narrower, field-safe
   view is designed. */

const BENEFICIARY_ROLES = ["Project Manager", "Super Admin"];

app.get("/beneficiaries", requireAuth, requireRole(...BENEFICIARY_ROLES), asyncRoute(async (req, res) => {
  const search = req.query.search ? String(req.query.search) : "";
  const beneficiaries = await listBeneficiaries(search);
  res.type("html").send(beneficiariesListPage(req.currentUser, beneficiaries, search));
}));

app.get("/beneficiaries/new", requireAuth, requireRole(...BENEFICIARY_ROLES), (req, res) => {
  res.type("html").send(beneficiaryNewPage(req.currentUser, null));
});

app.post("/beneficiaries", requireAuth, requireRole(...BENEFICIARY_ROLES), asyncRoute(async (req, res) => {
  const fullName = String(req.body.fullName || "").trim();
  const uniqueGovHash = String(req.body.uniqueGovHash || "").trim();
  const location = String(req.body.location || "").trim();
  const supportReceived = String(req.body.supportReceived || "").trim();

  if (!fullName || !uniqueGovHash || !location) {
    return res.status(400).type("html").send(
      beneficiaryNewPage(req.currentUser, "Full name, government ID / unique hash, and location are all required.")
    );
  }

  // Deduplication check (FR4 + Section 8 constraint) — the database's UNIQUE
  // constraint on unique_gov_hash would also catch this, but checking first
  // lets us show a friendly message instead of a raw constraint-violation error.
  const existing = await findBeneficiaryByHash(uniqueGovHash);
  if (existing) {
    return res.status(409).type("html").send(
      beneficiaryNewPage(req.currentUser, "Beneficiary already exists.")
    );
  }

  const created = await createBeneficiary({
    fullName, uniqueGovHash, location, supportReceived, createdBy: req.currentUser.id,
  });
  res.redirect(`/beneficiaries/${created.beneficiaryId}`);
}));

app.get("/beneficiaries/:id", requireAuth, requireRole(...BENEFICIARY_ROLES), asyncRoute(async (req, res) => {
  const beneficiary = await findBeneficiaryById(req.params.id);
  if (!beneficiary) {
    return res.status(404).type("html").send(errorPage("Not found", "This beneficiary record doesn't exist.", req.currentUser));
  }
  const aidLog = await listAidForBeneficiary(req.params.id);
  res.type("html").send(beneficiaryDetailPage(req.currentUser, beneficiary, aidLog));
}));

app.post("/beneficiaries/:id/aid", requireAuth, requireRole(...BENEFICIARY_ROLES), asyncRoute(async (req, res) => {
  const description = String(req.body.description || "").trim();
  const aidType = String(req.body.aidType || "").trim();
  if (description) {
    await logAid(req.params.id, description, aidType, req.currentUser.email);
  }
  res.redirect(`/beneficiaries/${req.params.id}`);
}));

/* ---------- Error handler (catches anything asyncRoute forwarded) ---------- */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).type("html").send(
    errorPage("Something went wrong", "Please try again in a moment. If this keeps happening, check that the database is reachable.", req.currentUser)
  );
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NGO Management System running at http://localhost:${PORT}`);
      console.log(`Open http://localhost:${PORT}/login to sign in.`);
      console.log(`Connected to PostgreSQL (see db.js / DATABASE_URL).`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to PostgreSQL or apply schema.sql:");
    console.error(err.message);
    console.error("Check that PostgreSQL is running and DATABASE_URL is correct (see README.md).");
    process.exit(1);
  });
