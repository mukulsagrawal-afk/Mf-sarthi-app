const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isSiteAdmin } = require('../utils/siteAdmin');

const router = express.Router();

// Brute-force protection on auth endpoints specifically (tighter than the global limiter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setAuthCookie(res, token) {
  res.cookie('mfs_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

router.post('/signup', authLimiter, (req, res) => {
  const { name, email, password, arn, city } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const emailNorm = String(email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const hash = bcrypt.hashSync(String(password), 12);
  const info = db.prepare(
    `INSERT INTO users (name, email, password_hash, arn, city) VALUES (?, ?, ?, ?, ?)`
  ).run(String(name).trim(), emailNorm, hash, arn || null, city || null);

  const user = { id: info.lastInsertRowid, email: emailNorm, name: String(name).trim() };
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user });
});

router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const emailNorm = String(email).trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);

  // Same generic error whether the email doesn't exist or the password is wrong -
  // never reveal which one it was, that's an account-enumeration leak.
  if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(row.id);
  const user = { id: row.id, email: row.email, name: row.name };
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user });
});

router.post('/logout', (req, res) => {
  res.clearCookie('mfs_token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, name, email, arn, city, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ user: {...row,isSiteAdmin:isSiteAdmin(req.user.id)} });
});

module.exports = router;
