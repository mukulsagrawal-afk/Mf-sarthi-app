const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  // Cookie-only: the session token lives in an httpOnly cookie, never in JS-readable
  // storage or request headers, so it can't be lifted by an XSS payload on the page.
  const token = req.cookies?.mfs_token;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, name }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired - please sign in again' });
  }
}

module.exports = { requireAuth };
