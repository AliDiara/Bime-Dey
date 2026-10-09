# Bime Dey renewal tracker (پیگیری تمدید بیمه دی)

Freelance client project. A Persian PWA for Dey Insurance agents and their staff: import the Dey Insurance Excel export, log call actions, and follow due renewals on a dashboard. It has multi-agency accounts with role-based login and detects renewals automatically on import.

Last updated: 2026-10-09 (handover note written from Claude Code memory).

## Working rules

- Reply to the user in Persian. UI is Persian, RTL, with Jalali dates.
- The repo is on GitHub (`AliDiara/Bime-Dey`). Never commit `sample/` (real customer data), Excel files, `server/data/`, database files, keys or `.env` files.
- Ask before deploy, `git push`, or anything that touches production data.
- Re-import merges by policy number and must never delete earlier actions.
- Staff act only on unassigned files or files assigned to them. Admin acts on all.
- Passwords are stored with scrypt (legacy SHA-256 hashes from the old Sheet are upgraded on first login).
- Roles: `super` (platform owner, no customer data, panel tab "پلتفرم"), `admin` (agency manager), `employee`. Accounts created or reset by someone else must change the password at first login (`mustChange`).

## Layout

- `app/`: the app. Plain HTML/JS, no build step: `index.html`, `app.js`, `jalali.js`, `styles.css`, `sw.js` (service worker), `manifest.json`, `check.html` (connection diagnostics), `icons/`.
- `server/`: self-hosted server. Node.js >= 22.13 with the built-in SQLite and no npm dependencies. Same API as the old Apps Script backend; it also serves the app files. `server.js`, `backup.js`, `migrate-sheet.js`, `admin.js` (CLI: stats, users, reset, create-super, set-active), `test.js`.
- `deploy/`: `SERVER-SETUP.md` (full guide), `deploy.sh`, `bime-dey.service`, `Caddyfile.example`.
- `backend/Code.gs`: the previous Google Apps Script backend (still works, used for quick tests without a server).
- `sample/`: sample Excel export (gitignored).

## Commands

```
cd server && node --test test.js    # tests
cd server && node server.js         # local run
```

`sw.js` serves the app cache-first. When you change files in `app/`, bump `CACHE` in `sw.js` (now `bime-dey-v3`), otherwise users keep the old version.

## Production

- Live since 2026-10-08 at https://bimenamaapp.ir (www redirects to the root domain).
- VPS: Sefr-o-Yek (my.0-1.ir, Virtualizor panel), IP `185.18.214.124`, Ubuntu 24.04, 1 vCPU, 2 GB RAM, 15 GB SSD.
- DNS: domains at Host Iran, zone on ns1/ns2.hostiran.net.
- SSH: key `~/.ssh/bime_ed25519` for `root` and `deploy`. Password login is disabled. ufw allows 22, 80, 443.
- Deploy (from the project root): `./deploy/deploy.sh deploy@185.18.214.124 ~/.ssh/bime_ed25519`. It replaces code only and never touches the data folder.
- Node in `/opt/node`, Caddy `/usr/local/bin/caddy`, config `/etc/caddy/Caddyfile`. Daily backup cron for user `bime` at 03:00.
- The same server hosts the Namahoosh site and lead API (https://namahoosh.ir, project `D:\projects\instagram-namahoosh`). Do not break them when you edit the Caddyfile.
- The user's PC runs Surfshark VPN. It must be off (or bypass this IP), otherwise SSH hangs.

## Status on 2026-10-09

In production. The working tree is clean. No open task is recorded; ask the user what is next.
