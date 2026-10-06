# راه‌اندازی سرور (VPS لینوکس ایرانی)

برنامه بدون هیچ بسته npm کار می‌کند. فقط **Node.js ≥ 22.13** و یک فایل اجرایی **Caddy** لازم است.
چون سرورهای ایرانی گاهی به اینترنت خارج دسترسی ندارند، همه‌چیز از **سیستم خودتان** آپلود می‌شود.

فرض: Ubuntu 22.04/24.04، آدرس سرور `IP`، دامنه `bime.example.ir`.

## ۱. دسترسی با کلید SSH (روی سیستم خودتان، PowerShell)

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\bime_ed25519
type $env:USERPROFILE\.ssh\bime_ed25519.pub | ssh root@IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

در مرحله دوم رمز root را خودتان تایپ می‌کنید. رمز را برای هیچ‌کس (و هیچ ابزاری) نفرستید.
بعد از آن با `ssh -i $env:USERPROFILE\.ssh\bime_ed25519 root@IP` وارد می‌شوید.

## ۲. تنظیم اولیه سرور (روی سرور، با root)

```bash
adduser --disabled-password --gecos "" deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh
useradd --system --home /opt/bime-dey --shell /usr/sbin/nologin bime
mkdir -p /opt/bime-dey/data /opt/node && chown -R deploy:bime /opt/bime-dey && chmod 775 /opt/bime-dey && chown bime:bime /opt/bime-dey/data
# deploy فقط اجازه ری‌استارت همین سرویس را دارد:
echo 'deploy ALL=(root) NOPASSWD: /bin/systemctl restart bime-dey, /bin/systemctl status bime-dey' > /etc/sudoers.d/bime-deploy
# فایروال
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

بعد از اینکه ورود با کاربر `deploy` را امتحان کردید، ورود با رمز را ببندید:
`sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && systemctl restart ssh`

## ۳. Node.js و Caddy (آپلود از سیستم خودتان)

۱. از [nodejs.org/dist/latest-v22.x](https://nodejs.org/dist/latest-v22.x/) فایل `node-v22.*-linux-x64.tar.xz` را دانلود کنید.
۲. از [Caddy releases](https://github.com/caddyserver/caddy/releases) فایل `caddy_*_linux_amd64.tar.gz` را دانلود کنید.

```powershell
scp -i $env:USERPROFILE\.ssh\bime_ed25519 node-v22.*-linux-x64.tar.xz caddy_*_linux_amd64.tar.gz root@IP:/tmp/
```

روی سرور (root):

```bash
tar -xJf /tmp/node-v22.*-linux-x64.tar.xz -C /opt/node --strip-components=1
/opt/node/bin/node --version        # باید ۲۲.۱۳ یا بالاتر باشد
tar -xzf /tmp/caddy_*_linux_amd64.tar.gz -C /usr/local/bin caddy && chmod +x /usr/local/bin/caddy
```

## ۴. سرویس‌ها

از سیستم خودتان در پوشه پروژه:

```powershell
scp -i $env:USERPROFILE\.ssh\bime_ed25519 deploy/bime-dey.service root@IP:/etc/systemd/system/
scp -i $env:USERPROFILE\.ssh\bime_ed25519 deploy/Caddyfile.example root@IP:/etc/caddy-Caddyfile
```

روی سرور (root): `/etc/caddy-Caddyfile` را ویرایش کنید (دامنه خودتان را بنویسید)، بعد:

```bash
mkdir -p /etc/caddy && mv /etc/caddy-Caddyfile /etc/caddy/Caddyfile
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network.target
[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE
Environment=XDG_DATA_HOME=/var/lib/caddy
[Install]
WantedBy=multi-user.target
EOF
mkdir -p /var/lib/caddy
systemctl daemon-reload && systemctl enable bime-dey caddy
```

## ۵. DNS

در پنل ثبت‌کننده دامنه، یک رکورد **A** بسازید: نام `bime` (یا `@`) به IP سرور.
چند دقیقه تا چند ساعت طول می‌کشد. با `nslookup bime.example.ir` بررسی کنید.

## ۶. اولین انتشار

از سیستم خودتان (Git Bash) در ریشه پروژه:

```bash
./deploy/deploy.sh deploy@IP ~/.ssh/bime_ed25519
```

بعد روی سرور: `systemctl start caddy`. با باز کردن `https://bime.example.ir` صفحه ورود می‌آید.
اگر گواهی SSL نگرفت: `journalctl -u caddy -n 50`. (اگر Let's Encrypt از ایران بسته بود، گزینه گواهی دستی در `Caddyfile.example` است.)

## ۷. پشتیبان‌گیری

روی سرور، با کاربر `bime`: `crontab -u bime -e` و این خط:

```
0 3 * * * cd /opt/bime-dey && /opt/node/bin/node backup.js >> data/backup.log 2>&1
```

۱۴ نسخه آخر در `data/backups` می‌ماند. گاهی یک نسخه را روی سیستم خودتان کپی کنید:
`scp deploy@IP:/opt/bime-dey/data/backups/bime-*.db .`

## ۸. انتقال داده از Google Sheet (اختیاری)

۱. در Google Sheet، برای هر شیت `File > Download > CSV` بزنید و در یک پوشه بگذارید با نام‌های `Agencies.csv`, `Users.csv`, `Policies.csv`, `Actions.csv`.
۲. پوشه را روی سرور بگذارید و اجرا کنید (با کاربر `bime`):

```bash
sudo -u bime env DB_PATH=/opt/bime-dey/data/bime.db /opt/node/bin/node /opt/bime-dey/migrate-sheet.js /tmp/csv
```

اجرای دوباره بی‌خطر است. رمزهای قدیمی همان‌طور کار می‌کنند و بعد از اولین ورود هر کاربر به هش جدید ارتقا می‌یابند.

## ۹. بروزرسانی بعدی

فقط همان دستور مرحله ۶: `./deploy/deploy.sh deploy@IP ~/.ssh/bime_ed25519`.
دیتابیس لمس نمی‌شود.

## ۱۰. چند پروژه / چند دامنه

برای هر پروژه دیگر: یک پوشه `/opt/<name>`، یک سرویس systemd با پورت متفاوت، و یک بلوک دیگر در `Caddyfile`.
بعد از ویرایش Caddyfile: `systemctl reload caddy`.

## ثبت‌نام آزاد و کد ثبت‌نام

به‌صورت پیش‌فرض هر کسی با لینک می‌تواند نمایندگی جدید بسازد. برای محدود کردن، در `/etc/systemd/system/bime-dey.service`
خط `Environment=REGISTER_CODE=...` را فعال کنید و `systemctl daemon-reload && systemctl restart bime-dey` بزنید.

## عیب‌یابی

| مشکل | بررسی |
|---|---|
| صفحه باز نمی‌شود | `systemctl status bime-dey caddy` و `ufw status` |
| خطای SSL | DNS درست است؟ `journalctl -u caddy -n 50` |
| خطای سرور | `journalctl -u bime-dey -n 50` |
| سالم بودن سرور | `curl http://127.0.0.1:3000/health` روی خود سرور |
