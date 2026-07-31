// services/custodyLogger.js
//
// Performs the actual state change, inside a single locked transaction,
// AFTER transitionValidator.validateTransition() has already returned ok:true.
// Re-checks custody on the locked row before writing.
//
// Behavior differs by transition_type:
//   dispatch          -> sets pending_holder_id + dispatched_at, stage/holder unchanged
//   receive           -> confirms custody, advances stage, clears pending fields,
//                        computes transit_hours (dispatch -> receive gap)
//   terminal_approve/
//   terminal_reject   -> ends the file's life, clears any in-transit fields

const pool = require('../db/pool');
const { assertCustody } = require('./transitionValidator');

function hoursSince(timestamp) {
  if (!timestamp) return null;
  return (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
}

async function performTransition({ fileId, userId, transitionType, transition, file }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const lockedResult = await client.query(
      `SELECT id, current_stage_id, current_holder_id, pending_holder_id,
              status, stage_entered_at, dispatched_at
       FROM files WHERE id = $1 FOR UPDATE`,
      [fileId]
    );

    if (lockedResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('File not found during transition.');
      err.statusCode = 404;
      throw err;
    }

    const lockedFile = lockedResult.rows[0];

    if (lockedFile.status !== 'in_progress') {
      await client.query('ROLLBACK');
      const err = new Error('File is no longer in progress.');
      err.statusCode = 409;
      throw err;
    }

    const custodyFailure = assertCustody(lockedFile, userId, transitionType);
    if (custodyFailure) {
      await client.query('ROLLBACK');
      const err = new Error('Custody check failed on locked row.');
      err.statusCode = 409;
      err.reason = custodyFailure;
      throw err;
    }

    const stageEnteredAt = lockedFile.stage_entered_at;
    const dispatchedAt = lockedFile.dispatched_at;
    const timeAtPreviousStageHours = hoursSince(stageEnteredAt);
    const custodyToStageId = transition.to_stage_id;
    let transitHours = null;

    if (transitionType === 'dispatch') {
      await client.query(
        `UPDATE files
         SET pending_holder_id = $1, dispatched_at = now()
         WHERE id = $2`,
        [transition.next_holder_id, fileId]
      );
    }

    if (transitionType === 'receive') {
      transitHours = hoursSince(dispatchedAt);

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

    if (transitionType === 'terminal_approve' || transitionType === 'terminal_reject') {
      await client.query(
        `UPDATE files
         SET status = $1,
             pending_holder_id = NULL,
             dispatched_at = NULL
         WHERE id = $2`,
        [transition.resulting_status, fileId]
      );
    }

    await client.query(
      `INSERT INTO custody_log
         (file_id, from_stage_id, to_stage_id, handled_by, transition_type,
          time_at_previous_stage_hours, transit_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fileId,
        file.current_stage_id,
        custodyToStageId,
        userId,
        transitionType,
        timeAtPreviousStageHours,
        transitHours,
      ]
    );

    const updatedResult = await client.query(
      `SELECT f.id, f.reference_number, f.status, f.current_stage_id,
              f.current_holder_id, f.pending_holder_id, f.dispatched_at,
              f.stage_entered_at, s.stage_name
       FROM files f
       JOIN stages s ON f.current_stage_id = s.id
       WHERE f.id = $1`,
      [fileId]
    );

    await client.query('COMMIT');
    return { ok: true, file: updatedResult.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { performTransition };
