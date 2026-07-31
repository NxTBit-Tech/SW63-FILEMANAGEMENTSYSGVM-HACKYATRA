// services/custodyLogger.js
//
// Performs the actual state change, inside a single locked transaction,
// AFTER transitionValidator.validateTransition() has already returned ok:true.
// This file assumes validation already happened — it does not re-check
// custody or role. Never call this directly from a route without validating first.
//
// Behavior differs by transition_type:
//   dispatch          -> sets pending_holder_id + dispatched_at, stage/holder unchanged
//   receive           -> confirms custody, advances stage, clears pending fields,
//                        computes transit_hours (dispatch -> receive gap)
//   advance/send_back -> only reachable directly if you're NOT using dispatch/receive
//                        for that particular rule (kept for stages not yet migrated)
//   terminal_approve/
//   terminal_reject   -> ends the file's life, no next stage

const pool = require('../db/pool');

async function performTransition({ fileId, userId, transitionType, transition, file }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the row so a concurrent scan on this file can't read stale
    // state mid-transaction. Must happen before any read/write below.
    await client.query('SELECT id FROM files WHERE id = $1 FOR UPDATE', [fileId]);

    let custodyToStageId = transition.to_stage_id;
    let transitHours = null;

    if (transitionType === 'dispatch') {
      await client.query(
        `UPDATE files
         SET pending_holder_id = $1, dispatched_at = now()
         WHERE id = $2`,
        [/* nextHolderId must be supplied by caller/route */ transition.next_holder_id, fileId]
      );
      // Stage/status/current_holder_id intentionally unchanged until receive.
    }

    if (transitionType === 'receive') {
      const dispatchInfo = await client.query(
        `SELECT dispatched_at FROM files WHERE id = $1`,
        [fileId]
      );
      const dispatchedAt = dispatchInfo.rows[0].dispatched_at;
      transitHours = dispatchedAt
        ? (Date.now() - new Date(dispatchedAt).getTime()) / (1000 * 60 * 60)
        : null;

      await client.query(
        `UPDATE files
         SET current_stage_id = COALESCE($1, current_stage_id),
             current_holder_id = $2,
             pending_holder_id = NULL,
             dispatched_at = NULL,
             status = $3,
             stage_entered_at = now()
         WHERE id = $4`,
        [transition.to_stage_id, userId, transition.resulting_status, fileId]
      );
    }

    if (transitionType === 'advance' || transitionType === 'send_back') {
      await client.query(
        `UPDATE files
         SET current_stage_id = COALESCE($1, current_stage_id),
             status = $2,
             stage_entered_at = now()
         WHERE id = $3`,
        [transition.to_stage_id, transition.resulting_status, fileId]
      );
    }

    if (transitionType === 'terminal_approve' || transitionType === 'terminal_reject') {
      await client.query(
        `UPDATE files
         SET status = $1
         WHERE id = $2`,
        [transition.resulting_status, fileId]
      );
    }

    await client.query(
      `INSERT INTO custody_log
         (file_id, from_stage_id, to_stage_id, handled_by, transition_type,
          time_at_previous_stage_hours, transit_hours)
       VALUES ($1, $2, $3, $4, $5,
         EXTRACT(EPOCH FROM (now() - (SELECT stage_entered_at FROM files WHERE id = $1))) / 3600,
         $6)`,
      [fileId, file.current_stage_id, custodyToStageId, userId, transitionType, transitHours]
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { performTransition };
