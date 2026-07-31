// middleware/requireRole.js
// Route-level RBAC gate. This checks ROLE ONLY — it does not know about
// custody (who currently holds a file). That check lives in
// services/transitionValidator.js and must run separately for any
// route that mutates a specific file's state.
//
// Usage:
//   router.post('/files', requireRole('revenue_inspector'), handler)
//   router.get('/dashboard/full', requireRole('commissioner'), handler)

function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      // auth middleware should always run first; this is a safety net
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role does not permit this action.' });
    }

    next();
  };
}

module.exports = { requireRole };
