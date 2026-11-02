#!/usr/bin/env bash
# One-time (and re-runnable) server setup for the real house, run by Cal as root from a checkout of the
# repo on the VPS (docs/OPERATIONS.md has the order):
#   sudo deploy/install.sh --domain house.example.com --deploy-key "ssh-ed25519 AAAA... household-deploy"
# and, for the PR previews (FB-5), once more with
#   sudo deploy/install.sh --preview-domain preview.example.com --preview-key "ssh-ed25519 AAAA... household-preview"
# and, for order emails (HOU-150), once more with
#   sudo deploy/install.sh --mail-domain orders.example.com
# It never touches the other apps on the server. It:
#   - installs the compose file, Caddyfile and household-* commands (re-run it after changing deploy/);
#   - generates every secret on the server into /srv/household/.env (root only), once;
#   - finds the existing Hindsight's Docker network so the app can reach it;
#   - creates the `household` user, whose SSH key can only run household-deploy, via one sudoers rule;
#   - for previews: installs /srv/household-previews, and a second key that can only run household-preview;
#   - for order emails: the mail receiver on port 25, taking mail for orders@<mail domain> only;
#   - switches on the nightly backup.
set -euo pipefail
umask 022
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo deploy/install.sh ..." >&2; exit 1; }
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
domain="" key="" preview_domain="" preview_key="" mail_domain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:?}"; shift 2 ;;
    --deploy-key) key="${2:?}"; shift 2 ;;
    --preview-domain) preview_domain="${2:?}"; shift 2 ;;
    --preview-key) preview_key="${2:?}"; shift 2 ;;
    --mail-domain) mail_domain="${2:?}"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

lib=/usr/local/lib/household dir=/srv/household etc=/etc/household
install -d -m 755 "$lib" "$etc"
install -d -m 750 "$dir"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"
for c in deploy setup backup restore preview telegram google email; do ln -sfn "$lib/household-$c.sh" "/usr/local/sbin/household-$c"; done
# Credential files only the app (uid 10001 in its image) can read, mounted read-only into it.
install -d -o 10001 -g root -m 700 "$dir/credentials"
install -m 644 "$repo/deploy/compose.yml" "$repo/deploy/compose.hindsight.yml" "$repo/deploy/compose.caddy-previews.yml" "$repo/deploy/compose.mail.yml" "$repo/deploy/Caddyfile" "$repo/deploy/Caddyfile.previews" "$repo/deploy/Caddyfile.mail" "$dir/"
# FB-5: the PR previews' own directory: their compose file and which of them are running. Nothing of the
# house's is in it.
previews=/srv/household-previews
install -d -m 755 "$previews" "$previews/live"
install -m 644 "$repo/deploy/compose.preview.yml" "$previews/"
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
# FB-5: previews are served at pr-<n>.<preview domain> by the house's Caddy, which then also joins the
# previews' network (an internal one: nothing on it reaches the internet).
if [ -n "$preview_domain" ]; then
  [[ "$preview_domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "--preview-domain must be a lowercase domain, e.g. preview.example.com" >&2; exit 2; }
  sed -i '/^PREVIEW_DOMAIN=/d' "$dir/.env"
  echo "PREVIEW_DOMAIN=$preview_domain" >> "$dir/.env"
fi
if grep -qE '^PREVIEW_DOMAIN=.+' "$dir/.env"; then
  docker network inspect household-previews > /dev/null 2>&1 || docker network create --internal household-previews > /dev/null
fi

# HOU-150: order emails forwarded to orders@<mail domain> reach the house through its own receiver on
# port 25 (household-common.sh adds compose.mail.yml once this is set). Caddy gets the certificate.
if [ -n "$mail_domain" ]; then
  [[ "$mail_domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "--mail-domain must be a lowercase domain, e.g. orders.example.com" >&2; exit 2; }
  if ss -Hltn 'sport = :25' 2> /dev/null | grep -q . && ! docker ps -q --filter label=com.docker.compose.service=mail --filter label=com.docker.compose.project=household | grep -q .; then
    echo "something on this server already listens on port 25 (sudo ss -ltnp 'sport = :25'); stop it first, or the house can't start its mail receiver" >&2
    exit 2
  fi
  sed -i '/^MAIL_DOMAIN=/d' "$dir/.env"
  echo "MAIL_DOMAIN=$mail_domain" >> "$dir/.env"
  echo "the house takes mail for orders@$mail_domain once it is redeployed"
fi

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
# Each key is forced to its one command: the deploy key to household-deploy, the preview key (FB-5) to
# household-preview. Giving one key again replaces only that key's line.
home="$(getent passwd household | cut -d: -f6)"
authorized="$home/.ssh/authorized_keys"
set_key() {
  local command="$1" option="$2" given="$3" lines
  [[ "$given" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [^\"]*)?$ ]] || { echo "$option must be one ssh-ed25519 public key" >&2; exit 2; }
  if grep -vF "/usr/local/sbin/$command " "$authorized" 2> /dev/null | grep -qF " $(cut -d' ' -f2 <<< "$given")"; then
    echo "$option must be its own key, not the one another command already uses" >&2
    exit 2
  fi
  install -d -o root -g root -m 755 "$home/.ssh"
  lines="$(grep -vF "/usr/local/sbin/$command " "$authorized" 2> /dev/null || true)"
  { [ -z "$lines" ] || printf '%s\n' "$lines"; printf 'restrict,command="sudo -n /usr/local/sbin/%s \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$command" "$given"; } > "$authorized.new"
  chown root:root "$authorized.new"
  chmod 644 "$authorized.new"
  mv "$authorized.new" "$authorized"
}
if [ -n "$key" ]; then set_key household-deploy --deploy-key "$key"; fi
if [ -n "$preview_key" ]; then set_key household-preview --preview-key "$preview_key"; fi
rule="$(mktemp)"
echo 'household ALL=(root) NOPASSWD: /usr/local/sbin/household-deploy, /usr/local/sbin/household-preview' > "$rule"
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
