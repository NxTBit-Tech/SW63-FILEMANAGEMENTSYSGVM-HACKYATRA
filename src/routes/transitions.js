// routes/transitions.js
// Wires the middleware + FSM services together. This is the shape every
// mutating file route should follow: auth -> validate -> perform -> respond.

const express = require('express');
const router = express.Router();

const { verifyJWT } = require('../middleware/auth');
const { validateTransition, REASON } = require('../services/transitionValidator');
const { performTransition } = require('../services/custodyLogger');

router.use(verifyJWT); // every route below requires a valid token

// Maps validator failure reasons to distinct, honest HTTP responses.
// Officers should never see a generic "not allowed" when the real
// issue is specifically "this isn't your file."
function respondForFailure(res, reason) {
  switch (reason) {
    case REASON.FILE_NOT_FOUND:
      return res.status(404).json({ error: 'File not found.' });
    case REASON.FILE_NOT_IN_PROGRESS:
      return res.status(409).json({ error: 'File is already closed (approved/rejected).' });
    case REASON.NO_PENDING_HANDOFF:
      return res.status(409).json({ error: 'No pending handoff to receive for this file.' });
    case REASON.INVALID_TRANSITION:
      return res.status(400).json({ error: 'This move is not valid from the file\'s current stage.' });
    case REASON.WRONG_ROLE:
      return res.status(403).json({ error: 'Your role cannot perform this action.' });
    case REASON.NOT_CURRENT_HOLDER:
      return res.status(403).json({ error: 'You do not currently hold this file.' });
    case REASON.NOT_PENDING_HOLDER:
      return res.status(403).json({ error: 'This file was not dispatched to you.' });
    default:
      return res.status(400).json({ error: 'Transition rejected.' });
  }
}

// POST /files/:id/transition
// body: { transitionType, toStageId, nextHolderId? }
// nextHolderId is required for 'dispatch' — who the file is being sent to.
router.post('/:id/transition', async (req, res) => {
  const fileId = parseInt(req.params.id, 10);
  const { transitionType, toStageId = null, nextHolderId = null } = req.body;
  const { id: userId, role } = req.user;

  try {
    const validation = await validateTransition({
      fileId,
      userId,
      role,
      toStageId,
      transitionType,
    });

    if (!validation.ok) {
      return respondForFailure(res, validation.reason);
    }

    if (transitionType === 'dispatch') {
      // next_holder_id isn't part of allowed_transitions (it's a runtime
      // choice, not a fixed rule) — attach it onto the transition object
      // custodyLogger expects.
      validation.transition.next_holder_id = nextHolderId;
    }

    await performTransition({
      fileId,
      userId,
      transitionType,
      transition: validation.transition,
      file: validation.file,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Transition error:', err);
    return res.status(500).json({ error: 'Internal error performing transition.' });
  }
});

module.exports = router;
