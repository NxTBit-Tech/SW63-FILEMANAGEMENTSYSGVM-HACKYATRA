// routes/transitions.js
// Wires the middleware + FSM services together. This is the shape every
// mutating file route should follow: auth -> validate -> perform -> respond.

const express = require('express');
const router = express.Router();

const { validateTransition, REASON } = require('../services/transitionValidator');
const { performTransition } = require('../services/custodyLogger');

function respondForFailure(res, reason) {
  switch (reason) {
    case REASON.FILE_NOT_FOUND:
      return res.status(404).json({ error: 'File not found.' });
    case REASON.FILE_NOT_IN_PROGRESS:
      return res.status(409).json({ error: 'File is already closed (approved/rejected).' });
    case REASON.NO_PENDING_HANDOFF:
      return res.status(409).json({ error: 'No pending handoff to receive for this file.' });
    case REASON.HANDOFF_ALREADY_PENDING:
      return res.status(409).json({ error: 'File is already dispatched and awaiting receive.' });
    case REASON.FILE_IN_TRANSIT:
      return res.status(409).json({ error: 'File is in transit — complete the pending receive first.' });
    case REASON.INVALID_NEXT_HOLDER:
      return res.status(400).json({ error: 'A valid nextHolderId is required for dispatch.' });
    case REASON.INVALID_REQUEST:
      return res.status(400).json({ error: 'Invalid transition request.' });
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
router.post('/:id/transition', async (req, res, next) => {
  const fileId = parseInt(req.params.id, 10);
  const { transitionType, toStageId = null, nextHolderId = null } = req.body;
  const { id: userId, role } = req.user;

  if (!Number.isInteger(fileId) || fileId <= 0) {
    return res.status(400).json({ error: 'Invalid file id.' });
  }

  if (!transitionType || typeof transitionType !== 'string') {
    return res.status(400).json({ error: 'transitionType is required.' });
  }

  try {
    const validation = await validateTransition({
      fileId,
      userId,
      role,
      toStageId,
      transitionType,
      nextHolderId,
    });

    if (!validation.ok) {
      return respondForFailure(res, validation.reason);
    }

    const result = await performTransition({
      fileId,
      userId,
      transitionType,
      transition: validation.transition,
      file: validation.file,
    });

    return res.status(200).json({ ok: true, file: result.file });
  } catch (err) {
    if (err.statusCode && err.reason) {
      return respondForFailure(res, err.reason);
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
