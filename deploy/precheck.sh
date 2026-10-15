#!/usr/bin/env bash
# Read-only resource + readiness check for moshe-stars. Installs and changes NOTHING.
# Usage: sudo bash deploy/precheck.sh --domain moshe.ch-41.com [--quick]
# Exit: 0 = ready, 1 = warnings, 2 = not ready.
set -uo pipefail

# App minimums. moshe-stars is a static PWA served by nginx; login and data live in
# Firebase, so the server only serves ~1 MB of files. Numbers are a safe floor, not a need.
NEED_CPU=1
NEED_RAM_MB=128
NEED_DISK_GB=1
NEED_GPU=0
APP=moshe-stars

DOMAIN=""; QUICK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) shift 2 ;;            # accepted for compatibility; static app has no port
    --quick) QUICK=1; shift ;;
    *) shift ;;
  esac
done

FAILS=(); WARNS=()
ok()   { echo "  [OK]   $*"; }
warn() { echo "  [WARN] $*"; WARNS+=("$*"); }
fail() { echo "  [FAIL] $*"; FAILS+=("$*"); }
info() { echo "  [INFO] $*"; }
hdr()  { echo; echo "== $* =="; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 2; }

# ---------------- A. resources ----------------
hdr "CPU"
CORES=$(nproc)
MODEL=$(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo | sed 's/^ *//')
read -r L1 L5 L15 _ < /proc/loadavg
info "$CORES cores · ${MODEL:-unknown} · load $L1 / $L5 / $L15"
if [ "$CORES" -lt "$NEED_CPU" ]; then fail "CPU cores $CORES < $NEED_CPU"; else ok "cores $CORES ≥ $NEED_CPU"; fi
awk -v l="$L5" -v c="$CORES" 'BEGIN{exit !(l > 0.7*c)}' && warn "5-min load $L5 is above 70% of $CORES cores"
if [ $QUICK -eq 0 ] && have vmstat; then
  read -r IDLE STEAL < <(vmstat 1 3 | tail -1 | awk '{print $15, $17}')
  info "CPU idle ${IDLE}% · steal ${STEAL:-0}%"
  [ "${STEAL:-0}" -gt 10 ] && warn "CPU steal ${STEAL}% (oversold VPS?)"
fi

hdr "Memory"
TOT=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
SWT=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
SWF=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
info "total ${TOT} MB · available ${AVAIL} MB · swap ${SWT} MB (used $((SWT-SWF)) MB)"
if [ "$AVAIL" -lt "$NEED_RAM_MB" ]; then fail "available RAM ${AVAIL} MB < ${NEED_RAM_MB} MB"; else ok "available RAM ${AVAIL} MB ≥ ${NEED_RAM_MB} MB"; fi
[ "$SWT" -eq 0 ] && [ "$TOT" -lt 4096 ] && warn "no swap on a ${TOT} MB server"

hdr "Disk"
for p in / /opt; do
  [ -d "$p" ] || continue
  read -r FREE PCT FST < <(df -BG --output=avail,pcent,fstype "$p" | tail -1 | awk '{gsub("G","",$1); gsub("%","",$2); print $1, $2, $3}')
  IFREE=$(df -i --output=iavail "$p" | tail -1 | tr -d ' ')
  info "$p: ${FREE} GB free (${PCT}% used, $FST) · ${IFREE} inodes free"
done
FREE=$(df -BG --output=avail /opt 2>/dev/null | tail -1 | tr -dc 0-9); FREE=${FREE:-0}
SIZE=$(df -BG --output=size /opt | tail -1 | tr -dc 0-9)
if [ "$FREE" -lt "$NEED_DISK_GB" ]; then fail "disk free ${FREE} GB < ${NEED_DISK_GB} GB"; else ok "disk free ${FREE} GB ≥ ${NEED_DISK_GB} GB"; fi
[ "$SIZE" -gt 0 ] && [ $(( (FREE - NEED_DISK_GB) * 100 / SIZE )) -lt 15 ] && warn "disk will be under 15% free after install"
if [ $QUICK -eq 0 ]; then
  T=$(mktemp -p /opt .ddtest.XXXX)
  SPEED=$(dd if=/dev/zero of="$T" bs=1M count=256 oflag=direct 2>&1 | awk -F, '/copied/{print $NF}' | sed 's/^ *//')
  rm -f "$T"; info "disk write speed: ${SPEED:-unknown}"
  echo "$SPEED" | grep -qE '^[0-9.]+ (kB|MB)/s' && awk -v s="${SPEED%% *}" -v u="${SPEED##* }" 'BEGIN{exit !(u=="kB/s" || s<50)}' && warn "disk write below 50 MB/s"
fi

if [ $QUICK -eq 0 ]; then
  hdr "Top processes"
  echo "  by CPU:"; ps aux --sort=-%cpu | awk 'NR>1&&NR<=6{printf "    %5s%%  %s\n",$3,$11}'
  echo "  by RAM:"; ps aux --sort=-%mem | awk 'NR>1&&NR<=6{printf "    %5s%%  %s\n",$4,$11}'

  hdr "Existing workloads"
  systemctl list-units --type=service --state=running --no-legend 2>/dev/null \
    | awk '{print $1}' | grep -E 'nginx|apache2|docker|postgres|mysql|mariadb|redis|uvicorn|gunicorn|node|python' | sed 's/^/    /' || true
  [ -d /etc/nginx/sites-enabled ] && { echo "  nginx sites enabled:"; ls /etc/nginx/sites-enabled | sed 's/^/    /'; }
  have docker && docker ps --format '    {{.Names}} ({{.Image}})' 2>/dev/null || true
  have psql && sudo -u postgres psql -Atc "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate" 2>/dev/null | sed 's/^/    db /' || true

  hdr "Network"
  info "ulimit -n $(ulimit -n)"; [ "$(ulimit -n)" -lt 4096 ] && warn "ulimit -n below 4096"
  DL=$(curl -s -o /dev/null -m 15 -w '%{speed_download}' https://speed.cloudflare.com/__down?bytes=10000000 || echo 0)
  info "download ~$(awk -v b="$DL" 'BEGIN{printf "%.1f", b*8/1e6}') Mbps"
fi

hdr "GPU / virtualisation"
if have lspci && lspci | grep -qi nvidia; then info "NVIDIA GPU present"; else info "no GPU (not needed)"; fi
[ "$NEED_GPU" -eq 1 ] && ! (have lspci && lspci | grep -qi nvidia) && fail "GPU required but none found"
VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown); info "virtualisation: $VIRT"
case "$VIRT" in openvz|lxc|lxc-libvirt) warn "container virtualisation ($VIRT) may block ufw";; esac

# ---------------- B. readiness ----------------
hdr "OS"
. /etc/os-release 2>/dev/null || true
info "${PRETTY_NAME:-unknown} · $(uname -m)"
case "${VERSION_ID:-}" in 22.04|24.04) ok "Ubuntu ${VERSION_ID}";; *) warn "untested OS ${PRETTY_NAME:-?} (expected Ubuntu 22.04/24.04)";; esac

hdr "Ports"
for p in 80 443; do
  L=$(ss -tlnpH "sport = :$p" 2>/dev/null | head -1)
  if [ -z "$L" ]; then ok "port $p free"
  elif echo "$L" | grep -q nginx; then ok "port $p held by nginx (shared with other sites — fine)"
  else fail "port $p held by: $(echo "$L" | grep -o 'users:(("[^"]*' | cut -d'"' -f2)"; fi
done

hdr "SSH + firewall"
SSHP=$( { sshd -T 2>/dev/null | awk '/^port /{print $2}'; ss -tlnpH 2>/dev/null | grep -E '"sshd"|ssh.socket|systemd' | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sed 's/.*://'; } | grep -E '^[0-9]+$' | sort -un | grep -v '^6010$' | tr '\n' ' ')
info "SSH listening on: ${SSHP:-unknown}"
[ -z "$SSHP" ] && warn "could not detect SSH port; firewall step will be careful"
have ufw && info "ufw: $(ufw status | head -1)"

hdr "DNS"
PUB4=$(curl -4 -s -m 8 ifconfig.me || true); PUB6=$(curl -6 -s -m 8 ifconfig.me 2>/dev/null || true)
info "public IPv4 ${PUB4:-?}${PUB6:+ · IPv6 $PUB6}"
if [ -n "$DOMAIN" ]; then
  A=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')
  AAAA=$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '$1 ~ /:/ && $1 !~ /^::ffff:/{print $1; exit}')
  if [ -z "$A" ]; then fail "$DOMAIN has no A record (add one → ${PUB4:-server IP})"
  elif [ "$A" = "$PUB4" ]; then ok "$DOMAIN A → $A matches this server"
  else fail "$DOMAIN A → $A but this server is ${PUB4:-?}"; fi
  [ -n "$AAAA" ] && [ "$AAAA" != "$PUB6" ] && warn "$DOMAIN AAAA → $AAAA doesn't match this server (remove it or fix it)"
else info "no --domain given (HTTP on IP only)"; fi

hdr "Outbound reach"
for u in https://github.com https://archive.ubuntu.com https://acme-v02.api.letsencrypt.org/directory; do
  T=$(curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}s' "$u" || echo "000")
  case "$T" in 000*) fail "cannot reach $u";; *) ok "$u ($T)";; esac
done

hdr "Time + system state"
timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes && ok "clock NTP-synced" || warn "clock not NTP-synced"
info "timezone $(timedatectl show -p Timezone --value 2>/dev/null)"
[ -f /var/run/reboot-required ] && warn "reboot pending"
fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 && warn "apt is locked by another process"
info "Also check the cloud provider firewall allows 80/443 (ufw alone isn't enough)."

# ---------------- C. verdict ----------------
echo
if [ ${#FAILS[@]} -gt 0 ]; then V="NOT READY"; RC=2; elif [ ${#WARNS[@]} -gt 0 ]; then V="READY WITH WARNINGS"; RC=1; else V="READY"; RC=0; fi
echo "== Verdict: $V =="
printf '  needs  %s vCPU / %s MB RAM / %s GB disk      have  %s vCPU (load %s) / %s MB available / %s GB free\n' \
  "$NEED_CPU" "$NEED_RAM_MB" "$NEED_DISK_GB" "$CORES" "$L5" "$AVAIL" "$FREE"
for f in "${FAILS[@]}"; do echo "  FAIL: $f"; done
for w in "${WARNS[@]}"; do echo "  WARN: $w"; done
exit $RC
