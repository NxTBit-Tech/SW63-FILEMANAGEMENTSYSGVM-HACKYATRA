// routes/scan.js
//
// This is the actual "officer scans a physical label" entry point.
// Before this file existed, dispatch/receive routes expected a file id
// directly — but an officer scanning a barcode has a decoded STRING,
// not a database id. This route bridges that gap.
//
// Flow for the frontend:
//   1. Officer scans the barcode/QR on the physical file.
//   2. App calls GET /files/scan/:payload with the decoded string.
//   3. This route resolves it to a file + returns LIVE state (current
//      stage, current holder, SLA status) — never stale encoded data,
//      since barcode_payload is just a stable pointer (reference_number),
//      not a snapshot.
//   4. App then uses the returned file.id to call the appropriate
//      POST /files/:id/transition (dispatch/receive/terminal), same
//      as if the officer had picked the file from a list.
//
// Mounted after verifyJWT — scanning to view/act on a file requires
// login, same as every other officer action. (The citizen-facing
// lookup-by-reference-number stays on routes/public.js and returns a
// deliberately smaller payload with no officer names.)

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');

// GET /files/scan/:payload
router.get('/scan/:payload', async (req, res, next) => {
  try {
    const payload = req.params.payload;

    // barcode_payload and qr_payload both ultimately resolve via
    // reference_number — qr_payload is a JSON blob containing it, so we
    // try a direct match first (barcode case), then fall back to
    // parsing JSON and matching on the embedded referenceNumber (QR case).
    let referenceNumber = payload;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && parsed.referenceNumber) {
        referenceNumber = parsed.referenceNumber;
      }
    } catch {
      // not JSON — treat payload as a plain barcode reference number
    }

    const result = await pool.query(
      `SELECT f.id, f.reference_number, f.status, f.stage_entered_at,
              f.current_holder_id, f.pending_holder_id, f.dispatched_at,
              s.id AS stage_id, s.stage_name, s.sla_hours,
              holder.full_name AS current_holder_name,
              pending.full_name AS pending_holder_name,
              EXTRACT(EPOCH FROM (now() - f.stage_entered_at)) / 3600 AS hours_at_stage
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       LEFT JOIN users holder ON f.current_holder_id = holder.id
       LEFT JOIN users pending ON f.pending_holder_id = pending.id
       WHERE f.reference_number = $1`,
      [referenceNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No file matches this scan.' });
    }

    const file = result.rows[0];

    res.status(200).json({
      fileId: file.id,
      referenceNumber: file.reference_number,
      status: file.status,
      currentStage: { id: file.stage_id, name: file.stage_name, slaHours: file.sla_hours },
      hoursAtStage: file.hours_at_stage,
      slaStatus: file.hours_at_stage > file.sla_hours ? 'overdue' : 'on_time',
      currentHolder: file.current_holder_id
        ? { id: file.current_holder_id, name: file.current_holder_name }
        : null,
      pendingHandoff: file.pending_holder_id
        ? { pendingHolderId: file.pending_holder_id, pendingHolderName: file.pending_holder_name, dispatchedAt: file.dispatched_at }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
