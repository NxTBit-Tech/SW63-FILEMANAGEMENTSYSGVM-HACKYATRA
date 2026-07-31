// routes/dashboard.js
// Mounted with scopeDashboard middleware in app.js. Only the Commissioner
// gets full visibility (E and H below are commissioner-only); everyone
// else's SLA view (D) is scoped to their own held files by the WHERE clause.

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { requireRole } = require('../middleware/requireRole');

// GET /dashboard/sla-violations
// Commissioner sees all overdue files; others see only their own.
router.get('/sla-violations', async (req, res, next) => {
  try {
    const { role, userId } = req.dashboardScope;

    const result = await pool.query(
      `SELECT f.reference_number, s.stage_name, f.stage_entered_at, s.sla_hours,
              EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 AS hours_at_stage
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       WHERE f.status = 'in_progress'
         AND EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 > s.sla_hours
         AND ($1 = 'commissioner' OR f.current_holder_id = $2)
       ORDER BY hours_at_stage DESC`,
      [role, userId]
    );

    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/pending
// Same scoping pattern — "my desk" for officers, "everyone's desk" for commissioner.
router.get('/pending', async (req, res, next) => {
  try {
    const { role, userId } = req.dashboardScope;

    const result = await pool.query(
      `SELECT f.reference_number, s.stage_name, f.stage_entered_at, s.sla_hours,
              EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 AS hours_at_stage
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       WHERE f.status = 'in_progress'
         AND ($1 = 'commissioner' OR f.current_holder_id = $2)
       ORDER BY hours_at_stage DESC`,
      [role, userId]
    );

    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/officer-load — commissioner-only, full org visibility
router.get('/officer-load', requireRole('commissioner'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.full_name, u.role, COUNT(f.id) AS pending_files
       FROM files f
       JOIN users u ON f.current_holder_id = u.id
       WHERE f.status = 'in_progress'
       GROUP BY u.full_name, u.role
       ORDER BY pending_files DESC`
    );

    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/avg-processing-time — commissioner-only
router.get('/avg-processing-time', requireRole('commissioner'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (
           (SELECT MAX(scanned_at) FROM custody_log WHERE file_id = f.id) - f.created_at
         )) / 3600) AS avg_hours_to_approval
       FROM files f
       WHERE f.status = 'approved'`
    );

    res.status(200).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/in-transit — commissioner-only, files stuck between dispatch and receive
router.get('/in-transit', requireRole('commissioner'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT f.reference_number, u.full_name AS dispatched_by,
              EXTRACT(EPOCH FROM (now() - f.dispatched_at)) / 3600 AS hours_in_transit,
              at.transit_sla_hours
       FROM files f
       JOIN allowed_transitions at
         ON at.from_stage_id = f.current_stage_id AND at.transition_type = 'dispatch'
       JOIN users u ON f.current_holder_id = u.id
       WHERE f.dispatched_at IS NOT NULL
         AND EXTRACT(EPOCH FROM (now() - f.dispatched_at)) / 3600 > at.transit_sla_hours
       ORDER BY hours_in_transit DESC`
    );

    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/history/:fileId — movement history, any authenticated role
router.get('/history/:fileId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s_from.stage_name AS from_stage, s_to.stage_name AS to_stage,
              u.full_name AS handled_by, cl.transition_type, cl.scanned_at, cl.transit_hours
       FROM custody_log cl
       JOIN stages s_from ON cl.from_stage_id = s_from.id
       LEFT JOIN stages s_to ON cl.to_stage_id = s_to.id
       JOIN users u ON cl.handled_by = u.id
       WHERE cl.file_id = $1
       ORDER BY cl.scanned_at ASC`,
      [req.params.fileId]
    );

    res.status(200).json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
