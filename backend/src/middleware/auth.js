// middleware/auth.js
// Verifies the JWT and attaches { id, role } to req.user.
// This is the ONLY place req.user gets set — every other middleware
// and route handler downstream trusts this without re-checking the token.
//
// Mount this on all officer/commissioner routes. Do NOT mount it on
// the public routes (status lookup) — those must work with no token.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — refusing to start with an insecure default.');
}

function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // decoded is expected to contain { id, role } at minimum — these are
    // set at login time (see auth/login route, not included here).
    if (!decoded.id || !decoded.role) {
      return res.status(401).json({ error: 'Token missing required claims.' });
    }

    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { verifyJWT };
