'use strict';
// پشتیبان‌گیری امن از دیتابیس زنده (VACUUM INTO). با cron روزانه اجرا شود:
//   0 3 * * * cd /opt/bime-dey && /usr/bin/node backup.js
// نگه می‌دارد: ۱۴ نسخه آخر. مسیر: data/backups
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bime.db');
const DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 14;

fs.mkdirSync(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(DIR, `bime-${stamp}.db`);
const db = new DatabaseSync(DB_PATH);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();

const files = fs.readdirSync(DIR).filter(f => /^bime-.*\.db$/.test(f)).sort();
files.slice(0, Math.max(0, files.length - KEEP)).forEach(f => fs.unlinkSync(path.join(DIR, f)));
console.log('backup:', out, `(${files.length > KEEP ? KEEP : files.length} نسخه نگهداری شد)`);
