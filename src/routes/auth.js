// routes/auth.js
// The one route that issues tokens. No verifyJWT here — you can't have
// a valid token yet if you're trying to log in.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();

const pool = require('../db/pool');
const { jwtSecret } = require('../config/env');

// POST /auth/login
// body: { email, password }
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await pool.query(
      `SELECT id, full_name, email, password_hash, role FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      jwtSecret,
      { expiresIn: '12h' }
    );

    res.status(200).json({
      token,
      user: { id: user.id, fullName: user.full_name, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
