#!/usr/bin/env bash
# آپلود نسخه جدید برنامه و سرور به VPS (بدون نیاز به اینترنت روی سرور). از ریشه پروژه اجرا شود:
#   ./deploy/deploy.sh deploy@IP_SERVER [مسیر-کلید-ssh]
# فقط کد را جایگزین می‌کند؛ پوشه data (دیتابیس) را لمس نمی‌کند.
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [ssh-key]}"
KEY="${2:-}"
SSH_OPTS=()
[ -n "$KEY" ] && SSH_OPTS=(-i "$KEY")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/public"
cp "$ROOT"/server/{server.js,backup.js,migrate-sheet.js,package.json} "$STAGE/"
cp -r "$ROOT"/app/. "$STAGE/public/"
rm -f "$STAGE/public/_t.xlsx"

echo "آپلود به $HOST ..."
tar -C "$STAGE" -czf - . | ssh "${SSH_OPTS[@]}" "$HOST" '
  set -e
  mkdir -p /opt/bime-dey/incoming && rm -rf /opt/bime-dey/incoming/*
  tar -C /opt/bime-dey/incoming -xzf -
  cd /opt/bime-dey/incoming
  cp server.js backup.js migrate-sheet.js package.json /opt/bime-dey/
  rm -rf /opt/bime-dey/public && mv public /opt/bime-dey/public
  cd /opt/bime-dey && rm -rf incoming
  sudo systemctl restart bime-dey
  sleep 1
  curl -fsS http://127.0.0.1:3000/health && echo " سرور بالا آمد"
'
