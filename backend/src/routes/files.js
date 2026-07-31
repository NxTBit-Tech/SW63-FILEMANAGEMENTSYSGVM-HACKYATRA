// routes/files.js
// File CREATION is a separate entry point from transitions — it isn't
// a "move" in allowed_transitions, it's the origin of a file's life.
// Mounted after verifyJWT in app.js.

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { requireRole } = require('../middleware/requireRole');
const { buildQrPayload, buildBarcodePayload } = require('../services/payloadService');

// Reference numbers are generated server-side, never trusted from the
// client — this is also what both payloads get derived from, so the
// client never gets to choose what a scan resolves to.
function generateReferenceNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.floor(1000 + Math.random() * 9000); // 4-digit suffix
  return `TP-${datePart}-${randomPart}`;
}

// POST /files
// Only revenue_inspector can create a file — they own stage 1 (Submitted).
// body: { applicantName, applicantContact, propertyAddress }
router.post('/', requireRole('revenue_inspector'), async (req, res, next) => {
  try {
    const { applicantName, applicantContact, propertyAddress } = req.body;

    if (!applicantName) {
      return res.status(400).json({ error: 'applicantName is required.' });
    }

    // Stage 1 ("Submitted") is fixed for new files in this pilot's workflow.
    const stageResult = await pool.query(
      `SELECT id FROM stages WHERE stage_order = 1 AND department_id = 1`
    );
    if (stageResult.rows.length === 0) {
      return res.status(500).json({ error: 'Stage 1 not configured for this department.' });
    }
    const stage1Id = stageResult.rows[0].id;

    // fullName isn't on the JWT (only id + role are, by design — see
    // middleware/auth.js) so it's looked up fresh here rather than trusted
    // from the token or the request body.
    const creatorResult = await pool.query(
      `SELECT full_name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const creatorName = creatorResult.rows[0]?.full_name || 'Unknown';

    const referenceNumber = generateReferenceNumber();
    const createdAt = new Date().toISOString();

    const qrPayload = buildQrPayload({
      referenceNumber,
      department: 'Town Planning',
      createdByName: creatorName,
      createdAt,
    });
    const barcodePayload = buildBarcodePayload({ referenceNumber });

    // Retry once on the rare reference_number collision (random suffix clash).
    let insertResult;
    try {
      insertResult = await pool.query(
        `INSERT INTO files
           (reference_number, applicant_name, applicant_contact, property_address,
            current_stage_id, current_holder_id, qr_payload, barcode_payload, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)
         RETURNING id, reference_number, current_stage_id, status, qr_payload, barcode_payload`,
        [
          referenceNumber,
          applicantName,
          applicantContact || null,
          propertyAddress || null,
          stage1Id,
          req.user.id, // creator is also the initial holder
          qrPayload,
          barcodePayload,
        ]
      );
    } catch (err) {
      if (err.code === '23505') {
        // extremely unlikely collision on the random suffix — regenerate once
        const retryRef = generateReferenceNumber();
        const retryBarcode = buildBarcodePayload({ referenceNumber: retryRef });
        const retryQr = buildQrPayload({
          referenceNumber: retryRef,
          department: 'Town Planning',
          createdByName: creatorName,
          createdAt,
        });
        insertResult = await pool.query(
          `INSERT INTO files
             (reference_number, applicant_name, applicant_contact, property_address,
              current_stage_id, current_holder_id, qr_payload, barcode_payload, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)
           RETURNING id, reference_number, current_stage_id, status, qr_payload, barcode_payload`,
          [retryRef, applicantName, applicantContact || null, propertyAddress || null,
           stage1Id, req.user.id, retryQr, retryBarcode]
        );
      } else {
        throw err;
      }
    }

    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /files/:id — basic detail view for the file detail screen
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT f.*, s.stage_name
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
