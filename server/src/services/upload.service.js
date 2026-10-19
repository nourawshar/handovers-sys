'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');
const { badRequest } = require('../utils/errors');

const UPLOAD_ROOT = path.resolve(config.UPLOAD_DIR);
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Verify real content type from magic bytes (client-supplied mimetype is not trusted). */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Memory storage + magic-byte check, then a single write to disk — nothing invalid ever touches the disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED[file.mimetype]) return cb(badRequest('Only JPEG, PNG or WebP images are allowed'));
    cb(null, true);
  },
});

/** Persist validated image buffers under UPLOAD_ROOT/<bucket>/<yyyy-mm>/<uuid>.<ext>. Returns metadata rows. */
async function persistImages(files, bucket) {
  const saved = [];
  try {
    for (const f of files) {
      const mime = sniffImage(f.buffer);
      if (!mime || mime !== f.mimetype) throw badRequest(`"${f.originalname}" is not a valid ${f.mimetype} image`);
      const d = new Date();
      const rel = path.join(bucket, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, `${crypto.randomUUID()}.${ALLOWED[mime]}`);
      const abs = path.join(UPLOAD_ROOT, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, f.buffer, { flag: 'wx', mode: 0o640 });
      saved.push({ fileName: path.basename(f.originalname).slice(0, 200), path: rel, mimeType: mime, sizeBytes: f.size });
    }
  } catch (e) {
    await Promise.all(saved.map((s) => removeFile(s.path)));
    throw e;
  }
  return saved;
}

/** Resolve a stored relative path safely (prevents traversal). */
function resolveStored(rel) {
  const abs = path.resolve(UPLOAD_ROOT, rel);
  if (!abs.startsWith(UPLOAD_ROOT + path.sep)) throw new Error('Invalid stored path');
  return abs;
}

const removeFile = (rel) => fs.promises.unlink(resolveStored(rel)).catch(() => {});

module.exports = { upload, persistImages, resolveStored, removeFile, UPLOAD_ROOT };
