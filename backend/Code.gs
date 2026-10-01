/**
 * بک‌اند نرم‌افزار پیگیری تمدید بیمه (چندنمایندگی)
 * این کد داخل Google Sheet (Extensions > Apps Script) قرار می‌گیرد و به‌صورت Web App منتشر می‌شود.
 * یک Sheet برای همه نمایندگی‌ها. هر نمایندگی با agencyId جدا می‌شود و فقط داده خودش را می‌بیند.
 * شیت‌ها: Agencies, Users, Policies, Actions (خودکار ساخته می‌شوند).
 *
 * اختیاری: در Project Settings > Script properties مقدار REGISTER_CODE را بگذارید تا
 * ثبت‌نام نماینده جدید فقط با آن کد ممکن باشد.
 */

var HEAD = {
  Agencies: ['agencyId', 'name', 'createdAt'],
  Policies: ['policyNo', 'branch', 'internalCode', 'expiry', 'insuredName', 'insuredCode', 'mobile', 'phone',
    'address', 'premium', 'issuer', 'supervisor', 'referrer', 'assignedTo', 'status', 'lastActionAt',
    'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt', 'agencyId'],
  Actions: ['id', 'policyNo', 'user', 'type', 'note', 'nextFollowUp', 'amount', 'at', 'agencyId'],
  Users: ['username', 'name', 'role', 'salt', 'hash', 'active', 'agencyId']
};

// نوع اقدام -> وضعیت پرونده ('' یعنی وضعیت تغییر نمی‌کند)
var TYPE_STATUS = {
  no_answer: 'no_answer', promised: 'promised', followup: 'followup', renewed: 'renewed',
  sold: 'sold', cancelled: 'cancelled', declined: 'declined', wrong_number: 'wrong_number', note: ''
};
var CLOSING = ['renewed', 'sold', 'cancelled', 'declined', 'wrong_number'];
var SESSION_DAYS = 30;
var SCHEMA = '2';

function doGet() {
  return json_({ ok: true, service: 'bime-dey' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    return json_(handle_(req));
  } catch (err) {
    return json_({ error: String(err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- شیت‌ها ----------

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  var cols = HEAD[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), cols.length).setNumberFormat('@');
  } else if (sh.getLastColumn() < cols.length) {
    // مهاجرت: ستون‌های جدید به انتهای هدر اضافه می‌شود
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), cols.length).setNumberFormat('@');
  }
  return sh;
}

function readAll_(name) {
  var sh = sheet_(name);
  var n = sh.getLastRow();
  if (n < 2) return [];
  var cols = HEAD[name];
  var vals = sh.getRange(2, 1, n - 1, cols.length).getValues();
  return vals.map(function (r) {
    var o = {};
    for (var i = 0; i < cols.length; i++) o[cols[i]] = r[i] === '' ? '' : String(r[i]);
    return o;
  });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var cols = HEAD[name];
  var row = cols.map(function (c) { return obj[c] === undefined ? '' : String(obj[c]); });
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, cols.length).setNumberFormat('@').setValues([row]);
}

// یک‌بار: ستون agencyId را برای داده‌های قدیمی با نمایندگی a1 پر می‌کند
function ensureMigrated_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('schema') === SCHEMA) return;
  withLock_(function () {
    if (props.getProperty('schema') === SCHEMA) return;
    var hadData = false;
    ['Agencies', 'Users', 'Policies', 'Actions'].forEach(function (n) { sheet_(n); });
    ['Users', 'Policies', 'Actions'].forEach(function (n) {
      var sh = sheet_(n);
      var last = sh.getLastRow();
      if (last < 2) return;
      hadData = true;
      var col = HEAD[n].indexOf('agencyId') + 1;
      var rng = sh.getRange(2, col, last - 1, 1).setNumberFormat('@');
      var vals = rng.getValues().map(function (r) { return [r[0] === '' ? 'a1' : r[0]]; });
      rng.setValues(vals);
    });
    var us = sheet_('Users');
    if (us.getLastRow() >= 2) {
      var ur = us.getRange(2, 1, us.getLastRow() - 1, 1).setNumberFormat('@');
      ur.setValues(ur.getValues().map(function (r) { return [normUser_(r[0])]; }));
    }
    if (hadData && !readAll_('Agencies').length) {
      appendRow_('Agencies', { agencyId: 'a1', name: 'نمایندگی اول', createdAt: new Date().toISOString() });
    }
    props.setProperty('schema', SCHEMA);
  });
}

// ---------- احراز هویت ----------

function normUser_(u) {
  return String(u || '').trim().toLowerCase();
}

function hash_(salt, pass) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pass, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(d);
}

function newSalt_() {
  return 's' + Utilities.getUuid().slice(0, 8); // با حرف شروع می‌شود تا شیت آن را عدد حساب نکند
}

function sessions_() {
  var p = PropertiesService.getScriptProperties().getProperty('sessions');
  return p ? JSON.parse(p) : {};
}

function saveSessions_(s) {
  PropertiesService.getScriptProperties().setProperty('sessions', JSON.stringify(s));
}

function newSession_(username) {
  var s = sessions_();
  var now = Date.now();
  Object.keys(s).forEach(function (k) { if (s[k].exp < now) delete s[k]; });
  var token = Utilities.getUuid() + Utilities.getUuid();
  s[token] = { u: normUser_(username), exp: now + SESSION_DAYS * 86400000 };
  saveSessions_(s);
  return token;
}

function authUser_(token) {
  var s = sessions_()[token];
  if (!s || s.exp < Date.now()) throw new Error('auth');
  var u = readAll_('Users').filter(function (x) { return normUser_(x.username) === s.u && x.active !== 'false'; })[0];
  if (!u) throw new Error('auth');
  return u;
}

function publicUser_(u) {
  return { username: u.username, name: u.name, role: u.role, active: u.active !== 'false' };
}

function regCode_() {
  return PropertiesService.getScriptProperties().getProperty('REGISTER_CODE') || '';
}

// ---------- مسیریابی ----------

function handle_(req) {
  ensureMigrated_();

  if (req.action === 'ping') return { ok: true, requiresCode: !!regCode_() };
  if (req.action === 'register') return withLock_(function () { return register_(req); });

  if (req.action === 'login') {
    var un = normUser_(req.username);
    var u = readAll_('Users').filter(function (x) { return normUser_(x.username) === un; })[0];
    if (!u || u.active === 'false' || u.hash !== hash_(u.salt, req.password)) throw new Error('نام کاربری یا رمز اشتباه است');
    if (req.role && req.role !== u.role) {
      throw new Error(u.role === 'admin' ? 'این حساب «مدیر» است؛ نقش مدیر را انتخاب کنید' : 'این حساب «کارمند» است؛ نقش کارمند را انتخاب کنید');
    }
    return { ok: true, token: newSession_(u.username), user: publicUser_(u) };
  }

  var me = authUser_(req.token);

  switch (req.action) {
    case 'getData': return getData_(me);
    case 'import': requireAdmin_(me); return withLock_(function () { return importRows_(me, req.rows); });
    case 'addAction': return withLock_(function () { return addAction_(me, req); });
    case 'assign': return withLock_(function () { return assign_(me, req.policyNos, req.to); });
    case 'saveUser': requireAdmin_(me); return withLock_(function () { return saveUser_(me, req); });
    default: throw new Error('عملیات نامعتبر');
  }
}

function requireAdmin_(me) {
  if (me.role !== 'admin') throw new Error('دسترسی ندارید');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function mine_(rows, me) {
  return rows.filter(function (r) { return r.agencyId === me.agencyId; });
}

function getData_(me) {
  var ag = readAll_('Agencies').filter(function (a) { return a.agencyId === me.agencyId; })[0];
  return {
    ok: true,
    me: publicUser_(me),
    agency: { id: me.agencyId, name: ag ? ag.name : '' },
    policies: mine_(readAll_('Policies'), me),
    actions: mine_(readAll_('Actions'), me),
    users: mine_(readAll_('Users'), me).map(publicUser_)
  };
}

// ---------- ثبت‌نام نماینده جدید ----------

function validUsername_(u) {
  if (!/^[a-z0-9_.]{3,30}$/.test(u)) throw new Error('نام کاربری باید لاتین و ۳ تا ۳۰ کاراکتر باشد (حرف، عدد، _ یا .)');
}

function usernameTaken_(u) {
  return readAll_('Users').some(function (x) { return normUser_(x.username) === u; });
}

function register_(req) {
  var code = regCode_();
  if (code && String(req.code || '').trim() !== code) throw new Error('کد ثبت‌نام نادرست است');
  var agencyName = String(req.agencyName || '').trim();
  var name = String(req.name || '').trim();
  var username = normUser_(req.username);
  var pw = String(req.password || '');
  if (!agencyName || !name) throw new Error('نام نمایندگی و نام مدیر را وارد کنید');
  validUsername_(username);
  if (pw.length < 6) throw new Error('رمز عبور حداقل ۶ کاراکتر باشد');
  if (usernameTaken_(username)) throw new Error('این نام کاربری قبلاً گرفته شده است');
  var id = 'a' + Date.now().toString(36);
  appendRow_('Agencies', { agencyId: id, name: agencyName, createdAt: new Date().toISOString() });
  addUser_(username, name, 'admin', pw, id);
  return { ok: true, token: newSession_(username), user: { username: username, name: name, role: 'admin', active: true } };
}

// ---------- ایمپورت ----------

function importRows_(me, rows) {
  var sh = sheet_('Policies');
  var cols = HEAD.Policies;
  var existing = readAll_('Policies');
  var index = {};
  existing.forEach(function (p, i) { if (p.agencyId === me.agencyId) index[p.policyNo] = i; });
  var now = new Date().toISOString();
  var added = 0, updated = 0;
  // فیلدهای عملیاتی با ایمپورت دوباره پاک نمی‌شوند
  var keep = ['assignedTo', 'status', 'lastActionAt', 'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt', 'agencyId'];
  rows.forEach(function (r) {
    if (!r.policyNo) return;
    var i = index[r.policyNo];
    if (i === undefined) {
      var o = {};
      cols.forEach(function (c) { o[c] = r[c] === undefined ? '' : String(r[c]); });
      o.importedAt = now;
      o.agencyId = me.agencyId;
      existing.push(o);
      index[r.policyNo] = existing.length - 1;
      added++;
    } else {
      var cur = existing[i];
      cols.forEach(function (c) {
        if (keep.indexOf(c) < 0 && r[c] !== undefined) cur[c] = String(r[c]);
      });
      updated++;
    }
  });
  var auto = detectRenewals_(me, existing, now);
  var out = existing.map(function (p) { return cols.map(function (c) { return p[c] === undefined ? '' : p[c]; }); });
  if (out.length) {
    if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, out.length, cols.length).setNumberFormat('@').setValues(out);
  }
  var total = existing.filter(function (p) { return p.agencyId === me.agencyId; }).length;
  auto.forEach(function (a) { appendRow_('Actions', a); });
  return { ok: true, added: added, updated: updated, total: total, autoRenewed: auto.length };
}

// ---------- تشخیص خودکار تمدید ----------
// اگر برای همان بیمه‌گذار و همان رشته بیمه‌نامه‌ای با انقضای حدود یک سال دیرتر وجود داشته باشد،
// بیمه‌نامه قدیمی «تمدید شد» می‌شود. هر بیمه‌نامه جدید فقط یک قدیمی را می‌بندد.

function dayNum_(e) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(e);
  return m ? (+m[1]) * 365.25 + (+m[2] - 1) * 30.4 + (+m[3]) : null;
}

function detectRenewals_(me, rows, now) {
  var closed = ['renewed', 'sold', 'cancelled', 'declined'];
  var groups = {};
  rows.forEach(function (p) {
    if (p.agencyId !== me.agencyId || dayNum_(p.expiry) === null || (!p.insuredCode && !p.insuredName)) return;
    var k = (p.insuredCode || ('n:' + p.insuredName)) + '|' + p.branch;
    (groups[k] = groups[k] || []).push(p);
  });
  var acts = [];
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    if (g.length < 2) return;
    g.sort(function (a, b) { return dayNum_(a.expiry) - dayNum_(b.expiry); });
    var used = {};
    for (var qi = 1; qi < g.length; qi++) {
      var q = g[qi], best = -1, bestDiff = 1e9;
      for (var pi = 0; pi < qi; pi++) {
        var p = g[pi];
        if (used[pi] || closed.indexOf(p.status) >= 0) continue;
        var gap = dayNum_(q.expiry) - dayNum_(p.expiry);
        if (gap >= 250 && gap <= 450 && Math.abs(gap - 365) < bestDiff) { best = pi; bestDiff = Math.abs(gap - 365); }
      }
      if (best < 0) continue;
      used[best] = true;
      var old = g[best];
      var note = 'تمدید خودکار: بیمه‌نامه جدید ' + q.policyNo;
      old.status = 'renewed';
      old.lastActionAt = now;
      old.nextFollowUp = '';
      old.finalPremium = q.premium;
      old.lastNote = note;
      acts.push({ id: Utilities.getUuid().slice(0, 8), policyNo: old.policyNo, user: 'system', type: 'renewed', note: note, nextFollowUp: '', amount: q.premium, at: now, agencyId: me.agencyId });
    }
  });
  return acts;
}

// ---------- اقدامات ----------

function findPolicyRow_(me, policyNo) {
  var sh = sheet_('Policies');
  var n = sh.getLastRow();
  if (n < 2) return null;
  var ci = HEAD.Policies.indexOf('agencyId') + 1;
  var vals = sh.getRange(2, 1, n - 1, ci).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === policyNo && String(vals[i][ci - 1]) === me.agencyId) return { sh: sh, row: i + 2 };
  }
  return null;
}

function setCell_(loc, col, value) {
  loc.sh.getRange(loc.row, HEAD.Policies.indexOf(col) + 1).setNumberFormat('@').setValue(value);
}

function getCell_(loc, col) {
  return String(loc.sh.getRange(loc.row, HEAD.Policies.indexOf(col) + 1).getValue());
}

function addAction_(me, req) {
  if (!(req.type in TYPE_STATUS)) throw new Error('نوع اقدام نامعتبر');
  var loc = findPolicyRow_(me, req.policyNo);
  if (!loc) throw new Error('بیمه‌نامه پیدا نشد');
  var owner = getCell_(loc, 'assignedTo');
  if (me.role !== 'admin' && owner && owner !== me.username) throw new Error('این پرونده به کارمند دیگری واگذار شده است');

  var now = new Date().toISOString();
  var act = {
    id: Utilities.getUuid().slice(0, 8), policyNo: req.policyNo, user: me.username, type: req.type,
    note: req.note || '', nextFollowUp: req.nextFollowUp || '', amount: req.amount || '', at: now, agencyId: me.agencyId
  };
  appendRow_('Actions', act);

  var st = TYPE_STATUS[req.type];
  if (st) setCell_(loc, 'status', st);
  if (!owner) setCell_(loc, 'assignedTo', me.username);
  setCell_(loc, 'lastActionAt', now);
  setCell_(loc, 'nextFollowUp', CLOSING.indexOf(req.type) >= 0 ? '' : (req.nextFollowUp || ''));
  if (req.note) setCell_(loc, 'lastNote', req.note);
  if (req.type === 'renewed' && req.amount) setCell_(loc, 'finalPremium', req.amount);
  return { ok: true, action: act };
}

function assign_(me, policyNos, to) {
  if (me.role !== 'admin' && to && to !== me.username) throw new Error('فقط مدیر می‌تواند به دیگران واگذار کند');
  if (to) {
    var target = mine_(readAll_('Users'), me).filter(function (u) { return u.username === to && u.active !== 'false'; })[0];
    if (!target) throw new Error('کاربر مقصد در این نمایندگی نیست');
  }
  var changed = [];
  policyNos.forEach(function (no) {
    var loc = findPolicyRow_(me, no);
    if (!loc) return;
    var owner = getCell_(loc, 'assignedTo');
    if (me.role !== 'admin' && owner && owner !== me.username) return;
    setCell_(loc, 'assignedTo', to || '');
    changed.push(no);
  });
  return { ok: true, changed: changed };
}

// ---------- کاربران ----------

function addUser_(username, name, role, password, agencyId) {
  var salt = newSalt_();
  appendRow_('Users', { username: normUser_(username), name: name, role: role, salt: salt, hash: hash_(salt, password), active: 'true', agencyId: agencyId });
}

function saveUser_(me, req) {
  var sh = sheet_('Users');
  var all = readAll_('Users');
  var username = normUser_(req.username);
  var idx = -1;
  all.forEach(function (u, i) { if (normUser_(u.username) === username) idx = i; });
  if (idx < 0) {
    validUsername_(username);
    if (!req.password || req.password.length < 4) throw new Error('رمز عبور حداقل ۴ کاراکتر باشد');
    addUser_(username, req.name || username, req.role === 'admin' ? 'admin' : 'employee', req.password, me.agencyId);
  } else {
    if (all[idx].agencyId !== me.agencyId) throw new Error('این نام کاربری قبلاً گرفته شده است');
    if (username === normUser_(me.username) && req.active === false) throw new Error('نمی‌توانید حساب خودتان را غیرفعال کنید');
    var row = idx + 2;
    if (req.name) sh.getRange(row, 2).setValue(req.name);
    if (req.role && username !== normUser_(me.username)) sh.getRange(row, 3).setValue(req.role === 'admin' ? 'admin' : 'employee');
    if (req.password) {
      if (req.password.length < 4) throw new Error('رمز عبور حداقل ۴ کاراکتر باشد');
      var salt = newSalt_();
      sh.getRange(row, 4).setValue(salt);
      sh.getRange(row, 5).setValue(hash_(salt, req.password));
    }
    if (req.active !== undefined) sh.getRange(row, 6).setValue(req.active ? 'true' : 'false');
  }
  return { ok: true, users: mine_(readAll_('Users'), me).map(publicUser_) };
}

/**
 * ابزار توسعه‌دهنده (فقط از داخل ادیتور Apps Script اجرا شود، نه از API):
 * اگر رمز یک کاربر گم شد یا ورود کار نکرد، دو مقدار پایین را عوض کنید و تابع را Run کنید.
 * بعد از اجرا مقدارها را به CHANGE_ME برگردانید.
 */
function resetPassword() {
  var USERNAME = 'CHANGE_ME';
  var PASSWORD = 'CHANGE_ME';
  if (USERNAME === 'CHANGE_ME' || PASSWORD === 'CHANGE_ME') throw new Error('USERNAME و PASSWORD را تنظیم کنید');
  var sh = sheet_('Users');
  var users = readAll_('Users');
  for (var i = 0; i < users.length; i++) {
    if (normUser_(users[i].username) === normUser_(USERNAME)) {
      var salt = newSalt_();
      sh.getRange(i + 2, 1).setNumberFormat('@').setValue(normUser_(USERNAME));
      sh.getRange(i + 2, 4).setNumberFormat('@').setValue(salt);
      sh.getRange(i + 2, 5).setNumberFormat('@').setValue(hash_(salt, PASSWORD));
      sh.getRange(i + 2, 6).setNumberFormat('@').setValue('true');
      Logger.log('رمز کاربر ' + USERNAME + ' ریست شد');
      return;
    }
  }
  throw new Error('کاربر پیدا نشد');
}
