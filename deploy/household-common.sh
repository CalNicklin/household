# Sourced by the household-* commands on the server (installed to /usr/local/lib/household by
# deploy/install.sh). Settings live in /etc/household/household.conf, owned by root; sudo resets the
# environment, so the restricted `household` user cannot change any of them.
set -euo pipefail
umask 077
HOUSEHOLD_CONF="${HOUSEHOLD_CONF:-/etc/household/household.conf}"
# shellcheck source=/dev/null
if [ -r "$HOUSEHOLD_CONF" ]; then . "$HOUSEHOLD_CONF"; fi
HOUSEHOLD_DIR="${HOUSEHOLD_DIR:-/srv/household}"
HOUSEHOLD_REPO="${HOUSEHOLD_REPO:-ghcr.io/calnicklin/household}"
HOUSEHOLD_LIB="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
BACKUP_DEST="${BACKUP_DEST:-/var/backups/household}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

[ -f "$HOUSEHOLD_DIR/.env" ] || { echo "no $HOUSEHOLD_DIR/.env: run deploy/install.sh first" >&2; exit 1; }
HOUSEHOLD_COMPOSE=(docker compose -p household --project-directory "$HOUSEHOLD_DIR" -f "$HOUSEHOLD_DIR/compose.yml")
# PLT-6: join the existing Hindsight's network when install.sh found it.
if grep -qE '^HINDSIGHT_NETWORK=.+' "$HOUSEHOLD_DIR/.env"; then HOUSEHOLD_COMPOSE+=(-f "$HOUSEHOLD_DIR/compose.hindsight.yml"); fi
HOUSEHOLD_COMPOSE+=(--env-file "$HOUSEHOLD_DIR/.env")

household_compose() { "${HOUSEHOLD_COMPOSE[@]}" "$@"; }

# The image running now (written by household-deploy once an image is in place).
deployed_image() { cat "$HOUSEHOLD_DIR/image" 2>/dev/null || true; }
