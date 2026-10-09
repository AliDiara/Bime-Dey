'use strict';
// اجرا: node --test test.js  (سرور موقت با دیتابیس موقت بالا می‌آورد)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bime-'));
const DB = path.join(tmp, 't.db');
let proc;

const api = (body) => fetch(BASE + '/api', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const row = (no, exp, code, branch = 'خودرو', extra = {}) => ({
  policyNo: no, branch, expiry: exp, insuredName: 'نام ' + code, insuredCode: code, mobile: '0912' + code, premium: '1000', ...extra
});

async function start(env = {}) {
  proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT, DB_PATH: DB, STATIC_DIR: path.join(__dirname, '..', 'app'), ...env }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

before(() => start());
after(() => { proc.kill(); });

let A, B, emp;

test('ping و ثبت‌نام', async () => {
  assert.deepEqual(await api({ action: 'ping' }), { ok: true, requiresCode: false });
  const bad = await api({ action: 'register', agencyName: 'x', name: 'y', username: 'Ab', password: '123456' });
  assert.match(bad.error, /نام کاربری/);
  const shortPw = await api({ action: 'register', agencyName: 'x', name: 'y', username: 'agent_a', password: '123' });
  assert.match(shortPw.error, /رمز/);
  A = await api({ action: 'register', agencyName: 'نمایندگی الف', name: 'مدیر الف', username: 'Agent_A', password: '123456' });
  assert.equal(A.ok, true);
  assert.equal(A.user.role, 'admin');
  assert.equal(A.user.username, 'agent_a');
  assert.equal(A.data.agency.name, 'نمایندگی الف');
  const dup = await api({ action: 'register', agencyName: 'z', name: 'z', username: 'AGENT_A', password: '123456' });
  assert.match(dup.error, /قبلاً/);
  B = await api({ action: 'register', agencyName: 'نمایندگی ب', name: 'مدیر ب', username: 'agent_b', password: '654321' });
  assert.equal(B.ok, true);
});

test('ورود و نقش', async () => {
  assert.match((await api({ action: 'login', username: 'agent_a', password: 'bad' })).error, /اشتباه/);
  assert.equal((await api({ action: 'login', username: ' AGENT_A ', password: '123456', role: 'admin' })).ok, true);
  assert.match((await api({ action: 'login', username: 'agent_a', password: '123456', role: 'employee' })).error, /مدیر/);
});

test('بدون توکن دسترسی نیست', async () => {
  assert.equal((await api({ action: 'getData' })).error, 'auth');
  assert.equal((await api({ action: 'getData', token: 'x' })).error, 'auth');
});

test('ایمپورت، ادغام و جدا بودن نمایندگی‌ها', async () => {
  const r1 = await api({ action: 'import', token: A.token, rows: [row('1/1', '1405/07/01', '1'), row('1/2', '1405/08/01', '2')] });
  assert.equal(r1.added, 2); assert.equal(r1.updated, 0);
  // همان شماره بیمه‌نامه در نمایندگی ب نباید با الف قاطی شود
  const rb = await api({ action: 'import', token: B.token, rows: [row('1/1', '1405/09/01', '9')] });
  assert.equal(rb.added, 1);
  const da = await api({ action: 'getData', token: A.token });
  const db_ = await api({ action: 'getData', token: B.token });
  assert.equal(da.policies.length, 2);
  assert.equal(db_.policies.length, 1);
  assert.equal(db_.policies[0].insuredCode, '9');
  assert.equal(da.policies.find(p => p.policyNo === '1/1').insuredCode, '1');
  // ایمپورت دوباره: به‌روزرسانی بدون پاک شدن اقدام
  await api({ action: 'addAction', token: A.token, policyNo: '1/1', type: 'promised', note: 'n', nextFollowUp: '1405/07/20' });
  const r2 = await api({ action: 'import', token: A.token, rows: [row('1/1', '1405/07/01', '1', 'خودرو', { premium: '2000' })] });
  assert.equal(r2.added, 0); assert.equal(r2.updated, 1);
  const p = (await api({ action: 'getData', token: A.token })).policies.find(x => x.policyNo === '1/1');
  assert.equal(p.premium, '2000'); assert.equal(p.status, 'promised'); assert.equal(p.lastNote, 'n');
  assert.equal((await api({ action: 'getData', token: A.token })).actions.length, 1);
});

test('کارمند: ساخت، دسترسی، واگذاری', async () => {
  const mk = await api({ action: 'saveUser', token: A.token, username: 'Ali', name: 'علی', password: '1234' });
  assert.equal(mk.users.length, 2);
  emp = await api({ action: 'login', username: 'ali', password: '1234', role: 'employee' });
  assert.equal(emp.ok, true);
  assert.equal(emp.data.policies.length, 2);
  assert.equal(emp.data.users.length, 2);
  // کارمند نباید ایمپورت یا ساخت کاربر کند
  assert.match((await api({ action: 'import', token: emp.token, rows: [] })).error, /دسترسی/);
  assert.match((await api({ action: 'saveUser', token: emp.token, username: 'x1x', password: '1234' })).error, /دسترسی/);
  // نام کاربری تکراری بین نمایندگی‌ها
  assert.match((await api({ action: 'saveUser', token: B.token, username: 'ali', password: '1234' })).error, /قبلاً/);
  // پرونده 1/1 را admin برداشته؛ کارمند نباید روی آن اقدام کند
  assert.match((await api({ action: 'addAction', token: emp.token, policyNo: '1/1', type: 'note', note: 'x' })).error, /دیگری/);
  // پرونده 1/2 آزاد است
  const ok = await api({ action: 'addAction', token: emp.token, policyNo: '1/2', type: 'no_answer', nextFollowUp: '1405/07/10' });
  assert.equal(ok.ok, true);
  const p2 = (await api({ action: 'getData', token: A.token })).policies.find(x => x.policyNo === '1/2');
  assert.equal(p2.assignedTo, 'ali'); assert.equal(p2.status, 'no_answer');
  // کارمند به دیگران واگذار نکند، مدیر بکند
  assert.match((await api({ action: 'assign', token: emp.token, policyNos: ['1/2'], to: 'agent_a' })).error, /مدیر/);
  assert.equal((await api({ action: 'assign', token: A.token, policyNos: ['1/2'], to: 'agent_a' })).changed.length, 1);
  assert.match((await api({ action: 'assign', token: A.token, policyNos: ['1/2'], to: 'agent_b' })).error, /مقصد/);
  // نمایندگی ب به پرونده الف دسترسی ندارد
  assert.match((await api({ action: 'addAction', token: B.token, policyNo: '1/2', type: 'note' })).error, /پیدا نشد/);
});

test('غیرفعال‌سازی و تغییر رمز نشست‌ها را می‌بندد', async () => {
  assert.match((await api({ action: 'saveUser', token: A.token, username: 'agent_a', active: false })).error, /خودتان/);
  await api({ action: 'saveUser', token: A.token, username: 'ali', active: false });
  assert.equal((await api({ action: 'getData', token: emp.token })).error, 'auth');
  assert.match((await api({ action: 'login', username: 'ali', password: '1234' })).error, /اشتباه/);
  await api({ action: 'saveUser', token: A.token, username: 'ali', active: true, password: '5678' });
  assert.equal((await api({ action: 'login', username: 'ali', password: '5678' })).ok, true);
});

test('تشخیص خودکار تمدید', async () => {
  const rows = [
    row('o1', '1405/07/01', '11'), row('n1', '1406/07/03', '11'),             // تمدید
    row('o2', '1405/07/01', '12'), row('n2', '1405/10/01', '12'),             // فاصله کم
    row('o4a', '1405/07/01', '14'), row('o4b', '1405/09/01', '14'), row('n4', '1406/09/05', '14'), // دو خودرو
    row('o5', '1405/07/01', '15', 'الف'), row('n5', '1406/07/01', '15', 'ب')  // رشته متفاوت
  ];
  const r = await api({ action: 'import', token: A.token, rows });
  assert.equal(r.autoRenewed, 2);
  const ps = (await api({ action: 'getData', token: A.token })).policies;
  const st = no => ps.find(p => p.policyNo === no).status;
  assert.equal(st('o1'), 'renewed'); assert.equal(st('o2'), '');
  assert.equal(st('o4b'), 'renewed'); assert.equal(st('o4a'), ''); assert.equal(st('o5'), '');
  assert.match(ps.find(p => p.policyNo === 'o1').lastNote, /n1/);
  // ایمپورت مجدد: دوباره شمرده نمی‌شود
  assert.equal((await api({ action: 'import', token: A.token, rows })).autoRenewed, 0);
});

test('تاریخ صدور، فایل تکراری و ردیف تکراری', async () => {
  const rows = [
    row('i1', '1405/10/05', '31', 'خودرو', { issueDate: '1404/10/03' }),
    row('i1', '1405/10/05', '31', 'خودرو', { issueDate: '1404/10/03' }), // تکرار داخل خود فایل
    row('i2', '1405/11/05', '32')
  ];
  const count = async () => (await api({ action: 'getData', token: A.token })).policies.length;
  const base = await count();
  const r1 = await api({ action: 'import', token: A.token, rows, fileHash: 'h1', fileName: 'winter.xlsx' });
  assert.equal(r1.added, 2); assert.equal(r1.repeatedInFile, 1); assert.equal(r1.updated, 0);
  assert.equal(await count(), base + 2);
  const get = async no => (await api({ action: 'getData', token: A.token })).policies.find(p => p.policyNo === no);
  assert.equal((await get('i1')).issueDate, '1404/10/03');
  assert.equal((await get('i2')).issueDate, '');

  // همان فایل دوباره: ثبت نمی‌شود
  const r2 = await api({ action: 'import', token: A.token, rows, fileHash: 'h1', fileName: 'winter-again.xlsx' });
  assert.equal(r2.skipped, true); assert.equal(r2.previous.fileName, 'winter.xlsx');
  assert.equal(await count(), base + 2);

  // فایل دیگر با همان بیمه‌نامه‌ها: ردیف تکراری ساخته نمی‌شود
  const r3 = await api({ action: 'import', token: A.token, rows, fileHash: 'h2', fileName: 'copy.xlsx' });
  assert.equal(r3.added, 0); assert.equal(r3.updated, 2); assert.equal(r3.repeatedInFile, 1);
  assert.equal(await count(), base + 2);

  // نبودن تاریخ صدور در فایل بعدی، مقدار قبلی را پاک نمی‌کند
  await api({ action: 'import', token: A.token, rows: [row('i1', '1405/10/05', '31')], fileHash: 'h3' });
  assert.equal((await get('i1')).issueDate, '1404/10/03');

  // با تأیید صریح (force) می‌شود دوباره وارد کرد
  const r4 = await api({ action: 'import', token: A.token, rows, fileHash: 'h1', force: true });
  assert.equal(r4.skipped, undefined); assert.equal(r4.added, 0);

  // تاریخچه ایمپورت
  const hist = (await api({ action: 'getData', token: A.token })).imports;
  assert.ok(hist.length >= 3 && hist.some(h => h.fileName === 'winter.xlsx'));

  // نمایندگی دیگر فایل با همان هش را مستقل وارد می‌کند
  const rb = await api({ action: 'import', token: B.token, rows: [row('i1', '1405/10/05', '99')], fileHash: 'h1' });
  assert.equal(rb.skipped, undefined); assert.equal(rb.added, 1);
});

test('مهاجرت دیتابیس قدیمی بدون ستون issueDate', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { spawnSync } = require('node:child_process');
  const old = path.join(tmp, 'old.db');
  const d = new DatabaseSync(old);
  // ساختار قبلی جدول پرونده‌ها (بدون issueDate)
  const oldCols = ['policyNo', 'branch', 'internalCode', 'expiry', 'insuredName', 'insuredCode', 'mobile', 'phone', 'address', 'premium',
    'issuer', 'supervisor', 'referrer', 'assignedTo', 'status', 'lastActionAt', 'nextFollowUp', 'finalPremium', 'lastNote', 'importedAt'];
  d.exec(`CREATE TABLE policies (agencyId TEXT NOT NULL, ${oldCols.map(c => `${c} TEXT NOT NULL DEFAULT ''`).join(', ')}, PRIMARY KEY (agencyId, policyNo))`);
  d.prepare("INSERT INTO policies (agencyId, policyNo, branch, expiry) VALUES ('a1', 'old1', 'خودرو', '1405/07/01')").run();
  d.close();
  const r = spawnSync(process.execPath, ['-e', "require('./server.js')"], { cwd: __dirname, env: { ...process.env, DB_PATH: old }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d2 = new DatabaseSync(old);
  assert.ok(d2.prepare('PRAGMA table_info(policies)').all().some(c => c.name === 'issueDate'));
  assert.equal(d2.prepare("SELECT branch FROM policies WHERE policyNo = 'old1'").get().branch, 'خودرو');
  d2.close();
});

test('ثبت‌نام و گذرواژه قدیمی sha256 (مهاجرت از Sheet)', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(DB);
  const salt = 's1a2b3c4d';
  const hash = crypto.createHash('sha256').update(salt + '|' + 'old-pass', 'utf8').digest('base64');
  const agencyId = (await api({ action: 'getData', token: A.token })).me && d.prepare("SELECT agencyId FROM users WHERE username='agent_a'").get().agencyId;
  d.prepare("INSERT INTO users (username,name,role,algo,salt,hash,active,agencyId) VALUES ('legacy','قدیمی','employee','sha256',?,?,1,?)").run(salt, hash, agencyId);
  d.close();
  assert.match((await api({ action: 'login', username: 'legacy', password: 'nope' })).error, /اشتباه/);
  assert.equal((await api({ action: 'login', username: 'legacy', password: 'old-pass' })).ok, true);
  const d2 = new DatabaseSync(DB);
  assert.equal(d2.prepare("SELECT algo FROM users WHERE username='legacy'").get().algo, 'scrypt');
  d2.close();
  assert.equal((await api({ action: 'login', username: 'legacy', password: 'old-pass' })).ok, true);
});

test('پنل پلتفرم: حساب مالک، آمار، ریست رمز', async () => {
  const { spawnSync } = require('node:child_process');
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'admin.js'), ...args], { env: { ...process.env, DB_PATH: DB }, encoding: 'utf8' });
  const created = cli('create-super', 'Owner');
  const tmpPw = /رمز موقت:\s+(\S+)/.exec(created.stdout)[1];
  assert.equal(tmpPw.length, 10);
  assert.match(cli('create-super', 'owner').stderr, /وجود دارد/);

  // مالک با گزینه «مدیر» وارد می‌شود و باید رمز را عوض کند
  const S = await api({ action: 'login', username: 'owner', password: tmpPw, role: 'admin' });
  assert.equal(S.ok, true);
  assert.equal(S.user.role, 'super'); assert.equal(S.user.mustChange, true);
  assert.deepEqual(S.data.policies, []);   // هیچ داده مشتری‌ای برای مالک نیست
  assert.equal((await api({ action: 'changePassword', token: S.token, oldPassword: 'bad', newPassword: 'newpass1' })).error, 'رمز فعلی اشتباه است');
  assert.match((await api({ action: 'changePassword', token: S.token, oldPassword: tmpPw, newPassword: '123' })).error, /۶/);
  assert.equal((await api({ action: 'changePassword', token: S.token, oldPassword: tmpPw, newPassword: 'owner-pass-1' })).ok, true);
  const S2 = await api({ action: 'login', username: 'owner', password: 'owner-pass-1' });
  assert.equal(S2.user.mustChange, false);

  // آمار
  const ov = await api({ action: 'platformOverview', token: S2.token });
  assert.ok(ov.totals.agencies >= 2 && ov.totals.users >= 4 && ov.totals.policies > 0);
  assert.ok(ov.agencies.find(a => a.name === 'نمایندگی الف').policies >= 2);
  assert.ok(!ov.users.some(u => u.role === 'super'));
  assert.ok(!JSON.stringify(ov).includes('0912'), 'شماره مشتری نباید در پنل پلتفرم بیاید');

  // دیگران دسترسی ندارند
  const adm = await api({ action: 'login', username: 'agent_a', password: '123456' });
  for (const action of ['platformOverview', 'platformResetPassword', 'platformSetActive'])
    assert.match((await api({ action, token: adm.token, username: 'ali' })).error, /دسترسی/);

  // ریست رمز: رمز موقت، اجبار به تغییر، بستن نشست‌های قبلی
  const before = await api({ action: 'login', username: 'agent_a', password: '123456' });
  const rs = await api({ action: 'platformResetPassword', token: S2.token, username: 'Agent_A' });
  assert.equal(rs.tempPassword.length, 10);
  assert.equal((await api({ action: 'getData', token: before.token })).error, 'auth');
  assert.match((await api({ action: 'login', username: 'agent_a', password: '123456' })).error, /اشتباه/);
  const again = await api({ action: 'login', username: 'agent_a', password: rs.tempPassword });
  assert.equal(again.ok, true); assert.equal(again.user.mustChange, true);
  assert.equal((await api({ action: 'changePassword', token: again.token, oldPassword: rs.tempPassword, newPassword: 'my-new-pass' })).ok, true);
  assert.equal((await api({ action: 'login', username: 'agent_a', password: 'my-new-pass' })).user.mustChange, false);
  assert.match((await api({ action: 'platformResetPassword', token: S2.token, username: 'owner' })).error, /پیدا نشد/);

  // غیرفعال/فعال از پنل
  await api({ action: 'platformSetActive', token: S2.token, username: 'ali', active: false });
  assert.match((await api({ action: 'login', username: 'ali', password: '5678' })).error, /اشتباه/);
  await api({ action: 'platformSetActive', token: S2.token, username: 'ali', active: true });
  assert.equal((await api({ action: 'login', username: 'ali', password: '5678' })).ok, true);

  // کارمندی که مدیر ساخته، باید رمز را عوض کند
  const mk = await api({ action: 'saveUser', token: (await api({ action: 'login', username: 'agent_a', password: 'my-new-pass' })).token, username: 'newbie', name: 'تازه', password: '1234' });
  assert.equal(mk.ok, true);
  assert.equal((await api({ action: 'login', username: 'newbie', password: '1234' })).user.mustChange, true);

  // ثبت در گزارش
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(DB);
  const acts = d.prepare('SELECT action, actor FROM audit ORDER BY rowid').all().map(r => r.actor + ':' + r.action);
  d.close();
  assert.ok(acts.includes('cli:create-super') && acts.includes('owner:reset-password') && acts.includes('owner:deactivate'));
});

test('محدودیت تلاش ورود', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await api({ action: 'login', username: 'agent_b', password: 'wrong' + i });
  assert.match(last.error, /زیاد/);
});

test('فایل‌های استاتیک و امنیت مسیر', async () => {
  const idx = await fetch(BASE + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /پیگیری تمدید بیمه/);
  assert.equal((await fetch(BASE + '/app.js')).status, 200);
  assert.equal((await fetch(BASE + '/%2e%2e/server/server.js')).status === 200, false);
  assert.equal((await fetch(BASE + '/nope.txt')).status, 404);
});

test('REGISTER_CODE', async () => {
  proc.kill();
  await new Promise(r => setTimeout(r, 300));
  await start({ REGISTER_CODE: 'abc' });
  assert.equal((await api({ action: 'ping' })).requiresCode, true);
  assert.match((await api({ action: 'register', agencyName: 'q', name: 'q', username: 'newone', password: '123456' })).error, /کد/);
  assert.equal((await api({ action: 'register', agencyName: 'q', name: 'q', username: 'newone', password: '123456', code: 'abc' })).ok, true);
});
