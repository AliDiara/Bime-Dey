'use strict';
/**
 * ابزار مدیریت از خط فرمان روی خود سرور (برای مالک پلتفرم). رمز را هیچ‌وقت تایپ نمی‌کنید؛
 * رمز موقت تصادفی ساخته و فقط یک بار نمایش داده می‌شود و کاربر در اولین ورود آن را عوض می‌کند.
 *
 *   node admin.js stats                      آمار کلی و فهرست نمایندگی‌ها
 *   node admin.js users [agencyId]           فهرست کاربران
 *   node admin.js reset <username>           رمز موقت جدید برای یک کاربر
 *   node admin.js create-super <username>    ساخت حساب مالک پلتفرم (پنل مدیریت در سایت)
 *   node admin.js set-active <username> 0|1  غیرفعال/فعال کردن کاربر
 *
 * مسیر دیتابیس: متغیر DB_PATH (مثل سرویس). مثال روی سرور:
 *   sudo -u bime env DB_PATH=/opt/bime-dey/data/bime.db /opt/node/bin/node /opt/bime-dey/admin.js stats
 */
const { db, newPassword, tempPassword, audit } = require('./server.js');

const [cmd, a, b] = process.argv.slice(2);
const norm = u => String(u || '').trim().toLowerCase();
const userOf = name => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(norm(name));
  if (!u) { console.error('کاربر پیدا نشد:', name); process.exit(1); }
  return u;
};
const show = rows => console.table(rows.map(r => ({ ...r })));

switch (cmd) {
  case 'stats': {
    const t = db.prepare(`SELECT
      (SELECT COUNT(*) FROM agencies) AS agencies, (SELECT COUNT(*) FROM users WHERE role <> 'super') AS users,
      (SELECT COUNT(*) FROM policies) AS policies, (SELECT COUNT(*) FROM actions) AS actions`).get();
    console.log('مجموع:', { ...t });
    show(db.prepare(`SELECT a.agencyId, a.name, a.createdAt,
      (SELECT COUNT(*) FROM users u WHERE u.agencyId = a.agencyId) AS users,
      (SELECT COUNT(*) FROM policies p WHERE p.agencyId = a.agencyId) AS policies,
      (SELECT COALESCE(MAX(u.lastLogin), '') FROM users u WHERE u.agencyId = a.agencyId) AS lastLogin
      FROM agencies a ORDER BY a.createdAt`).all());
    break;
  }
  case 'users':
    show(db.prepare(`SELECT u.username, u.name, u.role, u.active, u.agencyId, COALESCE(a.name, '') AS agency, u.lastLogin
      FROM users u LEFT JOIN agencies a ON a.agencyId = u.agencyId
      ${a ? 'WHERE u.agencyId = ?' : ''} ORDER BY a.createdAt, u.rowid`).all(...(a ? [a] : [])));
    break;
  case 'reset': {
    const u = userOf(a);
    const temp = tempPassword(), p = newPassword(temp);
    db.prepare('UPDATE users SET algo = ?, salt = ?, hash = ?, mustChange = 1 WHERE username = ?').run(p.algo, p.salt, p.hash, u.username);
    db.prepare('DELETE FROM sessions WHERE username = ?').run(u.username);
    audit('cli', 'reset-password', u.username);
    console.log(`رمز موقت ${u.username}:  ${temp}\n(فقط همین یک بار نمایش داده می‌شود؛ کاربر در اولین ورود باید آن را عوض کند)`);
    break;
  }
  case 'create-super': {
    const username = norm(a);
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) { console.error('نام کاربری باید لاتین و ۳ تا ۳۰ کاراکتر باشد'); process.exit(1); }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { console.error('این نام کاربری وجود دارد'); process.exit(1); }
    const temp = tempPassword(), p = newPassword(temp);
    db.prepare("INSERT INTO users (username, name, role, algo, salt, hash, active, agencyId, mustChange) VALUES (?, ?, 'super', ?, ?, ?, 1, 'platform', 1)")
      .run(username, 'مدیر پلتفرم', p.algo, p.salt, p.hash);
    audit('cli', 'create-super', username);
    console.log(`حساب مالک ساخته شد.\nنام کاربری: ${username}\nرمز موقت:  ${temp}\n(در صفحه ورود گزینه «مدیر» را بزنید؛ در اولین ورود رمز را عوض کنید)`);
    break;
  }
  case 'set-active': {
    const u = userOf(a);
    const on = b === '1';
    db.prepare('UPDATE users SET active = ? WHERE username = ?').run(on ? 1 : 0, u.username);
    if (!on) db.prepare('DELETE FROM sessions WHERE username = ?').run(u.username);
    audit('cli', on ? 'activate' : 'deactivate', u.username);
    console.log(u.username, on ? 'فعال شد' : 'غیرفعال شد');
    break;
  }
  default:
    console.log('دستورها: stats | users [agencyId] | reset <username> | create-super <username> | set-active <username> 0|1');
}
db.close();
process.exit(0);
