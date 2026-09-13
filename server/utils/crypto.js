// Field-level encryption for sensitive data (PAN numbers) at rest.
// Uses AES-256-GCM. The key comes from the ENCRYPTION_KEY env var (32 bytes, base64).
// If ENCRYPTION_KEY is missing, the server refuses to start (see server/index.js) —
// we never silently store sensitive fields in plaintext.

const crypto = require('crypto');

function getKey() {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (see .env.example)');
  }
  return key;
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv.tag.ciphertext, all base64
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(stored) {
  if (!stored) return null;
  const parts = stored.split('.');
  if (parts.length !== 3) return null; // not our format — treat as unreadable rather than throw
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const key = getKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null; // wrong key / tampered data — never crash the request over one bad field
  }
}

// Mask a PAN for display in lists (e.g. table rows) without a full decrypt round-trip need:
// ABCDE1234F -> ABCDEXXXXF style masking is done by the caller after decrypt(); this helper
// masks a plaintext PAN for UI contexts where the full value isn't needed.
function maskPan(pan) {
  if (!pan || pan.length < 4) return '••••';
  return pan.slice(0, 2) + '••••••' + pan.slice(-2);
}

module.exports = { encrypt, decrypt, maskPan };
