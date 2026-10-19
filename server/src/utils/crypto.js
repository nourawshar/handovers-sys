'use strict';
const crypto = require('node:crypto');
const config = require('../config');

const KEY = Buffer.from(config.CREDENTIALS_ENC_KEY, 'hex');
const VERSION = 'v1';

/** AES-256-GCM. Output: "v1:" + base64(iv(12) | authTag(16) | ciphertext) */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

function decrypt(payload) {
  const [ver, b64] = String(payload).split(':');
  if (ver !== VERSION || !b64) throw new Error('Unsupported ciphertext format');
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { encrypt, decrypt, sha256 };
