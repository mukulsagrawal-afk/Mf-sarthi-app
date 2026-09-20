const db = require('../db');

function configuredAdminEmails() {
  return new Set(String(process.env.SITE_ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}

function isSiteAdmin(userId) {
  const user = db.prepare('SELECT email,role FROM users WHERE id=?').get(Number(userId));
  if (!user) return false;
  return user.role === 'admin' || configuredAdminEmails().has(String(user.email).toLowerCase());
}

function requireSiteAdmin(req,res,next) {
  if (!isSiteAdmin(req.user.id)) return res.status(403).json({error:'This action is available only to the MF Sarthi site administrator.'});
  next();
}

module.exports = { isSiteAdmin, requireSiteAdmin };
