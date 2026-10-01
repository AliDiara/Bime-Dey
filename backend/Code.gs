/**
 * بک‌اند نرم‌افزار پیگیری تمدید بیمه
 * این کد داخل Google Sheet (Extensions > Apps Script) قرار می‌گیرد و به‌صورت Web App منتشر می‌شود.
 * دیتابیس = همین Sheet. سه شیت: Policies, Actions, Users (خودکار ساخته می‌شوند).
 */

var HEAD = {
  Policies: ['policyNo', 'branch', 'internalCode', 'expiry', 'insuredName', 'insuredCode', 'mobile', 'phone',
    'address', 'premium', 'issuer', 'supervisor', 'referrer', 'assignedTo', 'status', 'lastActionAt',
    'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt'],
  Actions: ['id', 'policyNo', 'user', 'type', 'note', 'nextFollowUp', 'amount', 'at'],
  Users: ['username', 'name', 'role', 'salt', 'hash', 'active']
};

// نوع اقدام -> وضعیت پرونده ('' یعنی وضعیت تغییر نمی‌کند)
var TYPE_STATUS = {
  no_answer: 'no_answer', promised: 'promised', followup: 'followup', renewed: 'renewed',
  sold: 'sold', cancelled: 'cancelled', declined: 'declined', wrong_number: 'wrong_number', note: ''
};

var SESSION_DAYS = 30;

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

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEAD[name].length).setValues([HEAD[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // همه‌چیز متن باشد تا صفر اول موبایل و اسلش شماره بیمه‌نامه خراب نشود
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), HEAD[name].length).setNumberFormat('@');
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

// ---------- احراز هویت ----------

function hash_(salt, pass) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pass, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(d);
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
  s[token] = { u: username, exp: now + SESSION_DAYS * 86400000 };
  saveSessions_(s);
  return token;
}

function authUser_(token) {
  var s = sessions_()[token];
  if (!s || s.exp < Date.now()) throw new Error('auth');
  var u = readAll_('Users').filter(function (x) { return x.username === s.u && x.active !== 'false'; })[0];
  if (!u) throw new Error('auth');
  return u;
}

function publicUser_(u) {
  return { username: u.username, name: u.name, role: u.role, active: u.active !== 'false' };
}

// ---------- مسیریابی ----------

function handle_(req) {
  var users = readAll_('Users');
  if (req.action === 'ping') return { ok: true, needsSetup: users.length === 0 };

  if (req.action === 'setup') {
    return withLock_(function () {
      if (readAll_('Users').length) throw new Error('راه‌اندازی قبلاً انجام شده است');
      if (!req.username || !req.password || req.password.length < 4) throw new Error('نام کاربری یا رمز نامعتبر است');
      addUser_(req.username, req.name || req.username, 'admin', req.password);
      return { ok: true, token: newSession_(req.username), user: { username: req.username, name: req.name || req.username, role: 'admin', active: true } };
    });
  }

  if (req.action === 'login') {
    var u = users.filter(function (x) { return x.username === req.username; })[0];
    if (!u || u.active === 'false' || u.hash !== hash_(u.salt, req.password)) throw new Error('نام کاربری یا رمز اشتباه است');
    return { ok: true, token: newSession_(u.username), user: publicUser_(u) };
  }

  var me = authUser_(req.token);

  switch (req.action) {
    case 'getData': return getData_(me);
    case 'import': requireAdmin_(me); return withLock_(function () { return importRows_(req.rows); });
    case 'addAction': return withLock_(function () { return addAction_(me, req); });
    case 'assign': return withLock_(function () { return assign_(me, req.policyNos, req.to); });
    case 'saveUser': requireAdmin_(me); return withLock_(function () { return saveUser_(req); });
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

function getData_(me) {
  var users = readAll_('Users').map(publicUser_);
  return { ok: true, me: publicUser_(me), policies: readAll_('Policies'), actions: readAll_('Actions'), users: users };
}

// ---------- ایمپورت ----------

function importRows_(rows) {
  var sh = sheet_('Policies');
  var cols = HEAD.Policies;
  var existing = readAll_('Policies');
  var index = {};
  existing.forEach(function (p, i) { index[p.policyNo] = i; });
  var now = new Date().toISOString();
  var added = 0, updated = 0;
  // فیلدهای عملیاتی با ایمپورت دوباره پاک نمی‌شوند
  var keep = ['assignedTo', 'status', 'lastActionAt', 'nextFollowUp', 'finalPremium', 'lastNote'];
  rows.forEach(function (r) {
    if (!r.policyNo) return;
    var i = index[r.policyNo];
    if (i === undefined) {
      var o = {};
      cols.forEach(function (c) { o[c] = r[c] === undefined ? '' : String(r[c]); });
      o.importedAt = now;
      existing.push(o);
      index[r.policyNo] = existing.length - 1;
      added++;
    } else {
      var cur = existing[i];
      cols.forEach(function (c) {
        if (keep.indexOf(c) < 0 && c !== 'importedAt' && r[c] !== undefined) cur[c] = String(r[c]);
      });
      updated++;
    }
  });
  var out = existing.map(function (p) { return cols.map(function (c) { return p[c] === undefined ? '' : p[c]; }); });
  if (out.length) {
    if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, out.length, cols.length).setNumberFormat('@').setValues(out);
  }
  return { ok: true, added: added, updated: updated, total: existing.length };
}

// ---------- اقدامات ----------

function findPolicyRow_(policyNo) {
  var sh = sheet_('Policies');
  var n = sh.getLastRow();
  if (n < 2) return null;
  var nos = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = 0; i < nos.length; i++) if (String(nos[i][0]) === policyNo) return { sh: sh, row: i + 2 };
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
  var loc = findPolicyRow_(req.policyNo);
  if (!loc) throw new Error('بیمه‌نامه پیدا نشد');
  var owner = getCell_(loc, 'assignedTo');
  if (me.role !== 'admin' && owner && owner !== me.username) throw new Error('این پرونده به کارمند دیگری واگذار شده است');

  var now = new Date().toISOString();
  var act = {
    id: Utilities.getUuid().slice(0, 8), policyNo: req.policyNo, user: me.username, type: req.type,
    note: req.note || '', nextFollowUp: req.nextFollowUp || '', amount: req.amount || '', at: now
  };
  var ash = sheet_('Actions');
  var row = HEAD.Actions.map(function (c) { return act[c]; });
  ash.getRange(ash.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);

  var st = TYPE_STATUS[req.type];
  if (st) setCell_(loc, 'status', st);
  if (!owner) setCell_(loc, 'assignedTo', me.username);
  setCell_(loc, 'lastActionAt', now);
  setCell_(loc, 'nextFollowUp', ['renewed', 'sold', 'cancelled', 'declined', 'wrong_number'].indexOf(req.type) >= 0 ? '' : (req.nextFollowUp || ''));
  if (req.note) setCell_(loc, 'lastNote', req.note);
  if (req.type === 'renewed' && req.amount) setCell_(loc, 'finalPremium', req.amount);
  return { ok: true, action: act };
}

function assign_(me, policyNos, to) {
  if (me.role !== 'admin' && to && to !== me.username) throw new Error('فقط مدیر می‌تواند به دیگران واگذار کند');
  var changed = [];
  policyNos.forEach(function (no) {
    var loc = findPolicyRow_(no);
    if (!loc) return;
    var owner = getCell_(loc, 'assignedTo');
    if (me.role !== 'admin' && owner && owner !== me.username) return;
    setCell_(loc, 'assignedTo', to || '');
    changed.push(no);
  });
  return { ok: true, changed: changed };
}

// ---------- کاربران ----------

function addUser_(username, name, role, password) {
  var sh = sheet_('Users');
  var salt = Utilities.getUuid().slice(0, 8);
  sh.appendRow([username, name, role, salt, hash_(salt, password), 'true']);
}

function saveUser_(req) {
  var sh = sheet_('Users');
  var users = readAll_('Users');
  var idx = -1;
  users.forEach(function (u, i) { if (u.username === req.username) idx = i; });
  if (idx < 0) {
    if (!req.username || !req.password || req.password.length < 4) throw new Error('نام کاربری و رمز (حداقل ۴ کاراکتر) لازم است');
    addUser_(req.username, req.name || req.username, req.role === 'admin' ? 'admin' : 'employee', req.password);
  } else {
    var row = idx + 2;
    if (req.name) sh.getRange(row, 2).setValue(req.name);
    if (req.role) sh.getRange(row, 3).setValue(req.role === 'admin' ? 'admin' : 'employee');
    if (req.password) {
      var salt = Utilities.getUuid().slice(0, 8);
      sh.getRange(row, 4).setValue(salt);
      sh.getRange(row, 5).setValue(hash_(salt, req.password));
    }
    if (req.active !== undefined) sh.getRange(row, 6).setValue(req.active ? 'true' : 'false');
  }
  return { ok: true, users: readAll_('Users').map(publicUser_) };
}
