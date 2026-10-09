'use strict';
/**
 * سرور برنامه پیگیری تمدید بیمه — بدون هیچ وابستگی npm.
 * فقط Node.js (نسخه ۲۲.۱۳ به بالا) و SQLite داخلی آن (node:sqlite).
 * قرارداد API همان Code.gs است: POST /api با بدنه JSON و پاسخ JSON.
 * فایل‌های برنامه (پوشه public) را هم از همین سرور می‌دهد.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'bime.db');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');
const REGISTER_CODE = process.env.REGISTER_CODE || '';
const SESSION_DAYS = 30;
const MAX_BODY = 10 * 1024 * 1024;

class AppError extends Error {}
const fail = msg => { throw new AppError(msg); };

/* ================= دیتابیس ================= */
const P_COLS = ['policyNo', 'branch', 'internalCode', 'expiry', 'issueDate', 'insuredName', 'insuredCode', 'mobile', 'phone',
  'address', 'premium', 'issuer', 'supervisor', 'referrer', 'assignedTo', 'status', 'lastActionAt',
  'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt'];
const A_COLS = ['id', 'policyNo', 'user', 'type', 'note', 'nextFollowUp', 'amount', 'at'];
const KEEP = ['assignedTo', 'status', 'lastActionAt', 'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt'];
const TYPE_STATUS = {
  no_answer: 'no_answer', promised: 'promised', followup: 'followup', renewed: 'renewed',
  sold: 'sold', cancelled: 'cancelled', declined: 'declined', wrong_number: 'wrong_number', note: ''
};
const CLOSING = ['renewed', 'sold', 'cancelled', 'declined', 'wrong_number'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS agencies (agencyId TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  algo TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, agencyId TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (
  agencyId TEXT NOT NULL,
  ${P_COLS.map(c => `${c} TEXT NOT NULL DEFAULT ''`).join(',\n  ')},
  PRIMARY KEY (agencyId, policyNo));
CREATE TABLE IF NOT EXISTS actions (
  ${A_COLS.map(c => `${c} TEXT NOT NULL DEFAULT ''`).join(',\n  ')}, agencyId TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_actions_agency ON actions (agencyId, policyNo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_id ON actions (agencyId, id);
CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, username TEXT NOT NULL, exp INTEGER NOT NULL);
`);

// مهاجرت دیتابیس‌های قبلی
const policyCols = db.prepare('PRAGMA table_info(policies)').all().map(c => c.name);
if (!policyCols.includes('issueDate')) db.exec("ALTER TABLE policies ADD COLUMN issueDate TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS imports (
  agencyId TEXT NOT NULL, fileHash TEXT NOT NULL, fileName TEXT NOT NULL DEFAULT '', at TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agencyId, fileHash))`);
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('mustChange')) db.exec('ALTER TABLE users ADD COLUMN mustChange INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('lastLogin')) db.exec("ALTER TABLE users ADD COLUMN lastLogin TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS audit (
  at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')`);
const audit = (actor, action, target = '', detail = '') =>
  db.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), actor, action, target, detail);

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  usersByAgency: db.prepare('SELECT username, name, role, active FROM users WHERE agencyId = ? ORDER BY rowid'),
  agency: db.prepare('SELECT * FROM agencies WHERE agencyId = ?'),
  policies: db.prepare('SELECT * FROM policies WHERE agencyId = ?'),
  policy: db.prepare('SELECT * FROM policies WHERE agencyId = ? AND policyNo = ?'),
  actions: db.prepare('SELECT * FROM actions WHERE agencyId = ? ORDER BY rowid'),
  addAgency: db.prepare('INSERT INTO agencies (agencyId, name, createdAt) VALUES (?, ?, ?)'),
  addUser: db.prepare('INSERT INTO users (username, name, role, algo, salt, hash, active, agencyId) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'),
  addSession: db.prepare('INSERT INTO sessions (tokenHash, username, exp) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT * FROM sessions WHERE tokenHash = ?'),
  delExpired: db.prepare('DELETE FROM sessions WHERE exp < ?'),
  addAction: db.prepare(`INSERT INTO actions (${A_COLS.join(', ')}, agencyId) VALUES (${A_COLS.map(() => '?').join(', ')}, ?)`),
  insPolicy: db.prepare(`INSERT INTO policies (agencyId, ${P_COLS.join(', ')}) VALUES (?, ${P_COLS.map(() => '?').join(', ')})`)
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ================= رمز عبور و نشست ================= */
function newPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { algo: 'scrypt', salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function checkPassword(u, pw) {
  if (u.algo === 'scrypt') return safeEq(crypto.scryptSync(pw, u.salt, 32).toString('hex'), u.hash);
  if (u.algo === 'sha256') { // حساب‌های منتقل‌شده از Google Sheet
    const h = crypto.createHash('sha256').update(u.salt + '|' + pw, 'utf8').digest('base64');
    return safeEq(h, u.hash);
  }
  return false;
}
// رمز موقت تصادفی بدون حروف مشابه (0/O و 1/l/I)
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), b => abc[b % abc.length]).join('');
}
const normUser = u => String(u || '').trim().toLowerCase();
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  q.addSession.run(tokenHash(token), username, Date.now() + SESSION_DAYS * 86400000);
  return token;
}
function authUser(token) {
  const s = token ? q.session.get(tokenHash(token)) : null;
  if (!s || s.exp < Date.now()) fail('auth');
  const u = q.userByName.get(s.username);
  if (!u || !u.active) fail('auth');
  return u;
}
const publicUser = u => ({ username: u.username, name: u.name, role: u.role, active: !!u.active, mustChange: !!u.mustChange });

const failures = new Map(); // محدودیت تلاش ورود ناموفق به‌ازای IP
function checkRate(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter(t => now - t < 600000);
  failures.set(ip, list);
  if (list.length >= 10) fail('تلاش ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید');
}
const noteFail = ip => failures.set(ip, [...(failures.get(ip) || []), Date.now()]);

/* ================= منطق ================= */
function getData(me) {
  const ag = me.role === 'super' ? { name: 'مدیریت پلتفرم' } : q.agency.get(me.agencyId);
  return {
    ok: true,
    me: publicUser(me),
    agency: { id: me.agencyId, name: ag ? ag.name : '' },
    policies: q.policies.all(me.agencyId).map(({ agencyId, ...p }) => p),
    actions: q.actions.all(me.agencyId).map(({ agencyId, ...a }) => a),
    users: q.usersByAgency.all(me.agencyId).map(publicUser),
    imports: db.prepare('SELECT fileName, at, added, updated FROM imports WHERE agencyId = ? ORDER BY at DESC LIMIT 10').all(me.agencyId)
  };
}

function validUsername(u) {
  if (!/^[a-z0-9_.]{3,30}$/.test(u)) fail('نام کاربری باید لاتین و ۳ تا ۳۰ کاراکتر باشد (حرف، عدد، _ یا .)');
}

function register(req) {
  if (REGISTER_CODE && String(req.code || '').trim() !== REGISTER_CODE) fail('کد ثبت‌نام نادرست است');
  const agencyName = String(req.agencyName || '').trim();
  const name = String(req.name || '').trim();
  const username = normUser(req.username);
  const pw = String(req.password || '');
  if (!agencyName || !name) fail('نام نمایندگی و نام مدیر را وارد کنید');
  validUsername(username);
  if (pw.length < 6) fail('رمز عبور حداقل ۶ کاراکتر باشد');
  if (q.userByName.get(username)) fail('این نام کاربری قبلاً گرفته شده است');
  const id = 'a' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const p = newPassword(pw);
  tx(() => {
    q.addAgency.run(id, agencyName, new Date().toISOString());
    q.addUser.run(username, name, 'admin', p.algo, p.salt, p.hash, id);
  });
  db.prepare('UPDATE users SET lastLogin = ? WHERE username = ?').run(new Date().toISOString(), username);
  const me = q.userByName.get(username);
  return { ok: true, token: newSession(username), user: publicUser(me), data: getData(me) };
}

function login(req, ip) {
  checkRate(ip);
  const u = q.userByName.get(normUser(req.username));
  if (!u || !u.active || !checkPassword(u, String(req.password || ''))) {
    noteFail(ip);
    fail('نام کاربری یا رمز اشتباه است');
  }
  if (req.role && req.role !== u.role && !(u.role === 'super' && req.role === 'admin')) {
    fail(u.role === 'admin' ? 'این حساب «مدیر» است؛ نقش مدیر را انتخاب کنید' : 'این حساب «کارمند» است؛ نقش کارمند را انتخاب کنید');
  }
  db.prepare('UPDATE users SET lastLogin = ? WHERE username = ?').run(new Date().toISOString(), u.username);
  if (u.algo !== 'scrypt') { // ارتقای هش قدیمی بعد از اولین ورود موفق
    const p = newPassword(String(req.password));
    db.prepare('UPDATE users SET algo = ?, salt = ?, hash = ? WHERE username = ?').run(p.algo, p.salt, p.hash, u.username);
  }
  return { ok: true, token: newSession(u.username), user: publicUser(u), data: getData(u) };
}

// اگر برای همان بیمه‌گذار و رشته، بیمه‌نامه‌ای با انقضای ۲۵۰ تا ۴۵۰ روز دیرتر باشد، قدیمی «تمدید شد» می‌شود
function dayNum(e) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(e);
  return m ? (+m[1]) * 365.25 + (+m[2] - 1) * 30.4 + (+m[3]) : null;
}
function detectRenewals(agencyId, now) {
  const closed = ['renewed', 'sold', 'cancelled', 'declined'];
  const groups = {};
  q.policies.all(agencyId).forEach(p => {
    if (dayNum(p.expiry) === null || (!p.insuredCode && !p.insuredName)) return;
    const k = (p.insuredCode || 'n:' + p.insuredName) + '|' + p.branch;
    (groups[k] = groups[k] || []).push(p);
  });
  const upd = db.prepare("UPDATE policies SET status = 'renewed', lastActionAt = ?, nextFollowUp = '', finalPremium = ?, lastNote = ? WHERE agencyId = ? AND policyNo = ?");
  let count = 0;
  Object.values(groups).forEach(g => {
    if (g.length < 2) return;
    g.sort((a, b) => dayNum(a.expiry) - dayNum(b.expiry));
    const used = {};
    for (let qi = 1; qi < g.length; qi++) {
      const nw = g[qi];
      let best = -1, bestDiff = 1e9;
      // نزدیک‌ترین بیمه‌نامه قبلی به یک سال فاصله، حتی اگر قبلاً بسته شده باشد؛ تا یک بیمه‌نامه جدید
      // بعد از بسته شدن قدیمی خودش، قدیمی دیگری را اشتباه نبندد
      for (let pi = 0; pi < qi; pi++) {
        if (used[pi]) continue;
        const gap = dayNum(nw.expiry) - dayNum(g[pi].expiry);
        if (gap >= 250 && gap <= 450 && Math.abs(gap - 365) < bestDiff) { best = pi; bestDiff = Math.abs(gap - 365); }
      }
      if (best < 0) continue;
      used[best] = true;
      if (closed.includes(g[best].status)) continue;
      const old = g[best];
      const note = 'تمدید خودکار: بیمه‌نامه جدید ' + nw.policyNo;
      upd.run(now, nw.premium, note, agencyId, old.policyNo);
      q.addAction.run(crypto.randomBytes(4).toString('hex'), old.policyNo, 'system', 'renewed', note, '', nw.premium, now, agencyId);
      old.status = 'renewed';
      count++;
    }
  });
  return count;
}

function importRows(me, req) {
  const rows = req.rows;
  if (!Array.isArray(rows)) fail('داده نامعتبر');
  const fileHash = String(req.fileHash || '');
  const fileName = String(req.fileName || '').slice(0, 200);
  // همان فایل قبلاً وارد شده؟ بدون تأیید صریح (force) دوباره ثبت نمی‌شود
  if (fileHash && !req.force) {
    const prev = db.prepare('SELECT fileName, at, added, updated FROM imports WHERE agencyId = ? AND fileHash = ?').get(me.agencyId, fileHash);
    if (prev) return { ok: true, skipped: true, previous: { ...prev } };
  }
  const now = new Date().toISOString();
  const baseCols = P_COLS.filter(c => !KEEP.includes(c) && c !== 'policyNo');
  const upd = db.prepare(`UPDATE policies SET ${baseCols.map(c => `${c} = ?`).join(', ')} WHERE agencyId = ? AND policyNo = ?`);
  const seen = new Set();
  let added = 0, updated = 0, repeatedInFile = 0, autoRenewed = 0;
  tx(() => {
    for (const r of rows) {
      const no = String(r.policyNo || '').trim();
      if (!no) continue;
      const again = seen.has(no); // ردیف تکراری داخل خود فایل
      seen.add(no);
      const cur = q.policy.get(me.agencyId, no);
      if (!cur) {
        q.insPolicy.run(me.agencyId, ...P_COLS.map(c => c === 'importedAt' ? now : c === 'policyNo' ? no : String(r[c] ?? '')));
        added++;
      } else {
        upd.run(...baseCols.map(c => r[c] === undefined ? cur[c] : String(r[c])), me.agencyId, no);
        if (again) repeatedInFile++; else updated++;
      }
    }
    autoRenewed = detectRenewals(me.agencyId, now);
    if (fileHash) {
      const prev = db.prepare('SELECT fileName FROM imports WHERE agencyId = ? AND fileHash = ?').get(me.agencyId, fileHash);
      db.prepare('INSERT OR REPLACE INTO imports (agencyId, fileHash, fileName, at, added, updated) VALUES (?, ?, ?, ?, ?, ?)')
        .run(me.agencyId, fileHash, fileName || (prev ? prev.fileName : ''), now, added, updated);
    }
  });
  const total = db.prepare('SELECT COUNT(*) AS n FROM policies WHERE agencyId = ?').get(me.agencyId).n;
  return { ok: true, added, updated, repeatedInFile, total, autoRenewed };
}

function addAction(me, req) {
  if (!(req.type in TYPE_STATUS)) fail('نوع اقدام نامعتبر');
  const p = q.policy.get(me.agencyId, String(req.policyNo || ''));
  if (!p) fail('بیمه‌نامه پیدا نشد');
  if (me.role !== 'admin' && p.assignedTo && p.assignedTo !== me.username) fail('این پرونده به کارمند دیگری واگذار شده است');
  const now = new Date().toISOString();
  const act = {
    id: crypto.randomBytes(4).toString('hex'), policyNo: p.policyNo, user: me.username, type: req.type,
    note: String(req.note || '').slice(0, 2000), nextFollowUp: String(req.nextFollowUp || ''), amount: String(req.amount || ''), at: now
  };
  tx(() => {
    q.addAction.run(...A_COLS.map(c => act[c]), me.agencyId);
    const st = TYPE_STATUS[req.type];
    const sets = { lastActionAt: now, nextFollowUp: CLOSING.includes(req.type) ? '' : act.nextFollowUp };
    if (st) sets.status = st;
    if (!p.assignedTo) sets.assignedTo = me.username;
    if (act.note) sets.lastNote = act.note;
    if (req.type === 'renewed' && act.amount) sets.finalPremium = act.amount;
    const keys = Object.keys(sets);
    db.prepare(`UPDATE policies SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE agencyId = ? AND policyNo = ?`)
      .run(...keys.map(k => sets[k]), me.agencyId, p.policyNo);
  });
  return { ok: true, action: act };
}

function assign(me, policyNos, to) {
  if (me.role !== 'admin' && to && to !== me.username) fail('فقط مدیر می‌تواند به دیگران واگذار کند');
  if (to) {
    const t = q.userByName.get(to);
    if (!t || t.agencyId !== me.agencyId || !t.active) fail('کاربر مقصد در این نمایندگی نیست');
  }
  const changed = [];
  tx(() => {
    for (const no of policyNos || []) {
      const p = q.policy.get(me.agencyId, String(no));
      if (!p) continue;
      if (me.role !== 'admin' && p.assignedTo && p.assignedTo !== me.username) continue;
      db.prepare('UPDATE policies SET assignedTo = ? WHERE agencyId = ? AND policyNo = ?').run(to || '', me.agencyId, p.policyNo);
      changed.push(p.policyNo);
    }
  });
  return { ok: true, changed };
}

function saveUser(me, req) {
  const username = normUser(req.username);
  const cur = q.userByName.get(username);
  if (!cur) {
    validUsername(username);
    if (!req.password || String(req.password).length < 4) fail('رمز عبور حداقل ۴ کاراکتر باشد');
    const p = newPassword(String(req.password));
    q.addUser.run(username, String(req.name || username).trim(), req.role === 'admin' ? 'admin' : 'employee', p.algo, p.salt, p.hash, me.agencyId);
    db.prepare('UPDATE users SET mustChange = 1 WHERE username = ?').run(username);
  } else {
    if (cur.agencyId !== me.agencyId) fail('این نام کاربری قبلاً گرفته شده است');
    const self = username === me.username;
    if (self && req.active === false) fail('نمی‌توانید حساب خودتان را غیرفعال کنید');
    tx(() => {
      if (req.name) db.prepare('UPDATE users SET name = ? WHERE username = ?').run(String(req.name).trim(), username);
      if (req.role && !self) db.prepare('UPDATE users SET role = ? WHERE username = ?').run(req.role === 'admin' ? 'admin' : 'employee', username);
      if (req.password) {
        if (String(req.password).length < 4) fail('رمز عبور حداقل ۴ کاراکتر باشد');
        const p = newPassword(String(req.password));
        db.prepare('UPDATE users SET algo = ?, salt = ?, hash = ?, mustChange = ? WHERE username = ?').run(p.algo, p.salt, p.hash, self ? 0 : 1, username);
        db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
      }
      if (req.active !== undefined) {
        db.prepare('UPDATE users SET active = ? WHERE username = ?').run(req.active ? 1 : 0, username);
        if (!req.active) db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
      }
    });
  }
  return { ok: true, users: q.usersByAgency.all(me.agencyId).map(publicUser) };
}

// تغییر رمز توسط خود کاربر (و بعد از ریست اجباری است)
function changePassword(me, req) {
  const next = String(req.newPassword || '');
  if (!checkPassword(me, String(req.oldPassword || ''))) fail('رمز فعلی اشتباه است');
  if (next.length < 6) fail('رمز جدید حداقل ۶ کاراکتر باشد');
  if (next === String(req.oldPassword)) fail('رمز جدید باید با رمز فعلی فرق کند');
  const p = newPassword(next);
  db.prepare('UPDATE users SET algo = ?, salt = ?, hash = ?, mustChange = 0 WHERE username = ?').run(p.algo, p.salt, p.hash, me.username);
  db.prepare('DELETE FROM sessions WHERE username = ? AND tokenHash <> ?').run(me.username, tokenHash(req.token));
  return { ok: true };
}

/* ================= پنل پلتفرم (فقط super) =================
 * فقط آمار و مدیریت حساب‌ها؛ هیچ پرونده یا شماره مشتری‌ای برنمی‌گرداند. */
const needSuper = me => { if (me.role !== 'super') fail('دسترسی ندارید'); };

function platformOverview(me) {
  needSuper(me);
  const agencies = db.prepare(`
    SELECT a.agencyId, a.name, a.createdAt,
      (SELECT COUNT(*) FROM users u WHERE u.agencyId = a.agencyId) AS users,
      (SELECT COUNT(*) FROM users u WHERE u.agencyId = a.agencyId AND u.active = 1) AS activeUsers,
      (SELECT COUNT(*) FROM policies p WHERE p.agencyId = a.agencyId) AS policies,
      (SELECT COUNT(*) FROM actions x WHERE x.agencyId = a.agencyId) AS actions,
      (SELECT COALESCE(MAX(x.at), '') FROM actions x WHERE x.agencyId = a.agencyId) AS lastAction,
      (SELECT COALESCE(MAX(u.lastLogin), '') FROM users u WHERE u.agencyId = a.agencyId) AS lastLogin
    FROM agencies a ORDER BY a.createdAt`).all();
  const users = db.prepare(`
    SELECT u.username, u.name, u.role, u.active, u.agencyId, COALESCE(a.name, '') AS agencyName, u.lastLogin, u.mustChange
    FROM users u LEFT JOIN agencies a ON a.agencyId = u.agencyId
    WHERE u.role <> 'super' ORDER BY a.createdAt, u.rowid`).all()
    .map(u => ({ ...u, active: !!u.active, mustChange: !!u.mustChange }));
  const sum = k => agencies.reduce((n, a) => n + a[k], 0);
  return { ok: true, agencies, users, totals: { agencies: agencies.length, users: users.length, policies: sum('policies'), actions: sum('actions') } };
}

function platformResetPassword(me, req) {
  needSuper(me);
  const username = normUser(req.username);
  const u = q.userByName.get(username);
  if (!u || u.role === 'super') fail('کاربر پیدا نشد');
  const temp = tempPassword();
  const p = newPassword(temp);
  tx(() => {
    db.prepare('UPDATE users SET algo = ?, salt = ?, hash = ?, mustChange = 1 WHERE username = ?').run(p.algo, p.salt, p.hash, username);
    db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
    audit(me.username, 'reset-password', username);
  });
  return { ok: true, username, tempPassword: temp };
}

function platformSetActive(me, req) {
  needSuper(me);
  const username = normUser(req.username);
  const u = q.userByName.get(username);
  if (!u || u.role === 'super') fail('کاربر پیدا نشد');
  tx(() => {
    db.prepare('UPDATE users SET active = ? WHERE username = ?').run(req.active ? 1 : 0, username);
    if (!req.active) db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
    audit(me.username, req.active ? 'activate' : 'deactivate', username);
  });
  return { ok: true };
}

function handle(req, ip) {
  switch (req.action) {
    case 'ping': return { ok: true, requiresCode: !!REGISTER_CODE };
    case 'register': return register(req);
    case 'login': return login(req, ip);
  }
  const me = authUser(req.token);
  switch (req.action) {
    case 'getData': return getData(me);
    case 'changePassword': return changePassword(me, req);
    case 'platformOverview': return platformOverview(me);
    case 'platformResetPassword': return platformResetPassword(me, req);
    case 'platformSetActive': return platformSetActive(me, req);
    case 'import': if (me.role !== 'admin') fail('دسترسی ندارید'); return importRows(me, req);
    case 'addAction': return addAction(me, req);
    case 'assign': return assign(me, req.policyNos, req.to);
    case 'saveUser': if (me.role !== 'admin') fail('دسترسی ندارید'); return saveUser(me, req);
    default: return fail('عملیات نامعتبر');
  }
}

/* ================= HTTP ================= */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};
const gzCache = new Map();

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError('حجم داده زیاد است')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(path.normalize(STATIC_DIR))) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    const html = ext === '.html' || path.basename(file) === 'sw.js';
    const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': html ? 'no-cache' : 'public, max-age=3600' };
    const compress = /^(text|application\/(json|javascript))|svg/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (compress) {
      const key = file + ':' + st.mtimeMs;
      let gz = gzCache.get(key);
      if (!gz) { gz = zlib.gzipSync(fs.readFileSync(file)); gzCache.set(key, gz); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length });
      return req.method === 'HEAD' ? res.end() : res.end(gz);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      if (req.method === 'GET') return sendJson(res, { ok: true, service: 'bime-dey' });
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      let out;
      try {
        out = handle(JSON.parse(await readBody(req)), ip);
      } catch (e) {
        if (e instanceof AppError) out = { error: e.message };
        else { console.error(new Date().toISOString(), e); out = { error: 'خطای داخلی سرور' }; }
      }
      return sendJson(res, out);
    }
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

setInterval(() => { try { q.delExpired.run(Date.now()); } catch (e) { console.error(e); } }, 3600000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`bime-dey listening on http://${HOST}:${PORT} (db: ${DB_PATH})`));
  const stop = () => { server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, db, newPassword, tempPassword, audit };
