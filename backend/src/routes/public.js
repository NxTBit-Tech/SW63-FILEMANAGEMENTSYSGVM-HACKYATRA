// routes/public.js
// NO auth middleware on this router at all — mounted separately in
// app.js, before verifyJWT is applied. This is the one place req.user
// does not exist by design.
//
// Field discipline: this must NEVER grow to include applicant_name,
// applicant_contact, property_address, or officer names. If a future
// requirement needs those, add a NEW route — don't extend this one.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const pool = require('../db/pool');

const publicLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 requests/min per IP — prevents reference-number enumeration
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLookupLimiter);

// GET /public/status/:referenceNumber
router.get('/status/:referenceNumber', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT f.reference_number, s.stage_name, f.status, f.stage_entered_at
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       WHERE f.reference_number = $1`,
      [req.params.referenceNumber]
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
