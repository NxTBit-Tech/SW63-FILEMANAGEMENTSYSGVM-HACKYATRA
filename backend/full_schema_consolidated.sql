-- ============================================================
-- SW63 — GVMC Departmental File Management System
-- FULL CONSOLIDATED SCHEMA (PostgreSQL)
-- Pilot scope: Town Planning dept, Building Permission workflow
-- Includes: base schema + Migration 001 (department scoping,
-- workflow_templates, dispatch/receive custody handoff, transit SLA)
-- ============================================================

-- ------------------------------------------------------------
-- 1. ROLES
-- ------------------------------------------------------------
CREATE TYPE role_enum AS ENUM (
    'revenue_inspector',
    'town_planning_officer',
    'assistant_engineer',
    'executive_engineer',
    'commissioner'
);

-- ------------------------------------------------------------
-- 2. USERS (Officers)
-- ------------------------------------------------------------
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role role_enum NOT NULL,
    department VARCHAR(100) NOT NULL DEFAULT 'Town Planning',
    created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. STAGES
-- department_id added in Migration 001 — default 1 = Town Planning,
-- so a second department is an INSERT, not a schema rewrite.
-- ------------------------------------------------------------
CREATE TABLE stages (
    id SERIAL PRIMARY KEY,
    stage_name VARCHAR(100) UNIQUE NOT NULL,
    stage_order INT NOT NULL UNIQUE,
    owning_role role_enum NOT NULL,
    sla_hours INT NOT NULL,
    department_id INT NOT NULL DEFAULT 1
);

INSERT INTO stages (stage_name, stage_order, owning_role, sla_hours, department_id) VALUES
('Submitted', 1, 'revenue_inspector', 24, 1),
('Under Review', 2, 'town_planning_officer', 48, 1),
('Site Inspection', 3, 'assistant_engineer', 72, 1),
('Final Approval', 4, 'executive_engineer', 48, 1),
('Commissioner Review', 5, 'commissioner', 48, 1);
-- Commissioner Review is reached only via escalation from Final Approval.
-- 'Approved' / 'Rejected' remain terminal statuses, not stage rows.

-- ------------------------------------------------------------
-- 4. FILES
-- pending_holder_id + dispatched_at added in Migration 001 for the
-- two-step dispatch -> receive custody handoff.
-- ------------------------------------------------------------
CREATE TYPE file_status_enum AS ENUM (
    'in_progress',
    'approved',
    'rejected'
);

CREATE TABLE files (
    id SERIAL PRIMARY KEY,
    reference_number VARCHAR(30) UNIQUE NOT NULL,
    applicant_name VARCHAR(150) NOT NULL,
    applicant_contact VARCHAR(50),
    property_address TEXT,
    department VARCHAR(100) NOT NULL DEFAULT 'Town Planning',
    current_stage_id INT NOT NULL REFERENCES stages(id),
    current_holder_id INT REFERENCES users(id), -- who physically has it now
    pending_holder_id INT REFERENCES users(id), -- dispatched to, not yet confirmed
    dispatched_at TIMESTAMP,                    -- set on dispatch, cleared on receive
    status file_status_enum NOT NULL DEFAULT 'in_progress',
    qr_payload TEXT NOT NULL,
    barcode_payload TEXT NOT NULL,
    created_by INT NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    stage_entered_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 5. TRANSITIONS (state machine rulebook)
-- department_id and transit_sla_hours added in Migration 001.
-- transition_type_enum extended with 'dispatch' / 'receive'.
-- ------------------------------------------------------------
CREATE TYPE transition_type_enum AS ENUM (
    'advance',
    'send_back',
    'terminal_approve',
    'terminal_reject',
    'dispatch',
    'receive'
);

CREATE TABLE allowed_transitions (
    id SERIAL PRIMARY KEY,
    from_stage_id INT NOT NULL REFERENCES stages(id),
    to_stage_id INT REFERENCES stages(id),
    transition_type transition_type_enum NOT NULL,
    resulting_status file_status_enum NOT NULL DEFAULT 'in_progress',
    required_role role_enum NOT NULL,
    department_id INT NOT NULL DEFAULT 1,
    transit_sla_hours INT NOT NULL DEFAULT 4, -- desk-to-desk default; raise per-row for cross-dept/travel moves
    UNIQUE (from_stage_id, transition_type, required_role)
);

INSERT INTO allowed_transitions (from_stage_id, to_stage_id, transition_type, resulting_status, required_role, department_id) VALUES
-- Forward moves (advance) — kept for reference/back-compat; live handoffs now use dispatch/receive below
(1, 2, 'advance', 'in_progress', 'revenue_inspector', 1),
(2, 3, 'advance', 'in_progress', 'town_planning_officer', 1),
(3, 4, 'advance', 'in_progress', 'assistant_engineer', 1),
-- Send-backs
(2, 1, 'send_back', 'in_progress', 'town_planning_officer', 1),
(3, 2, 'send_back', 'in_progress', 'assistant_engineer', 1),
-- EE's three possible moves at Final Approval
(4, NULL, 'terminal_approve', 'approved', 'executive_engineer', 1),
(4, NULL, 'terminal_reject', 'rejected', 'executive_engineer', 1),
(4, 5, 'advance', 'in_progress', 'executive_engineer', 1),
-- Commissioner's decision, only reachable from stage 5
(5, NULL, 'terminal_approve', 'approved', 'commissioner', 1),
(5, NULL, 'terminal_reject', 'rejected', 'commissioner', 1),
-- Dispatch/Receive pairs — the actual handoff mechanism (Migration 001)
(1, 2, 'dispatch', 'in_progress', 'revenue_inspector', 1),
(1, 2, 'receive',  'in_progress', 'town_planning_officer', 1),
(2, 3, 'dispatch', 'in_progress', 'town_planning_officer', 1),
(2, 3, 'receive',  'in_progress', 'assistant_engineer', 1),
(3, 4, 'dispatch', 'in_progress', 'assistant_engineer', 1),
(3, 4, 'receive',  'in_progress', 'executive_engineer', 1),
(2, 1, 'dispatch', 'in_progress', 'town_planning_officer', 1),
(2, 1, 'receive',  'in_progress', 'revenue_inspector', 1),
(3, 2, 'dispatch', 'in_progress', 'assistant_engineer', 1),
(3, 2, 'receive',  'in_progress', 'town_planning_officer', 1),
(4, 5, 'dispatch', 'in_progress', 'executive_engineer', 1),
(4, 5, 'receive',  'in_progress', 'commissioner', 1);
-- Terminal transitions never get dispatch/receive rows — no handoff to
-- confirm when a file's life ends at a desk that already holds it.

-- ------------------------------------------------------------
-- 6. WORKFLOW TEMPLATES (Migration 001 — custom workflow builder)
-- Builder UI writes JSON here; a materializer function reads it and
-- writes real rows into stages/allowed_transitions. Runtime engine
-- never reads this table directly — DB enforcement stays intact.
-- ------------------------------------------------------------
CREATE TABLE workflow_templates (
    id SERIAL PRIMARY KEY,
    department VARCHAR(100) NOT NULL,
    workflow_name VARCHAR(100) NOT NULL,
    config JSONB NOT NULL,
    created_by INT NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    is_active BOOLEAN NOT NULL DEFAULT true
);

-- ------------------------------------------------------------
-- 7. CUSTODY LOG
-- transit_hours added in Migration 001 — actual dispatch-to-receive gap.
-- ------------------------------------------------------------
CREATE TABLE custody_log (
    id SERIAL PRIMARY KEY,
    file_id INT NOT NULL REFERENCES files(id),
    from_stage_id INT NOT NULL REFERENCES stages(id),
    to_stage_id INT REFERENCES stages(id),
    handled_by INT NOT NULL REFERENCES users(id),
    transition_type transition_type_enum NOT NULL,
    scanned_at TIMESTAMP NOT NULL DEFAULT now(),
    time_at_previous_stage_hours NUMERIC(6,2),
    transit_hours NUMERIC(6,2) -- populated on 'receive' rows only
);

-- ------------------------------------------------------------
-- 8. INDEXES
-- ------------------------------------------------------------
CREATE INDEX idx_files_current_stage ON files(current_stage_id);
CREATE INDEX idx_files_status ON files(status);
CREATE INDEX idx_files_holder ON files(current_holder_id);
CREATE INDEX idx_files_pending_holder ON files(pending_holder_id);
CREATE INDEX idx_custody_log_file ON custody_log(file_id);


-- ============================================================
-- QUERY SCRIPTS
-- ============================================================

-- ---- A. Citizen status lookup (public, read-only, no auth) ----
-- Deliberately minimal: never add applicant/officer fields here.
SELECT f.reference_number, s.stage_name, f.status, f.stage_entered_at
FROM files f
JOIN stages s ON f.current_stage_id = s.id
WHERE f.reference_number = $1;

-- ---- B1. Validate a DISPATCH attempt ----
-- $1 = file's current_stage_id, $2 = requested next stage,
-- $3 = role from JWT, $4 = requesting officer's user id, $5 = file id
SELECT at.id, at.resulting_status, at.to_stage_id
FROM allowed_transitions at
JOIN files f ON f.id = $5
WHERE at.from_stage_id = $1
  AND at.to_stage_id IS NOT DISTINCT FROM $2
  AND at.required_role = $3
  AND at.transition_type = 'dispatch'
  AND f.current_holder_id = $4       -- dispatcher must currently hold the file
  AND f.status = 'in_progress';

-- ---- B2. Validate a RECEIVE attempt ----
-- $1 = file's current_stage_id, $2 = requested next stage,
-- $3 = role from JWT, $4 = requesting officer's user id, $5 = file id
SELECT at.id, at.resulting_status, at.to_stage_id
FROM allowed_transitions at
JOIN files f ON f.id = $5
WHERE at.from_stage_id = $1
  AND at.to_stage_id IS NOT DISTINCT FROM $2
  AND at.required_role = $3
  AND at.transition_type = 'receive'
  AND f.pending_holder_id = $4        -- receiver must be who it was dispatched to
  AND f.dispatched_at IS NOT NULL
  AND f.status = 'in_progress';

-- ---- B3. Validate a TERMINAL attempt (approve/reject) ----
-- $1 = file's current_stage_id, $2 = role, $3 = user id, $4 = file id,
-- $5 = 'terminal_approve' or 'terminal_reject'
SELECT at.id, at.resulting_status
FROM allowed_transitions at
JOIN files f ON f.id = $4
WHERE at.from_stage_id = $1
  AND at.to_stage_id IS NULL
  AND at.required_role = $2
  AND at.transition_type = $5
  AND f.current_holder_id = $3
  AND f.status = 'in_progress';

-- ---- C1. Perform a DISPATCH (transaction) ----
-- $1 = file id, $2 = from_stage_id, $3 = dispatching officer id,
-- $4 = next_holder_id (who it's being sent to)
BEGIN;
SELECT id FROM files WHERE id = $1 FOR UPDATE;

UPDATE files
SET pending_holder_id = $4,
    dispatched_at = now()
WHERE id = $1;

INSERT INTO custody_log (file_id, from_stage_id, to_stage_id, handled_by, transition_type, time_at_previous_stage_hours)
VALUES ($1, $2, NULL, $3, 'dispatch',
    EXTRACT(EPOCH FROM (now() - (SELECT stage_entered_at FROM files WHERE id = $1))) / 3600);
COMMIT;

-- ---- C2. Perform a RECEIVE (transaction) ----
-- $1 = file id, $2 = from_stage_id, $3 = to_stage_id, $4 = receiving officer id,
-- $5 = resulting_status
BEGIN;
SELECT id, dispatched_at FROM files WHERE id = $1 FOR UPDATE;

UPDATE files
SET current_stage_id = COALESCE($3, current_stage_id),
    current_holder_id = $4,
    pending_holder_id = NULL,
    dispatched_at = NULL,
    status = $5,
    stage_entered_at = now()
WHERE id = $1;

INSERT INTO custody_log (file_id, from_stage_id, to_stage_id, handled_by, transition_type, transit_hours)
VALUES ($1, $2, $3, $4, 'receive',
    EXTRACT(EPOCH FROM (now() - (SELECT dispatched_at FROM files WHERE id = $1))) / 3600);
COMMIT;

-- ---- C3. Perform a TERMINAL transition (approve/reject) ----
-- $1 = file id, $2 = from_stage_id, $3 = officer id, $4 = transition_type, $5 = resulting_status
BEGIN;
SELECT id FROM files WHERE id = $1 FOR UPDATE;

UPDATE files SET status = $5 WHERE id = $1;

INSERT INTO custody_log (file_id, from_stage_id, to_stage_id, handled_by, transition_type, time_at_previous_stage_hours)
VALUES ($1, $2, NULL, $3, $4,
    EXTRACT(EPOCH FROM (now() - (SELECT stage_entered_at FROM files WHERE id = $1))) / 3600);
COMMIT;

-- ---- D. Dashboard: SLA violations at current stage ----
-- $1 = role, $2 = user id  ("commissioner" sees all; others see only their own)
SELECT f.reference_number, s.stage_name, f.stage_entered_at,
       s.sla_hours,
       EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 AS hours_at_stage
FROM files f
JOIN stages s ON f.current_stage_id = s.id
WHERE f.status = 'in_progress'
  AND EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 > s.sla_hours
  AND ($1 = 'commissioner' OR f.current_holder_id = $2)
ORDER BY hours_at_stage DESC;

-- ---- E. Dashboard: per-officer pending file counts ----
-- Commissioner-only view (full org visibility)
SELECT u.full_name, u.role, COUNT(f.id) AS pending_files
FROM files f
JOIN users u ON f.current_holder_id = u.id
WHERE f.status = 'in_progress'
GROUP BY u.full_name, u.role
ORDER BY pending_files DESC;

-- ---- F. Dashboard: average processing time (approved files) ----
SELECT AVG(EXTRACT(EPOCH FROM (
    (SELECT MAX(scanned_at) FROM custody_log WHERE file_id = f.id) - f.created_at
)) / 3600) AS avg_hours_to_approval
FROM files f
WHERE f.status = 'approved';

-- ---- G. Full movement history for a file (QR / history lookup) ----
SELECT s_from.stage_name AS from_stage, s_to.stage_name AS to_stage,
       u.full_name AS handled_by, cl.transition_type, cl.scanned_at, cl.transit_hours
FROM custody_log cl
JOIN stages s_from ON cl.from_stage_id = s_from.id
LEFT JOIN stages s_to ON cl.to_stage_id = s_to.id
JOIN users u ON cl.handled_by = u.id
WHERE cl.file_id = $1
ORDER BY cl.scanned_at ASC;

-- ---- H. Dashboard: files stuck in transit (dispatched, not received, past SLA) ----
-- Commissioner-only view
SELECT f.reference_number, u.full_name AS dispatched_by,
       EXTRACT(EPOCH FROM (now() - f.dispatched_at)) / 3600 AS hours_in_transit,
       at.transit_sla_hours
FROM files f
JOIN allowed_transitions at
  ON at.from_stage_id = f.current_stage_id AND at.transition_type = 'dispatch'
JOIN users u ON f.current_holder_id = u.id
WHERE f.dispatched_at IS NOT NULL
  AND EXTRACT(EPOCH FROM (now() - f.dispatched_at)) / 3600 > at.transit_sla_hours
ORDER BY hours_in_transit DESC;
