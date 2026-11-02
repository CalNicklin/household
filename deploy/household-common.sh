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
# PR images live in their own package, so household-deploy (HOUSEHOLD_REPO) can never pull one.
PREVIEW_REPO="${PREVIEW_REPO:-ghcr.io/calnicklin/household-preview}"
export PREVIEWS_DIR
# HOU-175: other apps' sites for the house's Caddy (root-owned *.caddy files; install.sh makes the directory).
SITES_DIR="${SITES_DIR:-/etc/household/sites}"
export SITES_DIR

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

# HOU-150: the mail receiver for forwarded order emails, when install.sh was given --mail-domain.
if grep -qE '^MAIL_DOMAIN=.+' "$HOUSEHOLD_DIR/.env"; then COMPOSE_FILE="$COMPOSE_FILE:$HOUSEHOLD_DIR/compose.mail.yml"; fi

# HOU-175: the house's Caddy also serves the sites in $SITES_DIR, but only when root alone can change what it
# would load: the directory and every *.caddy in it owned by root, not writable by group or others, and no
# symlinks. Otherwise the overlay is left out (saying why), and the house runs exactly as without it.
sites_usable() {
  local f found=""
  [ -d "$SITES_DIR" ] || return 1
  if [ -L "$SITES_DIR" ] || [ "$(stat -c %u "$SITES_DIR")" != 0 ] || (( 0$(stat -c %a "$SITES_DIR") & 022 )); then
    echo "note: $SITES_DIR is not root's alone (it must be a directory owned by root, writable by no group or other user), so the house's Caddy serves no extra sites" >&2
    return 1
  fi
  for f in "$SITES_DIR"/*.caddy; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ] || [ ! -f "$f" ] || [ "$(stat -c %u "$f")" != 0 ] || (( 0$(stat -c %a "$f") & 022 )); then
      echo "note: $f is not a root-owned file only root can write, so the house's Caddy serves no extra sites" >&2
      return 1
    fi
    found=yes
  done
  [ -n "$found" ]
}
if [ -f "$HOUSEHOLD_DIR/compose.caddy-sites.yml" ] && sites_usable; then
  COMPOSE_FILE="$COMPOSE_FILE:$HOUSEHOLD_DIR/compose.caddy-sites.yml"
  # Compose can't see a mounted file change, so the files' hash is a label: a deploy recreates Caddy (which
  # reads its config only at start) exactly when a site file changed.
  SITES_HASH="$(cd "$SITES_DIR" && sha256sum -- *.caddy | sha256sum | cut -c1-16)"
  export SITES_HASH
fi

household_compose() { docker compose "$@"; }

# HOU-175: the sites are files the house doesn't write, so before any `up` that could recreate Caddy, its
# whole config, sites included, goes through `caddy validate` in a throwaway Caddy (no ports published).
# Invalid: says which file and line, and fails. Needs HOUSEHOLD_IMAGE set, like every compose command.
sites_valid() {
  local out
  [[ ":$COMPOSE_FILE:" == *":$HOUSEHOLD_DIR/compose.caddy-sites.yml:"* ]] || return 0
  if out="$(household_compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null 2>&1)"; then
    echo "caddy config with $SITES_DIR is valid"
    return 0
  fi
  { grep -E '^Error:' <<< "$out" || tail -n 5 <<< "$out"; } | sed "s|/etc/caddy/sites/|$SITES_DIR/|g" >&2
  return 1
}

# HOU-160: the practice model's test-only opt-in never reaches the real house's settings (test harnesses
# set it in their own compose file instead). household-deploy and household-setup refuse such a .env.
refuse_test_only_settings() {
  if grep -qE '^PRACTICE_MODEL_FOR_TESTS=' "$HOUSEHOLD_DIR/.env"; then
    echo "refused: $HOUSEHOLD_DIR/.env sets PRACTICE_MODEL_FOR_TESTS, which is for Docker test harnesses only; delete that line (sudo nano $HOUSEHOLD_DIR/.env) and run this again" >&2
    exit 1
  fi
}

# The image running now (written by household-deploy once an image is in place).
deployed_image() { cat "$HOUSEHOLD_DIR/image" 2>/dev/null || true; }
