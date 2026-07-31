// middleware/errorHandler.js
// Last middleware in the chain. Catches anything thrown/passed via next(err)
// that individual routes didn't already handle. Never leak raw DB error
// messages to the client — log them, return a generic message.

function errorHandler(err, req, res, next) {
  console.error('Unhandled error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: 'Internal server error.' });
}

module.exports = { errorHandler };
