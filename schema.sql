-- NGO Management System — database schema
-- Run automatically by db.js on startup (safe to run repeatedly: IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Super Admin','Project Manager','Volunteer','Donor','Public Visitor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FR2: Volunteer Management
CREATE TABLE IF NOT EXISTS volunteers (
  volunteer_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  skills TEXT NOT NULL DEFAULT '',
  verified_status BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS volunteer_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  volunteer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  hours_logged NUMERIC(5,2) NOT NULL CHECK (hours_logged > 0),
  date_logged TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ
);

-- FR4: Beneficiary Management
-- unique_gov_hash has a UNIQUE constraint — this is the deduplication check from
-- the SRS ("reject duplicate beneficiary profiles containing identical ID numbers")
-- enforced at the database level, not just in application code.
CREATE TABLE IF NOT EXISTS beneficiaries (
  beneficiary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  unique_gov_hash TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  support_received TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historical timeline of aid delivered (FR4, third bullet) — one row per
-- delivery event, so a beneficiary's full aid history can be reconstructed.
CREATE TABLE IF NOT EXISTS beneficiary_aid_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_id UUID NOT NULL REFERENCES beneficiaries(beneficiary_id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  aid_type TEXT,
  date_provided TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_volunteer_hours_volunteer ON volunteer_hours(volunteer_id);
CREATE INDEX IF NOT EXISTS idx_beneficiary_aid_log_beneficiary ON beneficiary_aid_log(beneficiary_id);
