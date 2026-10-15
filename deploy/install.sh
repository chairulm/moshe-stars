#!/usr/bin/env bash
# Idempotent installer for moshe-stars (first install AND every update).
# Usage (from inside the repo):
#   sudo bash deploy/install.sh --domain moshe.ch-41.com --email you@example.com
#   sudo bash deploy/install.sh                 # re-run with remembered domain/email
#   sudo bash deploy/install.sh --no-domain     # HTTP on the server IP only
# Options: --force (ignore precheck FAILs)
set -euo pipefail

APP=moshe-stars
ROOT=/opt/$APP
WWW=$ROOT/www
CONF_DIR=/etc/$APP
CONF=$CONF_DIR/deploy.conf
SITE=/etc/nginx/sites-available/$APP
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -f "$REPO/index.html" ] && [ -f "$REPO/app.js" ] || { echo "Run from inside the $APP repo."; exit 1; }

DOMAIN=""; EMAIL=""; NODOMAIN=0; FORCE=0
[ -f "$CONF" ] && . "$CONF"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-domain) NODOMAIN=1; DOMAIN=""; EMAIL=""; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

step() { printf '\n[%3s%%] %s\n' "$1" "$2"; }
quiet() { "$@" >/tmp/$APP-install.log 2>&1 || { echo "  failed: $*"; tail -20 /tmp/$APP-install.log; exit 1; }; }

# ---- 0. precheck (quick) ----
step 0 "Pre-check"
set +e
bash "$REPO/deploy/precheck.sh" --quick ${DOMAIN:+--domain "$DOMAIN"} > /tmp/$APP-precheck.log 2>&1
PRC=$?
set -e
sed -n '/== Verdict/,$p' /tmp/$APP-precheck.log
if [ $PRC -eq 2 ] && [ $FORCE -eq 0 ]; then
  echo "Pre-check FAILED. Fix the FAIL lines above (full log: /tmp/$APP-precheck.log) or re-run with --force."
  exit 2
fi

# ---- 1. packages ----
step 10 "Packages"
NEED=()
for p in nginx rsync ufw fail2ban certbot python3-certbot-nginx curl; do dpkg -s "$p" >/dev/null 2>&1 || NEED+=("$p"); done
if [ ${#NEED[@]} -gt 0 ]; then
  echo "  installing: ${NEED[*]}"
  quiet apt-get update -q
  DEBIAN_FRONTEND=noninteractive quiet apt-get install -y -q "${NEED[@]}"
else echo "  all present"; fi

# ---- 2. files ----
step 30 "Copying app to $WWW"
id -u $APP >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $APP
mkdir -p "$WWW" "$ROOT/deploy" "$CONF_DIR"
rsync -a --delete \
  --exclude '.git' --exclude '.github' --exclude 'deploy' --exclude 'README.md' \
  --exclude 'firebase.json' --exclude 'firestore.rules' --exclude '*.bundle' \
  "$REPO/" "$WWW/"
rsync -a --delete "$REPO/deploy/" "$ROOT/deploy/"
# stamp the service-worker cache with the commit so phones fetch the new version
REV=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || date +%s)
sed -i "s/^const VERSION = \".*\";/const VERSION = \"$REV\";/" "$WWW/sw.js"
chown -R root:root "$ROOT"; find "$WWW" -type d -exec chmod 755 {} +; find "$WWW" -type f -exec chmod 644 {} +
echo "  revision $REV"
if grep -q 'PASTE_' "$WWW/firebase-config.js"; then
  echo "  WARNING: firebase-config.js still has PASTE_ placeholders — the app will load but login won't work until you fill it in."
fi

# ---- 3. nginx ----
step 50 "nginx site"
NAME="${DOMAIN:-$(curl -4 -s -m 8 ifconfig.me || echo _)}"
cat > /etc/nginx/conf.d/$APP-ratelimit.conf <<'NGX1'
limit_req_zone $binary_remote_addr zone=moshe_stars:10m rate=20r/s;
NGX1
cat > "$SITE" <<NGX2
# managed by $APP/deploy/install.sh
server {
    listen 80;
    listen [::]:80;
    server_name $NAME;
    root $WWW;
    index index.html;
    server_tokens off;

    gzip on;
    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header X-Frame-Options DENY always;

    limit_req zone=moshe_stars burst=60 nodelay;

    location = /sw.js { add_header Cache-Control "no-cache"; add_header X-Content-Type-Options nosniff always; }
    location = /index.html { add_header Cache-Control "no-cache"; add_header X-Content-Type-Options nosniff always; }
    location = /firebase-config.js { add_header Cache-Control "no-cache"; add_header X-Content-Type-Options nosniff always; }
    location = /manifest.webmanifest { default_type application/manifest+json; }
    location /vendor/ { expires 30d; add_header X-Content-Type-Options nosniff always; }
    location / { try_files \$uri \$uri/ /index.html; }
}
NGX2
ln -sf "$SITE" /etc/nginx/sites-enabled/$APP
nginx -t >/tmp/$APP-nginx.log 2>&1 || { cat /tmp/$APP-nginx.log; exit 1; }
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
echo "  serving $NAME"

# ---- 4. firewall + fail2ban ----
step 65 "Firewall"
SSHP=$( { sshd -T 2>/dev/null | awk '/^port /{print $2}'; ss -tlnpH 2>/dev/null | grep -E '"sshd"|ssh.socket' | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sed 's/.*://'; } | grep -E '^[0-9]+$' | sort -un | grep -v '^6010$' || true)
SSH_GUESS=0; [ -z "$SSHP" ] && { SSHP=22; SSH_GUESS=1; }
for p in $SSHP; do ufw allow "$p/tcp" comment "$APP ssh" >/dev/null; done
ufw allow 80/tcp comment "$APP http" >/dev/null
ufw allow 443/tcp comment "$APP https" >/dev/null
# remove stale ssh rules this installer created for ports no longer in use
ufw status numbered | awk -v tag="# $APP ssh" 'index($0,tag){match($0,/\[ *[0-9]+\]/); n=substr($0,RSTART+1,RLENGTH-2); gsub(/ /,"",n); split(substr($0,RSTART+RLENGTH),a," "); split(a[1],b,"/"); print n, b[1]}' \
  | sort -rn | while read -r num port; do
      echo "$SSHP" | grep -qx "$port" || yes | ufw delete "$num" >/dev/null
    done || true
if ! ufw status | grep -q "Status: active"; then
  if [ $SSH_GUESS -eq 1 ]; then echo "  SSH port not detected — NOT enabling ufw to avoid locking you out. Enable it yourself after checking."
  else yes | ufw enable >/dev/null; fi
fi
echo "  ufw: SSH ${SSHP//$'\n'/,} + 80 + 443 allowed"
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# ---- 5. HTTPS ----
step 80 "HTTPS"
if [ -n "$DOMAIN" ]; then
  [ -n "$EMAIL" ] || { echo "  --email is required with --domain"; exit 1; }
  quiet certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect --keep-until-expiring -n
  echo "  certificate OK for $DOMAIN"
  URL="https://$DOMAIN"
else
  echo "  skipped (no domain). Note: login and install-to-home-screen need HTTPS."
  URL="http://$NAME"
fi

cat > "$CONF" <<CONF
DOMAIN="$DOMAIN"
EMAIL="$EMAIL"
CONF

step 100 "Done"
cat <<DONE
  App:     $URL
  Logs:    journalctl -u nginx -f   (access: tail -f /var/log/nginx/access.log)
  Check:   sudo bash $ROOT/deploy/check.sh
  Firebase: add "${DOMAIN:-$NAME}" under Authentication → Settings → Authorized domains.
DONE
