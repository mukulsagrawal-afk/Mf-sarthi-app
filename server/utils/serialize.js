const { decrypt, maskPan } = require('./crypto');

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function rowToClient(row, { full } = { full: false }) {
  if (!row) return null;
  const pan = decrypt(row.pan);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mobile: row.mobile,
    email: row.email,
    city: row.city,
    pan: full ? pan : maskPan(pan),
    aum: row.aum,
    sipAmount: row.sip_amount,
    lastReviewDate: row.last_review_date,
    nextReviewDate: row.next_review_date,
    nextFollowupDate: row.next_followup_date,
    rm: row.rm,
    status: row.status,
    source: row.source,
    age: row.age,
    gender: row.gender,
    occupation: row.occupation,
    schemes: row.schemes,
    riskProfile: row.risk_profile,
    vip: !!row.vip,
    kycPending: !!row.kyc_pending,
    sipStopped: !!row.sip_stopped,
    goals: safeJson(row.goals_json, []),
    timeline: safeJson(row.timeline_json, []),
    tasks: safeJson(row.tasks_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { rowToClient, safeJson };
