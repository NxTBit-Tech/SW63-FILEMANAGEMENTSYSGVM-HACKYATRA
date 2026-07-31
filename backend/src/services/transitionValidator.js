// services/transitionValidator.js
//
// This is the finite state machine's enforcement layer. It never trusts
// the frontend's idea of "what stage the file is in" — it always reads
// current DB state and checks the request against allowed_transitions.
//
// Three checks happen for every transition, in this order:
//   1. Is this a legal move at all (from_stage + to_stage + type + role
//      exists as a row in allowed_transitions)?
//   2. Does the requesting officer's role match required_role?
//   3. CUSTODY CHECK — does this specific officer actually hold the file
//      right now? Role alone is never sufficient.
//
// Custody check differs by transition_type:
//   - 'dispatch'         -> requester must be files.current_holder_id
//   - 'receive'          -> requester must be files.pending_holder_id
//   - 'terminal_approve' -> requester must be files.current_holder_id
//   - 'terminal_reject'  -> requester must be files.current_holder_id
//
// Returns a result object instead of throwing, so the route layer can
// return distinct, honest error messages (invalid move vs wrong role
// vs "not your file") rather than one generic 403.

const pool = require('../db/pool');

const REASON = {
  OK: 'OK',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_NOT_IN_PROGRESS: 'FILE_NOT_IN_PROGRESS',
  INVALID_TRANSITION: 'INVALID_TRANSITION', // no matching rule at all
  WRONG_ROLE: 'WRONG_ROLE',
  NOT_CURRENT_HOLDER: 'NOT_CURRENT_HOLDER', // dispatch/terminal custody fail
  NOT_PENDING_HOLDER: 'NOT_PENDING_HOLDER', // receive custody fail
  NO_PENDING_HANDOFF: 'NO_PENDING_HANDOFF', // trying to receive but nothing was dispatched
};

/**
 * @param {object} params
 * @param {number} params.fileId
 * @param {number} params.userId - requesting officer's id (from JWT)
 * @param {string} params.role - requesting officer's role (from JWT)
 * @param {number|null} params.toStageId - target stage, null for terminal moves
 * @param {string} params.transitionType - 'advance' | 'send_back' | 'dispatch' | 'receive' | 'terminal_approve' | 'terminal_reject'
 * @returns {Promise<{ ok: boolean, reason: string, transition?: object, file?: object }>}
 */
async function validateTransition({ fileId, userId, role, toStageId, transitionType }) {
  const fileResult = await pool.query(
    `SELECT id, current_stage_id, current_holder_id, pending_holder_id, status
     FROM files WHERE id = $1`,
    [fileId]
  );

  if (fileResult.rows.length === 0) {
    return { ok: false, reason: REASON.FILE_NOT_FOUND };
  }

  const file = fileResult.rows[0];

  if (file.status !== 'in_progress') {
    return { ok: false, reason: REASON.FILE_NOT_IN_PROGRESS };
  }

  // Custody check happens BEFORE the rule lookup for receive, because a
  // missing pending_holder_id means there's nothing to receive at all —
  // that's a more useful error than a generic "invalid transition."
  if (transitionType === 'receive' && file.pending_holder_id === null) {
    return { ok: false, reason: REASON.NO_PENDING_HANDOFF };
  }

  // Step 1 + 2: is this a legal rule, and does the role match?
  // We look up by from_stage + type first (ignoring role) so we can tell
  // "invalid move" apart from "valid move, wrong role."
  const ruleResult = await pool.query(
    `SELECT id, required_role, resulting_status, to_stage_id
     FROM allowed_transitions
     WHERE from_stage_id = $1
       AND to_stage_id IS NOT DISTINCT FROM $2
       AND transition_type = $3`,
    [file.current_stage_id, toStageId, transitionType]
  );

  if (ruleResult.rows.length === 0) {
    return { ok: false, reason: REASON.INVALID_TRANSITION };
  }

  const rule = ruleResult.rows[0];

  if (rule.required_role !== role) {
    return { ok: false, reason: REASON.WRONG_ROLE };
  }

  // Step 3: custody check — the part role-based RBAC alone misses.
  if (transitionType === 'dispatch' || transitionType === 'terminal_approve' || transitionType === 'terminal_reject') {
    if (file.current_holder_id !== userId) {
      return { ok: false, reason: REASON.NOT_CURRENT_HOLDER };
    }
  }

  if (transitionType === 'receive') {
    if (file.pending_holder_id !== userId) {
      return { ok: false, reason: REASON.NOT_PENDING_HOLDER };
    }
  }

  return { ok: true, reason: REASON.OK, transition: rule, file };
}

module.exports = { validateTransition, REASON };
