// middleware/dashboardScope.js
// Only the Commissioner gets full visibility. Every other role's
// dashboard queries are scoped to their own held files.
// Attaches req.dashboardScope so route handlers pass it straight
// into their SQL as query params — no branching query logic needed.

function scopeDashboard(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  req.dashboardScope = {
    role: req.user.role,
    userId: req.user.id,
    isFull: req.user.role === 'commissioner',
  };

  next();
}

module.exports = { scopeDashboard };
