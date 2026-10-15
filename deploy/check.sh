#!/usr/bin/env bash
# Post-deploy health report for moshe-stars. Read-only.
# Usage: sudo bash /opt/moshe-stars/deploy/check.sh
set -uo pipefail
APP=moshe-stars
WWW=/opt/$APP/www
CONF=/etc/$APP/deploy.conf
DOMAIN=""; [ -f "$CONF" ] && . "$CONF"
ok()   { echo "  [OK]   $*"; }
warn() { echo "  [WARN] $*"; W=$((W+1)); }
bad()  { echo "  [FAIL] $*"; F=$((F+1)); }
W=0; F=0

echo "== Services =="
systemctl is-active --quiet nginx && ok "nginx active" || bad "nginx not active"
systemctl is-active --quiet fail2ban && ok "fail2ban active" || warn "fail2ban not active"
ss -tlnH | awk '{print $4}' | grep -qE ':80$' && ok "listening :80" || bad "nothing on :80"
[ -n "$DOMAIN" ] && { ss -tlnH | awk '{print $4}' | grep -qE ':443$' && ok "listening :443" || bad "nothing on :443"; }
echo "  ufw: $(ufw status 2>/dev/null | head -1)"

echo "== Files =="
[ -f "$WWW/index.html" ] && ok "app files in $WWW ($(du -sh "$WWW" | cut -f1))" || bad "missing $WWW/index.html"
echo "  revision: $(grep -oP 'const VERSION = "\K[^"]+' "$WWW/sw.js" 2>/dev/null)"
grep -q 'PASTE_' "$WWW/firebase-config.js" 2>/dev/null && bad "firebase-config.js still has PASTE_ placeholders (login won't work)" || ok "firebase-config.js filled in"

echo "== HTTP =="
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"; }
H=${DOMAIN:-localhost}
C=$(code -H "Host: $H" http://127.0.0.1/); case "$C" in 200|301|302|401) ok "http://$H → $C";; *) bad "http://$H → $C";; esac
if [ -n "$DOMAIN" ]; then
  C=$(code "https://$DOMAIN/"); case "$C" in 200) ok "https://$DOMAIN → $C";; *) bad "https://$DOMAIN → $C";; esac
  C=$(code "https://$DOMAIN/vendor/firebase/firebase-app.js"); [ "$C" = 200 ] && ok "Firebase SDK served" || bad "Firebase SDK → $C"
  C=$(code "https://$DOMAIN/.git/config"); [ "$C" != 200 ] && ok ".git not exposed ($C)" || bad ".git is exposed"
  EXP=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$EXP" ]; then
    DAYS=$(( ( $(date -d "$EXP" +%s) - $(date +%s) ) / 86400 ))
    [ "$DAYS" -gt 14 ] && ok "certificate valid $DAYS more days" || warn "certificate expires in $DAYS days"
  else bad "could not read certificate"; fi
fi
C=$(code https://firestore.googleapis.com/); [ "$C" != 000 ] && ok "server can reach Firebase ($C)" || warn "server can't reach firestore.googleapis.com (only matters for testing; phones talk to Firebase directly)"

echo "== Resources =="
read -r L1 L5 L15 _ < /proc/loadavg
echo "  load $L1 / $L5 / $L15 on $(nproc) cores · RAM available $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) MB · disk free $(df -BG --output=avail /opt | tail -1 | tr -d ' ')"
M=$(systemctl show -p MemoryCurrent --value nginx 2>/dev/null); [ -n "$M" ] && [ "$M" != "[not set]" ] && echo "  nginx (all sites): $((M/1024/1024)) MB RAM"
echo "  requests today: $(grep -c "$(date +%d/%b/%Y)" /var/log/nginx/access.log 2>/dev/null || echo 0) (all sites)"

echo "== Recent errors (2h) =="
journalctl -u nginx -p warning --since -2h --no-pager -q 2>/dev/null | tail -5 | sed 's/^/  /'
tail -n 200 /var/log/nginx/error.log 2>/dev/null | grep "$(date +%Y/%m/%d)" | grep -i "$APP\|moshe" | tail -5 | sed 's/^/  /'

echo
echo "== Result: $F fail, $W warn =="
[ $F -eq 0 ]
