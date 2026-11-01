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
# FB-5: the PR previews: where household-preview keeps them, and the memory all of them may use together.
PREVIEWS_DIR="${PREVIEWS_DIR:-/srv/household-previews}"
PREVIEW_BUDGET_MB="${PREVIEW_BUDGET_MB:-600}"
export PREVIEWS_DIR

[ -f "$HOUSEHOLD_DIR/.env" ] || { echo "no $HOUSEHOLD_DIR/.env: run deploy/install.sh first" >&2; exit 1; }
# Every `docker compose` below (and in backup.sh and restore.sh) means the production project, through
# compose's own settings rather than a command line passed around as a string.
export COMPOSE_PROJECT_NAME=household
export COMPOSE_PROJECT_DIRECTORY="$HOUSEHOLD_DIR"
export COMPOSE_ENV_FILES="$HOUSEHOLD_DIR/.env"
export COMPOSE_FILE="$HOUSEHOLD_DIR/compose.yml"
# PLT-6: join the existing Hindsight's network when install.sh found it.
if grep -qE '^HINDSIGHT_NETWORK=.+' "$HOUSEHOLD_DIR/.env"; then COMPOSE_FILE="$COMPOSE_FILE:$HOUSEHOLD_DIR/compose.hindsight.yml"; fi
# FB-5: the house's Caddy also serves the PR previews when install.sh was given --preview-domain.
if grep -qE '^PREVIEW_DOMAIN=.+' "$HOUSEHOLD_DIR/.env"; then COMPOSE_FILE="$COMPOSE_FILE:$HOUSEHOLD_DIR/compose.caddy-previews.yml"; fi

household_compose() { docker compose "$@"; }

# The image running now (written by household-deploy once an image is in place).
deployed_image() { cat "$HOUSEHOLD_DIR/image" 2>/dev/null || true; }
