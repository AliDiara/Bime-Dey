'use strict';

/* ================= ثابت‌ها ================= */
const TYPES = {
  no_answer: 'پاسخ نداد',
  promised: 'قول تمدید داد',
  followup: 'نیاز به پیگیری بعدی',
  renewed: 'تمدید شد',
  sold: 'خودرو فروخته شد',
  cancelled: 'بیمه‌نامه کنسل شد',
  declined: 'تمایل به تمدید ندارد',
  wrong_number: 'شماره اشتباه است',
  note: 'فقط یادداشت'
};
const STATUS = {
  '': ['جدید', 'b-mute'],
  no_answer: ['پاسخ نداد', 'b-warn'],
  promised: ['قول داده', 'b-info'],
  followup: ['در پیگیری', 'b-info'],
  renewed: ['تمدید شد', 'b-good'],
  sold: ['فروخته شد', 'b-mute'],
  cancelled: ['کنسل', 'b-mute'],
  declined: ['منصرف', 'b-mute'],
  wrong_number: ['شماره اشتباه', 'b-bad']
};
const TERMINAL = ['renewed', 'sold', 'cancelled', 'declined'];
const RANGES = [
  ['all', 'همه'], ['overdue', 'گذشته'], ['d7', '۷ روز'], ['d30', '۸ تا ۳۰ روز'], ['d60', '۳۱ تا ۶۰ روز'], ['followup', 'پیگیری امروز']
];

/* ================= ابزارها ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const faNum = n => Number(n || 0).toLocaleString('fa-IR');
const money = n => (n === '' || n == null || isNaN(n)) ? '—' : faNum(n) + ' ریال';
function normText(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').replace(/\s+/g, ' ').trim();
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

/* ================= API ================= */
let API = ls.get('api') || '';
let TOKEN = ls.get('token') || '';

async function call(action, payload = {}) {
  if (API === 'demo') return demoCall(action, payload);
  let res;
  try {
    res = await fetch(API, { method: 'POST', body: JSON.stringify({ action, token: TOKEN, ...payload }) });
  } catch {
    throw new Error('ارتباط با سرور برقرار نشد (اینترنت یا آدرس را بررسی کنید)');
  }
  const j = await res.json();
  if (j.error) {
    if (j.error === 'auth') { logout(true); throw new Error('نشست منقضی شد، دوباره وارد شوید'); }
    throw new Error(j.error);
  }
  return j;
}

/* حالت آزمایشی: همه‌چیز در مرورگر ذخیره می‌شود (برای دمو و تست بدون گوگل) */
function demoDB() {
  const d = ls.get('demo_db');
  if (d) return JSON.parse(d);
  return {
    users: [
      { username: 'admin', name: 'نماینده (دمو)', role: 'admin', active: true, password: '1234' },
      { username: 'ali', name: 'علی (دمو)', role: 'employee', active: true, password: '1234' },
      { username: 'sara', name: 'سارا (دمو)', role: 'employee', active: true, password: '1234' }
    ], policies: [], actions: []
  };
}
function demoCall(action, p) {
  const db = demoDB();
  const save = () => ls.set('demo_db', JSON.stringify(db));
  const pub = u => ({ username: u.username, name: u.name, role: u.role, active: u.active });
  const me = db.users.find(u => u.username === ls.get('demo_me'));
  switch (action) {
    case 'ping': return { ok: true, requiresCode: false };
    case 'login': {
      const u = db.users.find(x => x.username === p.username && x.password === p.password && x.active);
      if (!u) throw new Error('نام کاربری یا رمز اشتباه است');
      ls.set('demo_me', u.username);
      return { ok: true, token: 'demo', user: pub(u) };
    }
    case 'getData': return { ok: true, me: pub(me), agency: { id: 'demo', name: 'نمایندگی آزمایشی' }, policies: db.policies, actions: db.actions, users: db.users.map(pub) };
    case 'import': {
      const idx = {}; db.policies.forEach((x, i) => idx[x.policyNo] = i);
      let added = 0, updated = 0;
      p.rows.forEach(r => {
        if (idx[r.policyNo] === undefined) {
          db.policies.push({ assignedTo: '', status: '', lastActionAt: '', nextFollowUp: '', finalPremium: '', lastNote: '', ...r });
          idx[r.policyNo] = db.policies.length - 1; added++;
        } else { Object.assign(db.policies[idx[r.policyNo]], r); updated++; }
      });
      save(); return { ok: true, added, updated, total: db.policies.length };
    }
    case 'addAction': {
      const pol = db.policies.find(x => x.policyNo === p.policyNo);
      const a = { id: Math.random().toString(36).slice(2, 10), policyNo: p.policyNo, user: me.username, type: p.type, note: p.note || '', nextFollowUp: p.nextFollowUp || '', amount: p.amount || '', at: new Date().toISOString() };
      db.actions.push(a);
      applyAction(pol, a, me.username);
      save(); return { ok: true, action: a };
    }
    case 'assign':
      p.policyNos.forEach(no => { const x = db.policies.find(q => q.policyNo === no); if (x) x.assignedTo = p.to || ''; });
      save(); return { ok: true, changed: p.policyNos };
    case 'saveUser': {
      let u = db.users.find(x => x.username === p.username);
      if (!u) { u = { username: p.username, name: p.name || p.username, role: 'employee', active: true, password: p.password }; db.users.push(u); }
      if (p.name) u.name = p.name;
      if (p.role) u.role = p.role;
      if (p.password) u.password = p.password;
      if (p.active !== undefined) u.active = p.active;
      save(); return { ok: true, users: db.users.map(pub) };
    }
  }
  throw new Error('عملیات نامعتبر');
}

/* ================= وضعیت برنامه ================= */
const S = {
  user: null, data: { policies: [], actions: [], users: [] },
  tab: 'dash', scope: '', limit: 60,
  f: { q: '', range: 'all', status: 'open', branch: '', assignee: '' },
  today: Jal.todayJdn()
};

function applyAction(p, a, username) {
  const st = { no_answer: 'no_answer', promised: 'promised', followup: 'followup', renewed: 'renewed', sold: 'sold', cancelled: 'cancelled', declined: 'declined', wrong_number: 'wrong_number', note: '' }[a.type];
  if (st) p.status = st;
  if (!p.assignedTo) p.assignedTo = username;
  p.lastActionAt = a.at;
  p.nextFollowUp = ['renewed', 'sold', 'cancelled', 'declined', 'wrong_number'].includes(a.type) ? '' : a.nextFollowUp;
  if (a.note) p.lastNote = a.note;
  if (a.type === 'renewed' && a.amount) p.finalPremium = a.amount;
}

function enrich() {
  S.today = Jal.todayJdn();
  S.data.policies.forEach(p => {
    p.jdn = Jal.parse(p.expiry);
    p.days = p.jdn == null ? null : p.jdn - S.today;
    p.open = !TERMINAL.includes(p.status);
    p.fu = Jal.parse(p.nextFollowUp);
    p.premiumN = Number(p.premium) || 0;
  });
  S.names = {};
  S.data.users.forEach(u => S.names[u.username] = u.name);
  S.names.system = 'سیستم';
}
const uname = u => u ? (S.names[u] || u) : 'بدون مسئول';
const isAdmin = () => S.user.role === 'admin';

async function load() {
  const d = await call('getData');
  S.user = d.me;
  S.agency = d.agency || { name: '' };
  S.data = { policies: d.policies, actions: d.actions, users: d.users };
  enrich();
}

function logout(silent) {
  S.authMode = 'login'; S.requiresCode = undefined;
  TOKEN = ''; ls.del('token'); ls.del('demo_me'); S.user = null;
  if (!silent) toast('خارج شدید');
  renderLogin();
}

/* ================= ورود / راه‌اندازی ================= */
async function renderLogin(err = '') {
  const app = $('#app');
  if (!API) {
    app.innerHTML = `<div class="login card"><h1>پیگیری تمدید بیمه</h1>
      <p>آدرس Web App که از گوگل شیت گرفته‌اید را وارد کنید. کارمندان معمولاً با لینک اختصاصی که نماینده می‌دهد خودکار وارد می‌شوند.</p>
      <div class="f"><label>آدرس سرور (Apps Script)</label><input id="api" dir="ltr" placeholder="https://script.google.com/macros/s/.../exec"></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn pri" style="width:100%" data-act="saveApi">ادامه</button>
      <p style="text-align:center"><a href="#" data-act="demo">امتحان در حالت آزمایشی</a></p></div>`;
    return;
  }
  if (S.requiresCode === undefined) {
    app.innerHTML = `<div class="login card"><h1>پیگیری تمدید بیمه</h1><p class="empty">در حال اتصال…</p></div>`;
    try { S.requiresCode = !!(await call('ping')).requiresCode; } catch (e) { err = e.message; S.requiresCode = false; S.pingFailed = true; }
  }
  const mode = S.authMode || 'login';
  const role = ls.get('role') === 'employee' ? 'employee' : 'admin';
  const seg = `<div class="seg"><button data-mode="login" class="${mode === 'login' ? 'on' : ''}">ورود</button><button data-mode="register" class="${mode === 'register' ? 'on' : ''}">ثبت‌نام نماینده جدید</button></div>`;
  const demo = API === 'demo';
  app.innerHTML = `<div class="login card"><h1>پیگیری تمدید بیمه</h1>${demo ? '' : seg}
    ${mode === 'register' && !demo ? `
      <p class="meta">برای نمایندگی جدید حساب مدیر بسازید. بعد از ورود، فایل اکسل بیمه دی را بارگذاری و کارمندانتان را تعریف می‌کنید.</p>
      <div class="f"><label>نام نمایندگی</label><input id="ag"></div>
      <div class="f"><label>نام مدیر</label><input id="nm"></div>
      <div class="f"><label>نام کاربری (لاتین، حداقل ۳ کاراکتر)</label><input id="un" dir="ltr" autocapitalize="off" autocomplete="username"></div>
      <div class="f"><label>رمز عبور (حداقل ۶ کاراکتر)</label><input id="pw" type="password" dir="ltr" autocomplete="new-password"></div>
      ${S.requiresCode ? '<div class="f"><label>کد ثبت‌نام (از ارائه‌دهنده نرم‌افزار بگیرید)</label><input id="code" dir="ltr"></div>' : ''}
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn pri" style="width:100%" data-act="register">ساخت حساب مدیر</button>`
    : `
      ${demo ? '<p class="meta">حالت آزمایشی — مدیر: admin / 1234 — کارمند: ali / 1234</p>' : `
      <div class="f"><label>ورود به‌عنوان</label><div class="seg">
        <label><input type="radio" name="role" value="admin" ${role === 'admin' ? 'checked' : ''}> مدیر (نماینده)</label>
        <label><input type="radio" name="role" value="employee" ${role === 'employee' ? 'checked' : ''}> کارمند</label></div></div>`}
      <div class="f"><label>نام کاربری</label><input id="un" dir="ltr" autocapitalize="off" autocomplete="username" value="${demo ? 'admin' : ''}"></div>
      <div class="f"><label>رمز عبور</label><input id="pw" type="password" dir="ltr" autocomplete="current-password" value="${demo ? '1234' : ''}"></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn pri" style="width:100%" data-act="login">ورود</button>
      <p class="meta" style="text-align:center">کارمندان حساب را مدیر نمایندگی می‌سازد.</p>`}
    <p style="text-align:center"><a href="#" data-act="resetApi">تغییر آدرس سرور</a></p></div>`;
  const pw = $('#pw');
  if (pw) pw.addEventListener('keydown', e => { if (e.key === 'Enter') $('.login .btn.pri').click(); });
}

async function doAuth(action) {
  const body = { username: $('#un').value.trim(), password: $('#pw').value };
  if (action === 'login') {
    const r = document.querySelector('input[name=role]:checked');
    if (r) { body.role = r.value; ls.set('role', r.value); }
  } else {
    body.agencyName = $('#ag').value.trim();
    body.name = $('#nm').value.trim();
    body.code = $('#code') ? $('#code').value.trim() : '';
  }
  const btn = $('.login .btn.pri');
  btn.disabled = true;
  try {
    const r = await call(action, body);
    TOKEN = r.token; ls.set('token', TOKEN);
    if (action === 'register') S.fresh = true;
    await boot();
  } catch (e) { $('#err').textContent = e.message; btn.disabled = false; }
}

/* ================= قاب اصلی ================= */
function renderShell() {
  const tabs = [['dash', '📊', 'داشبورد'], ['list', '📋', 'تمدیدها'], ['follow', '📞', 'پیگیری امروز']];
  if (isAdmin()) tabs.push(['admin', '⚙️', 'مدیریت']);
  $('#app').innerHTML = `
    <div class="top"><h1>${esc(S.agency?.name || 'پیگیری تمدید بیمه')}</h1>
      <div style="display:flex;gap:8px;align-items:center"><span class="who">${esc(S.user.name)}${isAdmin() ? ' (مدیر)' : ''}</span>
      <button class="btn sm" data-act="refresh">⟳ بروزرسانی</button><button class="btn sm" data-act="logout">خروج</button></div></div>
    <div class="nav">${tabs.map(t => `<button data-tab="${t[0]}"><span class="ic">${t[1]}</span>${t[2]}</button>`).join('')}</div>
    <div id="view"></div>`;
  renderView();
}

function renderView() {
  const active = S.tab === 'list' && S.f.range === 'followup' ? 'follow' : S.tab;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === active));
  if (S.tab === 'dash') renderDash();
  else if (S.tab === 'admin') renderAdmin();
  else renderListView();
}

/* ================= داشبورد ================= */
const short = n => {
  if (n >= 1e9) return Number((n / 1e9).toFixed(1)).toLocaleString('fa-IR') + ' میلیارد';
  if (n >= 1e6) return Number((n / 1e6).toFixed(1)).toLocaleString('fa-IR') + ' میلیون';
  return faNum(n);
};
const BUCKETS = [
  ['overdue', 'سررسید گذشته', 'var(--c-bad)'],
  ['d7', 'تا ۷ روز', 'var(--c-orange)'],
  ['d30', '۸ تا ۳۰ روز', 'var(--c-amber)'],
  ['d60', '۳۱ تا ۶۰ روز', 'var(--c-blue)'],
  ['later', 'بیش از ۶۰ روز', 'var(--c-slate)']
];

function donut(parts, total, centerTop, centerBottom) {
  const R = 42, C = 2 * Math.PI * R, gap = 2.5;
  let off = 0, arcs = '';
  parts.forEach(p => {
    if (!p.v || !total) return;
    const len = Math.max(p.v / total * C - gap, 0.5);
    arcs += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${p.c}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"><title>${p.l}: ${faNum(p.v)}</title></circle>`;
    off += p.v / total * C;
  });
  return `<svg viewBox="0 0 120 120" class="donut" role="img" aria-label="${centerBottom}">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="14"/>${arcs}
    <text x="60" y="60" text-anchor="middle" class="dn">${centerTop}</text>
    <text x="60" y="78" text-anchor="middle" class="dl">${centerBottom}</text></svg>`;
}

function renderDash() {
  if (!S.scope) S.scope = isAdmin() ? 'all' : S.user.username;
  const all = S.data.policies.filter(p => p.days != null);
  const pols = S.scope === 'all' ? all : all.filter(p => p.assignedTo === S.scope);
  const open = pols.filter(p => p.open);
  const sum = a => a.reduce((s, p) => s + p.premiumN, 0);
  const B = {
    overdue: open.filter(p => p.days < 0),
    d7: open.filter(p => p.days >= 0 && p.days <= 7),
    d30: open.filter(p => p.days > 7 && p.days <= 30),
    d60: open.filter(p => p.days > 30 && p.days <= 60),
    later: open.filter(p => p.days > 60)
  };
  const renewed = pols.filter(p => p.status === 'renewed');
  const lost = pols.filter(p => ['sold', 'cancelled', 'declined'].includes(p.status));
  const inProg = pols.filter(p => ['no_answer', 'promised', 'followup', 'wrong_number'].includes(p.status));
  const fresh = pols.filter(p => p.status === '');
  const fuDue = open.filter(p => p.fu != null && p.fu <= S.today);
  const rateRaw = pols.length ? renewed.length / pols.length * 100 : 0;
  const rate = rateRaw > 0 && rateRaw < 10 ? Number(rateRaw.toFixed(1)) : Math.round(rateRaw);
  const renewedSum = renewed.reduce((s, p) => s + (Number(p.finalPremium) || p.premiumN), 0);
  const pct = n => open.length ? Math.round(n / open.length * 100) : 0;

  // فوری‌ترین‌ها
  const cand = open.filter(p => p.days <= 7);
  const recent = cand.filter(p => p.days >= -30);
  const urgent = (recent.length ? recent : cand).slice().sort((a, b) => a.days - b.days).slice(0, 6);

  // فعالیت ۱۴ روز اخیر
  const acts = S.data.actions.filter(a => S.scope === 'all' || a.user === S.scope);
  const days14 = Array.from({ length: 14 }, (_, i) => S.today - 13 + i);
  const cnt = days14.map(d => acts.filter(a => Jal.isoToJdn(a.at) === d).length);
  const cmax = Math.max(1, ...cnt);

  const scopeSel = `<select data-scope>${isAdmin() ? '<option value="all">همه کارمندان</option>' : ''}${S.data.users.filter(u => isAdmin() || u.username === S.user.username).map(u => `<option value="${esc(u.username)}" ${S.scope === u.username ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;

  const kpi = (cls, ic, n, l, sub, go) => `<div class="card kpi2 ${cls}" ${go ? `data-go="${go}"` : ''}><span class="ico">${ic}</span><div class="n">${n}</div><div class="l">${l}</div><div class="sub">${sub}</div></div>`;

  let emp = '';
  if (isAdmin()) {
    const rows = S.data.users.filter(u => u.active).map(u => {
      const mine = all.filter(p => p.assignedTo === u.username);
      const ren = mine.filter(p => p.status === 'renewed');
      const done = mine.filter(p => !p.open).length;
      const todayActs = S.data.actions.filter(a => a.user === u.username && Jal.isoToJdn(a.at) === S.today).length;
      const prog = mine.length ? Math.round(done / mine.length * 100) : 0;
      return `<tr><td><b>${esc(u.name)}</b><div class="meta">${u.role === 'admin' ? 'مدیر' : 'کارمند'}</div></td><td>${faNum(mine.length)}</td><td>${faNum(mine.length - done)}</td><td>${faNum(todayActs)}</td><td>${faNum(ren.length)}</td><td style="min-width:110px"><div class="mini"><i style="width:${prog}%"></i></div><span class="meta">${faNum(prog)}٪ بسته‌شده</span></td></tr>`;
    }).join('');
    const un = all.filter(p => !p.assignedTo);
    emp = `<div class="card" style="margin-top:12px;overflow:auto"><div class="ct">عملکرد کارمندان</div><table><tr><th>کارمند</th><th>پرونده</th><th>باز</th><th>اقدام امروز</th><th>تمدید</th><th>پیشرفت</th></tr>${rows}<tr><td><b>بدون مسئول</b></td><td>${faNum(un.length)}</td><td>${faNum(un.filter(p => p.open).length)}</td><td>—</td><td>—</td><td></td></tr></table></div>`;
  }

  $('#view').innerHTML = `
    <div class="dhead"><div><div class="hi">سلام ${esc(S.user.name)} 👋</div><div class="meta">امروز ${Jal.format(S.today)} · ${faNum(open.length)} پرونده باز از ${faNum(pols.length)}</div></div>${scopeSel}</div>

    <div class="grid kpis">
      ${kpi('k-bad', '⚠️', faNum(B.overdue.length), 'سررسید گذشته', short(sum(B.overdue)) + ' ریال در خطر', 'overdue')}
      ${kpi('k-org', '⏰', faNum(B.d7.length), 'تا ۷ روز آینده', short(sum(B.d7)) + ' ریال', 'd7')}
      ${kpi('k-blue', '📞', faNum(fuDue.length), 'پیگیری امروز و عقب‌افتاده', 'برنامه تماس', 'followup')}
      ${kpi('k-good', '✅', faNum(rate) + '٪', 'نرخ تمدید', `${faNum(renewed.length)} از ${faNum(pols.length)} · ${short(renewedSum)} ریال`, '')}
    </div>

    <div class="two" style="margin-top:12px">
      <div class="card"><div class="ct">وضعیت سررسید پرونده‌های باز</div>
        <div class="stack">${BUCKETS.map(b => `<i style="flex:${B[b[0]].length || 0};background:${b[2]}" title="${b[1]}: ${faNum(B[b[0]].length)}"></i>`).join('')}</div>
        <div class="legend">${BUCKETS.map(b => `<div class="lrow" data-go="${b[0] === 'later' ? 'all' : b[0]}"><span class="dot" style="background:${b[2]}"></span><span class="ll">${b[1]}</span><b>${faNum(B[b[0]].length)}</b><span class="meta pc">${faNum(pct(B[b[0]].length))}٪</span><span class="meta pm">${short(sum(B[b[0]]))}</span></div>`).join('')}</div></div>
      <div class="card"><div class="ct">پیشرفت تمدید</div>
        <div class="dwrap">${donut([
          { l: 'تمدید شد', v: renewed.length, c: 'var(--c-good)' },
          { l: 'در حال پیگیری', v: inProg.length, c: 'var(--c-blue)' },
          { l: 'ازدست‌رفته', v: lost.length, c: 'var(--c-slate)' },
          { l: 'بدون اقدام', v: fresh.length, c: 'var(--c-amber)' }
        ], pols.length, faNum(rate) + '٪', 'تمدید شده')}
        <div class="legend" style="flex:1;min-width:160px">
          <div class="lrow" style="cursor:default"><span class="dot" style="background:var(--c-good)"></span><span class="ll">تمدید شد</span><b>${faNum(renewed.length)}</b></div>
          <div class="lrow" style="cursor:default"><span class="dot" style="background:var(--c-blue)"></span><span class="ll">در حال پیگیری</span><b>${faNum(inProg.length)}</b></div>
          <div class="lrow" style="cursor:default"><span class="dot" style="background:var(--c-amber)"></span><span class="ll">بدون اقدام</span><b>${faNum(fresh.length)}</b></div>
          <div class="lrow" style="cursor:default"><span class="dot" style="background:var(--c-slate)"></span><span class="ll">ازدست‌رفته</span><b>${faNum(lost.length)}</b></div>
          <div class="meta" style="margin-top:6px">ازدست‌رفته: ${short(sum(lost))} ریال (فروش خودرو، کنسل، انصراف)</div></div></div></div>
    </div>

    <div class="two" style="margin-top:12px">
      <div class="card"><div class="ct">نیاز به اقدام فوری</div>
        ${urgent.length ? urgent.map(p => `<div class="urow"><div style="flex:1;min-width:0"><div class="nm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.insuredName)}</div><div class="meta"><span>${esc(p.branch)}</span><span>${money(p.premiumN)}</span></div></div>${dayBadge(p)}${p.mobile ? `<a class="btn sm" href="tel:${esc(p.mobile)}">📞</a>` : ''}<button class="btn sm pri" data-open="${esc(p.policyNo)}">اقدام</button></div>`).join('') : '<div class="empty">پرونده فوری ندارید 🎉</div>'}
        ${cand.length > urgent.length ? `<button class="btn more" data-go="d7" style="margin-top:8px">مشاهده همه (${faNum(cand.length)})</button>` : ''}</div>
      <div class="card"><div class="ct">اقدامات ۱۴ روز اخیر <span class="meta">(${faNum(cnt.reduce((a, b) => a + b, 0))} اقدام)</span></div>
        <div class="cols">${cnt.map((v, i) => `<div class="col" title="${Jal.format(days14[i])}: ${faNum(v)} اقدام"><i style="height:${v / cmax * 100}%"></i><span>${faNum(Jal.format(days14[i]).slice(-2))}</span></div>`).join('')}</div></div>
    </div>
    ${emp}`;
}

/* ================= لیست تمدیدها ================= */
function renderListView() {
  const branches = [...new Set(S.data.policies.map(p => p.branch))].filter(Boolean).sort();
  if (S.f.assignee === '') S.f.assignee = isAdmin() ? 'all' : 'mineplus';
  const f = S.f;
  $('#view').innerHTML = `
    <div class="chips">${RANGES.map(r => `<button class="chip ${f.range === r[0] ? 'on' : ''}" data-range="${r[0]}">${r[1]}</button>`).join('')}</div>
    <div class="filters">
      <input id="q" type="search" placeholder="جستجو: نام، موبایل، شماره بیمه‌نامه" value="${esc(f.q)}">
      <select data-f="status">${[['open', 'باز (تمدیدنشده)'], ['all', 'همه وضعیت‌ها'], ['', 'جدید (بدون اقدام)']].concat(Object.entries(STATUS).filter(([k]) => k).map(([k, v]) => [k, v[0]])).map(o => `<option value="${o[0]}" ${f.status === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
      <select data-f="branch"><option value="">همه رشته‌ها</option>${branches.map(b => `<option ${f.branch === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <select data-f="assignee"><option value="all" ${f.assignee === 'all' ? 'selected' : ''}>همه پرونده‌ها</option><option value="mineplus" ${f.assignee === 'mineplus' ? 'selected' : ''}>من + بدون مسئول</option><option value="mine" ${f.assignee === 'mine' ? 'selected' : ''}>فقط من</option><option value="none" ${f.assignee === 'none' ? 'selected' : ''}>بدون مسئول</option>${S.data.users.map(u => `<option value="u:${esc(u.username)}" ${f.assignee === 'u:' + u.username ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
    </div>
    <div id="count" class="meta" style="margin-bottom:8px"></div><div id="list"></div>`;
  renderList();
}

function filtered() {
  const f = S.f, q = normText(f.q).toLowerCase(), me = S.user.username;
  let a = S.data.policies.filter(p => {
    if (f.status === 'open' ? !p.open : (f.status !== 'all' && p.status !== f.status)) return false;
    if (f.branch && p.branch !== f.branch) return false;
    if (f.assignee === 'mine' && p.assignedTo !== me) return false;
    if (f.assignee === 'mineplus' && p.assignedTo && p.assignedTo !== me) return false;
    if (f.assignee === 'none' && p.assignedTo) return false;
    if (f.assignee.startsWith('u:') && p.assignedTo !== f.assignee.slice(2)) return false;
    if (f.range !== 'all') {
      if (f.range === 'followup') { if (!(p.open && p.fu != null && p.fu <= S.today)) return false; }
      else {
        if (p.days == null) return false;
        const d = p.days;
        if (f.range === 'overdue' && !(d < 0)) return false;
        if (f.range === 'd7' && !(d >= 0 && d <= 7)) return false;
        if (f.range === 'd30' && !(d > 7 && d <= 30)) return false;
        if (f.range === 'd60' && !(d > 30 && d <= 60)) return false;
      }
    }
    if (q && !(`${p.insuredName} ${p.mobile} ${p.phone} ${p.policyNo} ${p.insuredCode}`.toLowerCase().includes(q))) return false;
    return true;
  });
  a.sort(f.range === 'followup' ? (x, y) => x.fu - y.fu : (x, y) => (x.days ?? 1e9) - (y.days ?? 1e9));
  return a;
}

function dayBadge(p) {
  if (p.days == null) return '<span class="badge b-mute">تاریخ نامعتبر</span>';
  if (!p.open) return '';
  const d = p.days;
  if (d < 0) return `<span class="badge b-bad">${faNum(-d)} روز گذشته</span>`;
  if (d === 0) return '<span class="badge b-bad">امروز</span>';
  return `<span class="badge ${d <= 7 ? 'b-warn' : 'b-info'}">${faNum(d)} روز مانده</span>`;
}
const waLink = m => 'https://wa.me/98' + String(m).replace(/^0/, '');

function renderList() {
  const a = filtered();
  $('#count').textContent = `${faNum(a.length)} پرونده`;
  const show = a.slice(0, S.limit);
  $('#list').innerHTML = show.length ? show.map(p => `
    <div class="card item">
      <div class="r1"><div><div class="nm">${esc(p.insuredName || '—')}</div>
        <div class="meta"><span>${esc(p.branch)}</span><span>انقضا: ${esc(p.expiry)}</span><span>${money(p.premiumN)}</span></div></div>
        <div style="text-align:left;display:grid;gap:4px;justify-items:end">${dayBadge(p)}<span class="badge ${STATUS[p.status]?.[1] || 'b-mute'}">${STATUS[p.status]?.[0] || p.status}</span></div></div>
      <div class="meta"><span>مسئول: ${esc(uname(p.assignedTo))}</span>${p.fu != null ? `<span>پیگیری: ${esc(p.nextFollowUp)}</span>` : ''}${p.lastNote ? `<span>📝 ${esc(p.lastNote.slice(0, 60))}</span>` : ''}</div>
      <div class="acts">
        ${p.mobile ? `<a class="btn sm" href="tel:${esc(p.mobile)}">📞 ${esc(p.mobile)}</a><a class="btn sm" href="${waLink(p.mobile)}" target="_blank" rel="noopener">واتساپ</a>` : ''}
        <button class="btn sm pri" data-open="${esc(p.policyNo)}">ثبت اقدام / جزئیات</button></div>
    </div>`).join('') + (a.length > show.length ? `<button class="btn more" data-act="more">نمایش بیشتر (${faNum(a.length - show.length)} مورد دیگر)</button>` : '')
    : '<div class="empty">موردی پیدا نشد</div>';
}

/* ================= جزئیات و ثبت اقدام ================= */
function openPolicy(no) {
  const p = S.data.policies.find(x => x.policyNo === no);
  if (!p) return;
  const hist = S.data.actions.filter(a => a.policyNo === no).sort((a, b) => b.at.localeCompare(a.at));
  const locked = !isAdmin() && p.assignedTo && p.assignedTo !== S.user.username;
  const fuBtns = [1, 3, 7].map(n => `<button type="button" class="btn sm" data-fu="${n}">+${faNum(n)} روز</button>`).join(' ');
  const assignCtl = isAdmin()
    ? `<select id="asg">${'<option value="">بدون مسئول</option>' + S.data.users.filter(u => u.active).map(u => `<option value="${esc(u.username)}" ${p.assignedTo === u.username ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select> <button class="btn sm" data-act="assign">واگذاری</button>`
    : (!p.assignedTo ? '<button class="btn sm" data-act="take">برداشتن پرونده</button>' : (p.assignedTo === S.user.username ? '<button class="btn sm" data-act="release">رها کردن</button>' : ''));
  const ov = document.createElement('div');
  ov.className = 'ov'; ov.dataset.no = no;
  ov.innerHTML = `<div class="modal">
    <div style="display:flex;justify-content:space-between"><h3>${esc(p.insuredName)}</h3><button class="btn sm" data-act="close">✕</button></div>
    <div class="meta"><span>${esc(p.branch)}</span><span>شماره: <bdi>${esc(p.policyNo)}</bdi></span></div>
    <div class="meta"><span>انقضا: ${esc(p.expiry)}</span><span>${money(p.premiumN)}</span>${dayBadge(p)}</div>
    <div class="meta"><span>موبایل: ${esc(p.mobile) || '—'}</span><span>تلفن: ${esc(p.phone) || '—'}</span></div>
    <div class="meta"><span>${esc(p.address)}</span></div>
    <div class="meta" style="margin-top:6px"><span>مسئول: <b>${esc(uname(p.assignedTo))}</b></span>${assignCtl}</div>
    <div class="acts" style="margin:8px 0">${p.mobile ? `<a class="btn sm" href="tel:${esc(p.mobile)}">📞 تماس</a><a class="btn sm" href="${waLink(p.mobile)}" target="_blank" rel="noopener">واتساپ</a>` : ''}</div>
    ${locked ? '<div class="card meta">این پرونده به کارمند دیگری واگذار شده و فقط قابل مشاهده است.</div>' : `
    <div class="f"><label>نتیجه</label><select id="a_type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="f" id="a_amt_w" style="display:none"><label>حق بیمه نهایی (ریال)</label><input id="a_amt" inputmode="numeric" value="${p.premiumN || ''}"></div>
    <div class="f" id="a_fu_w"><label>تاریخ پیگیری بعدی (شمسی، مثل ${Jal.format(S.today + 3)})</label><input id="a_fu" dir="ltr" placeholder="${Jal.format(S.today + 3)}"><div>${fuBtns}</div></div>
    <div class="f"><label>یادداشت</label><textarea id="a_note" placeholder="مثلاً: گفت آخر هفته زنگ بزنید"></textarea></div>
    <button class="btn pri" style="width:100%" data-act="saveAction">ثبت</button>`}
    <h2>تاریخچه</h2>
    <div class="hist">${hist.length ? hist.map(a => `<div><b>${TYPES[a.type] || a.type}</b> — ${esc(uname(a.user))}<br><span class="meta">${Jal.format(Jal.isoToJdn(a.at))} ${new Date(a.at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}${a.nextFollowUp ? ' · پیگیری: ' + esc(a.nextFollowUp) : ''}${a.amount ? ' · ' + money(a.amount) : ''}</span>${a.note ? '<br>' + esc(a.note) : ''}</div>`).join('') : '<div class="meta">هنوز اقدامی ثبت نشده</div>'}</div>
  </div>`;
  document.body.appendChild(ov);
  const type = $('#a_type');
  if (type) type.addEventListener('change', () => {
    $('#a_amt_w').style.display = type.value === 'renewed' ? '' : 'none';
    $('#a_fu_w').style.display = ['promised', 'followup', 'no_answer', 'note'].includes(type.value) ? '' : 'none';
  });
}
const closeModal = () => document.querySelectorAll('.ov').forEach(o => o.remove());

async function saveAction(btn) {
  const no = btn.closest('.ov').dataset.no;
  const type = $('#a_type').value;
  const fuRaw = normText($('#a_fu').value);
  let fu = '';
  if (fuRaw && ['promised', 'followup', 'no_answer', 'note'].includes(type)) {
    const j = Jal.parse(fuRaw);
    if (j == null) return toast('تاریخ پیگیری نامعتبر است (مثل ۱۴۰۵/۰۷/۲۰)');
    fu = Jal.format(j);
  }
  if (['followup', 'promised'].includes(type) && !fu) return toast('تاریخ پیگیری بعدی را وارد کنید');
  const payload = { policyNo: no, type, note: $('#a_note').value.trim(), nextFollowUp: fu, amount: type === 'renewed' ? normText($('#a_amt').value).replace(/\D/g, '') : '' };
  btn.disabled = true;
  try {
    const r = await call('addAction', payload);
    const p = S.data.policies.find(x => x.policyNo === no);
    S.data.actions.push(r.action);
    applyAction(p, r.action, S.user.username);
    enrich();
    closeModal();
    toast('ثبت شد');
    renderView();
  } catch (e) { toast(e.message); btn.disabled = false; }
}

async function assign(no, to) {
  try {
    await call('assign', { policyNos: [no], to });
    S.data.policies.find(x => x.policyNo === no).assignedTo = to;
    closeModal(); toast('انجام شد'); renderView(); openPolicy(no);
  } catch (e) { toast(e.message); }
}

/* ================= مدیریت ================= */
function renderAdmin() {
  const link = API && API !== 'demo' ? `${location.origin}${location.pathname}?api=${encodeURIComponent(API)}` : '';
  const welcome = S.data.policies.length ? '' : `<div class="card" style="margin-bottom:10px"><b>خوش آمدید 👋</b><div class="meta" style="display:block">شروع کار در دو قدم: ۱) فایل اکسل بیمه دی را بارگذاری کنید. ۲) کارمندان را در بخش «کاربران» بسازید و نام کاربری و رمزشان را بدهید.</div></div>`;
  $('#view').innerHTML = `${welcome}<div class="two">
    <div class="card"><h2 style="margin-top:0">ایمپورت خروجی بیمه دی</h2>
      <p class="meta">فایل اکسل را انتخاب کنید. پرونده‌های جدید اضافه و پرونده‌های موجود (با شماره بیمه‌نامه) به‌روز می‌شوند. اقدامات ثبت‌شده پاک نمی‌شود.</p>
      <input type="file" id="xl" accept=".xlsx,.xls">
      <div class="meta" id="impmsg" style="margin-top:8px">در حال حاضر ${faNum(S.data.policies.length)} پرونده ثبت است.</div></div>
    <div class="card"><h2 style="margin-top:0">لینک کارمندان</h2>
      ${link ? `<p class="meta">این لینک را برای کارمندان بفرستید. آدرس سرور داخلش است و فقط نام کاربری و رمز لازم دارند.</p><code class="url">${esc(link)}</code>
      <button class="btn sm" style="margin-top:8px" data-act="copyLink">کپی لینک</button>` : '<p class="meta">در حالت آزمایشی لینک وجود ندارد.</p>'}</div>
  </div>
  <h2>کاربران</h2>
  <div class="card" style="overflow:auto"><table><tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th>وضعیت</th><th></th></tr>
    ${S.data.users.map(u => `<tr><td>${esc(u.name)}</td><td dir="ltr" style="text-align:right">${esc(u.username)}</td><td>${u.role === 'admin' ? 'مدیر' : 'کارمند'}</td><td>${u.active ? 'فعال' : 'غیرفعال'}</td>
      <td class="acts"><button class="btn sm" data-user-pw="${esc(u.username)}">رمز جدید</button>${u.username !== S.user.username ? `<button class="btn sm" data-user-toggle="${esc(u.username)}">${u.active ? 'غیرفعال' : 'فعال'}</button>` : ''}</td></tr>`).join('')}</table></div>
  <div class="card" style="margin-top:10px"><b>افزودن کارمند</b>
    <div class="filters" style="margin-top:8px"><input id="nu_name" placeholder="نام نمایش"><input id="nu_un" dir="ltr" placeholder="نام کاربری لاتین"><input id="nu_pw" dir="ltr" placeholder="رمز (حداقل ۴)"><button class="btn pri" data-act="addUser">افزودن</button></div></div>`;
  $('#xl').addEventListener('change', onFile);
}

const HMAP = {
  'رشته': 'branch', 'کد داخلی بیمه نامه': 'internalCode', 'شماره بیمه نامه': 'policyNo', 'تاریخ انقضا': 'expiry',
  'نام بیمه گذار': 'insured', 'آدرس بیمه گذار': 'address', 'موبایل بیمه گذار': 'mobile', 'تلفن بیمه گذار': 'phone',
  'حق بیمه': 'premium', 'معرف': 'referrer', 'کد صدور': 'issuer', 'سرپرست واحد صدور': 'supervisor'
};
function fixPhone(s) {
  const d = normText(s).replace(/\D/g, '');
  if (/^9\d{9}$/.test(d)) return '0' + d;
  return d;
}
function parseSheet(rows) {
  const out = []; let bad = 0;
  rows.forEach(r => {
    const o = {};
    Object.keys(r).forEach(h => { const k = HMAP[normText(h)]; if (k) o[k] = r[h]; });
    const policyNo = normText(o.policyNo);
    if (!policyNo) return;
    let name = normText(o.insured), code = '';
    const m = /^(.*?)\s*کد\s*(\d+)\s*$/.exec(name);
    if (m) { name = m[1]; code = m[2]; }
    const j = Jal.parse(normText(o.expiry).replace(/\s/g, ''));
    if (j == null) bad++;
    out.push({
      policyNo, branch: normText(o.branch), internalCode: normText(o.internalCode), expiry: j == null ? normText(o.expiry) : Jal.format(j),
      insuredName: name, insuredCode: code, mobile: fixPhone(o.mobile), phone: fixPhone(o.phone), address: normText(o.address),
      premium: normText(o.premium).replace(/\D/g, ''), issuer: normText(o.issuer), supervisor: normText(o.supervisor), referrer: normText(o.referrer)
    });
  });
  return { rows: out, bad };
}
async function onFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $('#impmsg');
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    const { rows: parsed, bad } = parseSheet(rows);
    if (!parsed.length) { msg.textContent = 'ردیفی با «شماره بیمه نامه» پیدا نشد. فایل را بررسی کنید.'; return; }
    if (!confirm(`${parsed.length} پرونده خوانده شد${bad ? ` (${bad} ردیف تاریخ نامعتبر)` : ''}. ایمپورت شود؟`)) return;
    msg.textContent = 'در حال ارسال به سرور…';
    const r = await call('import', { rows: parsed });
    msg.textContent = `انجام شد: ${faNum(r.added)} جدید، ${faNum(r.updated)} به‌روزرسانی${r.autoRenewed ? '، ' + faNum(r.autoRenewed) + ' تمدید خودکار تشخیص داده شد' : ''}. مجموع ${faNum(r.total)}.`;
    await load();
  } catch (err) { msg.textContent = 'خطا: ' + err.message; }
  e.target.value = '';
}

/* ================= رویدادها ================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-mode],[data-tab],[data-range],[data-open],[data-go],[data-fu],[data-user-pw],[data-user-toggle]');
  if (!t) { if (e.target.classList.contains('ov')) closeModal(); return; }
  const d = t.dataset;
  if (d.tab) {
    if (d.tab === 'follow') { S.tab = 'list'; S.f.range = 'followup'; S.f.status = 'open'; }
    else { S.tab = d.tab; if (d.tab === 'list' && S.f.range === 'followup') S.f.range = 'all'; }
    S.limit = 60; return renderView();
  }
  if (d.mode) { S.authMode = d.mode; return renderLogin(); }
  if (d.range) { S.f.range = d.range; S.limit = 60; return renderView(); }
  if (d.go) { S.tab = 'list'; S.f.range = d.go; S.f.status = 'open'; S.f.assignee = S.scope === 'all' ? 'all' : 'mine'; S.limit = 60; return renderView(); }
  if (d.open) return openPolicy(d.open);
  if (d.fu) { $('#a_fu').value = Jal.format(S.today + Number(d.fu)); return; }
  if (d.userPw) {
    const pw = prompt('رمز جدید برای ' + d.userPw);
    if (pw) try { await call('saveUser', { username: d.userPw, password: pw }); toast('رمز تغییر کرد'); } catch (er) { toast(er.message); }
    return;
  }
  if (d.userToggle) {
    const u = S.data.users.find(x => x.username === d.userToggle);
    try { const r = await call('saveUser', { username: u.username, active: !u.active }); S.data.users = r.users; enrich(); renderAdmin(); } catch (er) { toast(er.message); }
    return;
  }
  switch (d.act) {
    case 'saveApi': { const v = $('#api').value.trim(); if (!/^https:\/\//.test(v)) return $('#err').textContent = 'آدرس باید با https شروع شود'; API = v; ls.set('api', v); return renderLogin(); }
    case 'demo': e.preventDefault(); API = 'demo'; ls.set('api', 'demo'); return renderLogin();
    case 'resetApi': e.preventDefault(); API = ''; ls.del('api'); return renderLogin();
    case 'login': case 'register': return doAuth(d.act);
    case 'logout': return logout();
    case 'refresh': try { await load(); renderView(); toast('بروز شد'); } catch (er) { toast(er.message); } return;
    case 'more': S.limit += 60; return renderList();
    case 'close': return closeModal();
    case 'saveAction': return saveAction(t);
    case 'assign': return assign(t.closest('.ov').dataset.no, $('#asg').value);
    case 'take': return assign(t.closest('.ov').dataset.no, S.user.username);
    case 'release': return assign(t.closest('.ov').dataset.no, '');
    case 'copyLink': try { await navigator.clipboard.writeText(t.previousElementSibling.textContent); toast('کپی شد'); } catch { toast('کپی نشد'); } return;
    case 'addUser': {
      try {
        const r = await call('saveUser', { username: $('#nu_un').value.trim(), name: $('#nu_name').value.trim(), password: $('#nu_pw').value, role: 'employee' });
        S.data.users = r.users; enrich(); toast('کارمند اضافه شد'); renderAdmin();
      } catch (er) { toast(er.message); }
    }
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.f.q = e.target.value; S.limit = 60; renderList(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.f) { S.f[t.dataset.f] = t.value; S.limit = 60; renderList(); }
  if (t.dataset.scope !== undefined) { S.scope = t.value; renderDash(); }
});

/* ================= شروع ================= */
async function boot() {
  const qp = new URLSearchParams(location.search).get('api');
  if (qp && /^https:\/\//.test(qp) && qp !== API) {
    API = qp; ls.set('api', qp); TOKEN = ''; ls.del('token');
  }
  if (qp) history.replaceState(null, '', location.pathname);
  if (!API || !TOKEN && API !== 'demo') return renderLogin();
  if (API === 'demo' && !ls.get('demo_me')) return renderLogin();
  $('#app').innerHTML = '<div class="empty">در حال بارگذاری…</div>';
  try {
    await load();
    S.scope = '';
    if (S.fresh) { S.tab = 'admin'; S.fresh = false; }
    renderShell();
  } catch (e) {
    if (TOKEN || API === 'demo') renderLogin(e.message);
  }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
