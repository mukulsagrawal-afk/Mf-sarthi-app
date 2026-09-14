// Sends email, or - if no SMTP credentials are configured - logs what *would* have
// been sent to server/data/email-log.jsonl. This lets the whole reminder pipeline be
// built, run, and demoed today, and become "real" the moment real SMTP creds are
// dropped into .env. Nothing about the app's logic changes either way.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'email-log.jsonl');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html, attachments }) {
  if (!isConfigured()) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ to, subject, text, sentAt: new Date().toISOString(), mode: 'DRY_RUN', hasAttachments: !!(attachments && attachments.length) }) + '\n');
    return { mode: 'dry_run' };
  }
  const t = getTransporter();
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html, attachments });
  return { mode: 'sent' };
}

module.exports = { sendMail, isConfigured };
