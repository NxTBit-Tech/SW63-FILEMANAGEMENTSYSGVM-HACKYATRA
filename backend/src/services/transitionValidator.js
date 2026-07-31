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

const PILOT_TRANSITION_TYPES = [
  'dispatch',
  'receive',
  'terminal_approve',
  'terminal_reject',
];

const IN_TRANSIT_BLOCK_TYPES = [
  'dispatch',
  'terminal_approve',
  'terminal_reject',
];

const REASON = {
  OK: 'OK',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_NOT_IN_PROGRESS: 'FILE_NOT_IN_PROGRESS',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  WRONG_ROLE: 'WRONG_ROLE',
  NOT_CURRENT_HOLDER: 'NOT_CURRENT_HOLDER',
  NOT_PENDING_HOLDER: 'NOT_PENDING_HOLDER',
  NO_PENDING_HANDOFF: 'NO_PENDING_HANDOFF',
  HANDOFF_ALREADY_PENDING: 'HANDOFF_ALREADY_PENDING',
  FILE_IN_TRANSIT: 'FILE_IN_TRANSIT',
  INVALID_NEXT_HOLDER: 'INVALID_NEXT_HOLDER',
};

function assertCustody(file, userId, transitionType) {
  if (transitionType === 'receive') {
    if (file.pending_holder_id === null) {
      return REASON.NO_PENDING_HANDOFF;
    }
    if (file.pending_holder_id !== userId) {
      return REASON.NOT_PENDING_HOLDER;
    }
    return null;
  }

  if (
    transitionType === 'dispatch' ||
    transitionType === 'terminal_approve' ||
    transitionType === 'terminal_reject'
  ) {
    if (file.current_holder_id !== userId) {
      return REASON.NOT_CURRENT_HOLDER;
    }
  }

  return null;
}

/**
 * @param {object} params
 * @param {number} params.fileId
 * @param {number} params.userId
 * @param {string} params.role
 * @param {number|null} params.toStageId
 * @param {string} params.transitionType
 * @param {number|null} [params.nextHolderId]
 */
async function validateTransition({
  fileId,
  userId,
  role,
  toStageId,
  transitionType,
  nextHolderId = null,
}) {
  if (!PILOT_TRANSITION_TYPES.includes(transitionType)) {
    return { ok: false, reason: REASON.INVALID_TRANSITION };
  }

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

  if (file.pending_holder_id !== null && IN_TRANSIT_BLOCK_TYPES.includes(transitionType)) {
    if (transitionType === 'dispatch') {
      return { ok: false, reason: REASON.HANDOFF_ALREADY_PENDING };
    }
    return { ok: false, reason: REASON.FILE_IN_TRANSIT };
  }

  if (transitionType === 'receive' && file.pending_holder_id === null) {
    return { ok: false, reason: REASON.NO_PENDING_HANDOFF };
  }

  const effectiveToStageId =
    transitionType === 'terminal_approve' || transitionType === 'terminal_reject'
      ? null
      : toStageId;

  const ruleResult = await pool.query(
    `SELECT id, required_role, resulting_status, to_stage_id
     FROM allowed_transitions
     WHERE from_stage_id = $1
       AND to_stage_id IS NOT DISTINCT FROM $2
       AND transition_type = $3`,
    [file.current_stage_id, effectiveToStageId, transitionType]
  );

  if (ruleResult.rows.length === 0) {
    return { ok: false, reason: REASON.INVALID_TRANSITION };
  }

  const rule = ruleResult.rows[0];

  if (rule.required_role !== role) {
    return { ok: false, reason: REASON.WRONG_ROLE };
  }

  const custodyFailure = assertCustody(file, userId, transitionType);
  if (custodyFailure) {
    return { ok: false, reason: custodyFailure };
  }

  if (transitionType === 'dispatch') {
    const parsedNextHolderId = parseInt(nextHolderId, 10);
    if (!parsedNextHolderId || parsedNextHolderId <= 0) {
      return { ok: false, reason: REASON.INVALID_NEXT_HOLDER };
    }
    if (parsedNextHolderId === userId) {
      return { ok: false, reason: REASON.INVALID_NEXT_HOLDER };
    }

    const recipientResult = await pool.query(
      `SELECT id, role FROM users WHERE id = $1`,
      [parsedNextHolderId]
    );
    if (recipientResult.rows.length === 0) {
      return { ok: false, reason: REASON.INVALID_NEXT_HOLDER };
    }

    const receiveRuleResult = await pool.query(
      `SELECT required_role
       FROM allowed_transitions
       WHERE from_stage_id = $1
         AND to_stage_id IS NOT DISTINCT FROM $2
         AND transition_type = 'receive'`,
      [file.current_stage_id, rule.to_stage_id]
    );
    if (receiveRuleResult.rows.length === 0) {
      return { ok: false, reason: REASON.INVALID_TRANSITION };
    }

    if (receiveRuleResult.rows[0].required_role !== recipientResult.rows[0].role) {
      return { ok: false, reason: REASON.INVALID_NEXT_HOLDER };
    }

    rule.next_holder_id = parsedNextHolderId;
  }

  return { ok: true, reason: REASON.OK, transition: rule, file };
}

module.exports = {
  validateTransition,
  assertCustody,
  REASON,
  PILOT_TRANSITION_TYPES,
};
