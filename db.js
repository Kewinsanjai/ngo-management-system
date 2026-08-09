/**
 * db.js — the only file that talks to Postgres directly.
 * app.js calls query() and never touches the pg driver itself.
 */

require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://ngo_app:ngo_dev_password@localhost:5432/ngo_management";

const pool = new Pool({ connectionString });

function query(text, params) {
  return pool.query(text, params);
}

// Creates every table if it doesn't already exist. Safe to run on every startup.
async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

module.exports = { pool, query, ensureSchema };
