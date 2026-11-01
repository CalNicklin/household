#!/usr/bin/env bash
# One-time (and re-runnable) server setup for the real house, run by Cal as root from a checkout of the
# repo on the VPS (docs/OPERATIONS.md has the order):
#   sudo deploy/install.sh --domain house.example.com --deploy-key "ssh-ed25519 AAAA... household-deploy"
# It never touches the other apps on the server. It:
#   - installs the compose file, Caddyfile and household-* commands (re-run it after changing deploy/);
#   - generates every secret on the server into /srv/household/.env (root only), once;
#   - finds the existing Hindsight's Docker network so the app can reach it;
#   - creates the `household` user, whose SSH key can only run household-deploy, via one sudoers rule;
#   - switches on the nightly backup.
set -euo pipefail
umask 022
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo deploy/install.sh ..." >&2; exit 1; }
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
domain="" key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:?}"; shift 2 ;;
    --deploy-key) key="${2:?}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

lib=/usr/local/lib/household dir=/srv/household etc=/etc/household
install -d -m 755 "$lib" "$etc"
install -d -m 750 "$dir"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"
for c in deploy setup backup restore; do ln -sfn "$lib/household-$c.sh" "/usr/local/sbin/household-$c"; done
# Credential files only the app (uid 10001 in its image) can read, mounted read-only into it.
install -d -o 10001 -g root -m 700 "$dir/credentials"
install -m 644 "$repo/deploy/compose.yml" "$repo/deploy/compose.hindsight.yml" "$repo/deploy/Caddyfile" "$dir/"
if [ ! -f "$etc/household.conf" ]; then
  cat > "$etc/household.conf" <<'CONF'
# Settings for the household-* commands. Root-owned; the deploy user cannot change them.
HOUSEHOLD_DIR=/srv/household
HOUSEHOLD_REPO=ghcr.io/calnicklin/household
# Nightly backups: where they go, how many to keep, and an optional rsync target for a copy off the
# server (e.g. a Hetzner Storage Box: u123456@u123456.your-storagebox.de:household, using root's SSH key).
BACKUP_DEST=/var/backups/household
BACKUP_KEEP=14
BACKUP_REMOTE=
CONF
  chmod 644 "$etc/household.conf"
fi

# Secrets: generated here, once, by the same script as everywhere else (PRV-6). Never printed.
if [ ! -f "$dir/.env" ]; then
  docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$dir:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
  echo "generated the secrets in $dir/.env"
fi
chmod 600 "$dir/.env"
if [ -n "$domain" ]; then
  sed -i '/^HOUSEHOLD_DOMAIN=/d' "$dir/.env"
  echo "HOUSEHOLD_DOMAIN=$domain" >> "$dir/.env"
fi
grep -qE '^HOUSEHOLD_DOMAIN=.+' "$dir/.env" || { echo "give the domain once: --domain house.example.com" >&2; exit 2; }

# PLT-6: reuse the Hindsight already on the server. It publishes only on the host's 127.0.0.1, which a
# container cannot reach, so the app joins Hindsight's own Docker network instead.
if ! grep -qE '^HINDSIGHT_NETWORK=' "$dir/.env" && docker inspect hindsight > /dev/null 2>&1; then
  net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' hindsight | grep -vxE 'bridge|host|none|' | head -n1 || true)"
  if [ -n "$net" ]; then
    echo "HINDSIGHT_NETWORK=$net" >> "$dir/.env"
    echo "the app will reach Hindsight on its network $net"
  else
    echo "Hindsight is on Docker's default bridge, which has no names; see docs/OPERATIONS.md (Hindsight). The house runs without it until then." >&2
  fi
fi

# The deploy user: no password, not in the docker group, and its key can only run household-deploy.
id household > /dev/null 2>&1 || useradd --system --create-home --shell /bin/bash household
passwd -l household > /dev/null
gpasswd -d household docker > /dev/null 2>&1 || true
if [ -n "$key" ]; then
  [[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [^\"]*)?$ ]] || { echo "--deploy-key must be one ssh-ed25519 public key" >&2; exit 2; }
  home="$(getent passwd household | cut -d: -f6)"
  install -d -o root -g root -m 755 "$home/.ssh"
  printf 'restrict,command="sudo -n /usr/local/sbin/household-deploy \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$key" > "$home/.ssh/authorized_keys"
  chown root:root "$home/.ssh/authorized_keys"
  chmod 644 "$home/.ssh/authorized_keys"
fi
rule="$(mktemp)"
echo 'household ALL=(root) NOPASSWD: /usr/local/sbin/household-deploy' > "$rule"
visudo -cqf "$rule"
install -m 440 "$rule" /etc/sudoers.d/household-deploy
rm -f "$rule"

# The nightly backup (PLT-8).
cat > /etc/systemd/system/household-backup.service <<'UNIT'
[Unit]
Description=Back up the household (Postgres and object storage)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/household-backup
UNIT
cat > /etc/systemd/system/household-backup.timer <<'UNIT'
[Unit]
Description=Nightly household backup
[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --now household-backup.timer > /dev/null
else
  echo "no systemd here: run /usr/local/sbin/household-backup nightly some other way (e.g. cron)" >&2
fi
echo "installed. Next: add the GitHub secrets, then deploy (docs/OPERATIONS.md)."
