'use strict';
/**
 * انتقال داده از Google Sheet به دیتابیس سرور.
 * در Google Sheet برای هر شیت File > Download > Comma Separated Values بزنید:
 *   Agencies.csv, Users.csv, Policies.csv, Actions.csv
 * سپس:  node migrate-sheet.js ./پوشه-فایل‌های-csv
 * اجرای دوباره بی‌خطر است (تکراری‌ها رد می‌شوند). رمزهای قدیمی (SHA-256) کار می‌کنند و
 * بعد از اولین ورود هر کاربر خودکار به هش جدید ارتقا پیدا می‌کنند.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = process.argv[2];
if (!dir) { console.error('استفاده: node migrate-sheet.js <پوشه csv>'); process.exit(1); }
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bime.db');

// فایل را یک بار با سرور اجرا نکرده باشید هم جدول‌ها ساخته شوند
process.env.DB_PATH = DB_PATH;
require('./server.js');
const db = new DatabaseSync(DB_PATH);

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.some(x => x !== '')).map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}
const read = name => {
  const f = path.join(dir, name + '.csv');
  return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : [];
};
const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

function load(table, rows, map = r => r, conflict = 'IGNORE') {
  const names = cols(table);
  const stmt = db.prepare(`INSERT OR ${conflict} INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
  let n = 0;
  db.exec('BEGIN');
  for (const raw of rows) {
    const r = map(raw);
    if (!r) continue;
    const res = stmt.run(...names.map(c => String(r[c] ?? '')));
    n += Number(res.changes);
  }
  db.exec('COMMIT');
  return n;
}

// اگر ستون agencyId در شیت خالی بود (داده قدیمی)، به نمایندگی a1 می‌رود
const ag = r => ({ ...r, agencyId: r.agencyId || 'a1' });
const agencies = read('Agencies');
if (!agencies.length && read('Users').length) agencies.push({ agencyId: 'a1', name: 'نمایندگی اول', createdAt: new Date().toISOString() });
console.log('agencies:', load('agencies', agencies));
console.log('users:', load('users', read('Users'), r => r.username ? ({
  ...ag(r), username: r.username.trim().toLowerCase(), algo: 'sha256', mustChange: 0, lastLogin: '', active: r.active === 'false' || r.active === 'FALSE' ? 0 : 1
}) : null));
console.log('policies:', load('policies', read('Policies'), r => r.policyNo ? ag(r) : null));
console.log('actions:', load('actions', read('Actions'), r => r.id ? ag(r) : null));
db.close();
process.exit(0);
