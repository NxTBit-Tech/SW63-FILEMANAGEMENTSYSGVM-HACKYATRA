// app.js
// Mounting ORDER matters here:
//   1. public routes  — no auth, must never inherit verifyJWT
//   2. auth (login)   — issues the token, so it can't require one
//   3. verifyJWT       — everything below this line requires a valid token
//   4. files/transitions/workflows/dashboard — officer/commissioner routes
//   5. errorHandler    — must be LAST

const express = require('express');
const app = express();

app.use(express.json());

const { verifyJWT } = require('./middleware/auth');
const { requireRole } = require('./middleware/requireRole');
const { scopeDashboard } = require('./middleware/dashboardScope');
const { errorHandler } = require('./middleware/errorHandler');

// 1. Public — no auth
app.use('/public', require('./routes/public'));

// 2. Auth — issues tokens, no auth required to hit it
app.use('/auth', require('./routes/auth'));

// 3. Everything below requires a valid JWT
app.use(verifyJWT);

// 4. Authenticated routes
app.use('/files', require('./routes/files'));
app.use('/files', require('./routes/transitions')); // same base path, different concerns
app.use('/files', require('./routes/scan'));         // GET /files/scan/:payload
app.use('/dashboard', scopeDashboard, require('./routes/dashboard'));

// workflows.js not yet built — placeholder mount, commented out until ready:
// app.use('/workflows', requireRole('commissioner'), require('./routes/workflows'));

// 5. Central error handler — must be last
app.use(errorHandler);

module.exports = app;
