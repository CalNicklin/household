#!/usr/bin/env bash
# household-preview "preview <PR number> sha256:<digest>"
# household-preview "preview-stop <PR number>"
# FB-5: a PR's preview on the VPS, and the only thing the preview deploy key can run (its SSH key is
# forced to this command, and sudoers lets the `household` user run this one file as root). It runs the
# PR's image from PREVIEW_REPO (never the house's HOUSEHOLD_REPO), by digest, as its own compose project household-pr-<n> from compose.preview.yml: the
# practice household, freshly seeded every time, at https://pr-<n>.<PREVIEW_DOMAIN>/. It never passes
# the real house's .env, credentials or volumes to a preview. All previews together stay within
# PREVIEW_BUDGET_MB of memory; when a new one would not fit, the oldest is removed first.
# A registry token may arrive on stdin, as for household-deploy.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"

usage() {
  echo 'usage: household-preview "preview <PR number> sha256:<64 hex digits>" | "preview-stop <PR number>"' >&2
  exit 2
}
# The forced command hands over the whole SSH command as one argument; nothing else is accepted.
[ $# -eq 1 ] || usage
if [[ "$1" =~ ^preview\ ([1-9][0-9]{0,5})\ (sha256:[0-9a-f]{64})$ ]]; then
  action=deploy n="${BASH_REMATCH[1]}" digest="${BASH_REMATCH[2]}"
elif [[ "$1" =~ ^preview-stop\ ([1-9][0-9]{0,5})$ ]]; then
  action=stop n="${BASH_REMATCH[1]}" digest=""
else
  usage
fi

domain="$(grep -E '^PREVIEW_DOMAIN=' "$HOUSEHOLD_DIR/.env" | tail -n1 | cut -d= -f2- || true)"
if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]{0,200}[a-z0-9])?$ ]] || [ ! -f "$PREVIEWS_DIR/compose.preview.yml" ]; then
  echo "previews are not set up on this server: sudo deploy/install.sh --preview-domain <domain> (docs/OPERATIONS.md)" >&2
  exit 1
fi
live="$PREVIEWS_DIR/live"
install -d -m 755 "$live"

# A preview's own project, and never the house's: the COMPOSE_* settings household-common exports for
# the house are dropped, and no env file is read (the previews directory has none either).
preview_compose() {
  local pr="$1"
  shift
  local defaults=() name
  # Taking a preview down still needs every setting compose.preview.yml requires; none is used then.
  for name in PREVIEW_IMAGE $PREVIEW_SECRETS; do [ -n "${!name:-}" ] || defaults+=("$name=none"); done
  env -u COMPOSE_PROJECT_NAME -u COMPOSE_PROJECT_DIRECTORY -u COMPOSE_ENV_FILES -u COMPOSE_FILE \
    PREVIEW_NUMBER="$pr" PREVIEW_DOMAIN="$domain" "${defaults[@]}" \
    docker compose -p "household-pr-$pr" --project-directory "$PREVIEWS_DIR" --env-file /dev/null -f "$PREVIEWS_DIR/compose.preview.yml" "$@"
}

# Each made at random per deploy (compose.preview.yml), so no preview runs on a published practice default.
PREVIEW_SECRETS="PREVIEW_SESSION_SECRET PREVIEW_MCP_TOKEN PREVIEW_TELEGRAM_WEBHOOK_SECRET PREVIEW_EMAIL_WEBHOOK_SECRET PREVIEW_CALENDAR_WEBHOOK_TOKEN PREVIEW_HELPER_TOKEN"

# One file per running preview, named after its host (Caddy's on-demand TLS asks for it), holding
# "<started, epoch seconds> <image>".
marker() { echo "$live/pr-$1.$domain"; }
running() { find "$live" -maxdepth 1 -type f -name 'pr-*' -printf '%f\n' | sed -nE 's/^pr-([0-9]+)\..*$/\1/p' | sort -un; }
image_of() { cut -d' ' -f2 "$live/pr-$1."* 2> /dev/null | head -n1 || true; }

remove() {
  local pr="$1" image
  image="$(image_of "$pr")"
  preview_compose "$pr" down -v --remove-orphans --timeout 10 > /dev/null 2>&1 || true
  rm -f "$live/pr-$pr."*
  # Its image goes too, unless another preview or the house runs it.
  if [ -n "$image" ] && [ "$image" != "$(deployed_image)" ] && ! cat "$live"/pr-* 2> /dev/null | cut -d' ' -f2 | grep -qxF "$image"; then
    docker image rm "$image" > /dev/null 2>&1 || true
  fi
}

exec 9> "$PREVIEWS_DIR/.lock"
flock -w 900 9 || { echo "another preview command held the lock for 15 minutes; nothing was changed" >&2; exit 1; }

if [ "$action" = stop ]; then
  remove "$n"
  echo "removed pr-$n"
  exit 0
fi

image="$PREVIEW_REPO@$digest"
token=""
if [ ! -t 0 ]; then IFS= read -r -t 10 token || true; fi
if docker image inspect "$image" > /dev/null 2>&1; then
  :
elif [ -n "$token" ]; then
  login_dir="$(mktemp -d)"
  trap 'rm -rf "$login_dir"' EXIT
  printf '%s' "$token" | DOCKER_CONFIG="$login_dir" docker login "${PREVIEW_REPO%%/*}" -u household --password-stdin > /dev/null 2>&1 || { echo "the registry refused the token" >&2; exit 1; }
  DOCKER_CONFIG="$login_dir" docker pull -q "$image" > /dev/null
  rm -rf "$login_dir"
else
  docker pull -q "$image" > /dev/null
fi
token=""
echo "have $image"

# The memory one preview may use (compose.preview.yml's x-memory, all in m), and how many fit.
cost="$(awk '/^x-memory:/ { f = 1; next } f && /^[^ ]/ { f = 0 } f && $NF ~ /^[0-9]+m$/ { s += $NF + 0 } END { print s + 0 }' "$PREVIEWS_DIR/compose.preview.yml")"
[ "$cost" -gt 0 ] || { echo "could not read the preview's memory caps" >&2; exit 1; }
fit=$((PREVIEW_BUDGET_MB / cost))
[ "$fit" -ge 1 ] || { echo "one preview needs ${cost} MB, more than PREVIEW_BUDGET_MB=${PREVIEW_BUDGET_MB}" >&2; exit 1; }

docker network inspect household-previews > /dev/null 2>&1 || docker network create --internal household-previews > /dev/null

# A fresh practice household on every deploy: this PR's previous preview goes first.
remove "$n"
while [ "$(running | wc -l)" -ge "$fit" ]; do
  oldest="$(for pr in $(running); do echo "$(cut -d' ' -f1 "$live/pr-$pr."* | head -n1) $pr"; done | sort -n | head -n1 | cut -d' ' -f2)"
  remove "$oldest"
  echo "evicted pr-$oldest: the oldest preview, to keep all previews within ${PREVIEW_BUDGET_MB} MB ($fit of ${cost} MB)"
done

export PREVIEW_IMAGE="$image"
for name in $PREVIEW_SECRETS; do
  printf -v "$name" '%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export "${name?}"
done
if ! preview_compose "$n" up -d --wait --wait-timeout 300 > /dev/null 2>&1; then
  echo "pr-$n did not come up healthy; its app's last lines:" >&2
  preview_compose "$n" logs --no-color --tail 30 app >&2 || true
  remove "$n"
  exit 1
fi
echo "$(date +%s) $image" > "$(marker "$n")"
chmod 644 "$(marker "$n")"
echo "preview pr-$n: https://pr-$n.$domain/"
echo "logins (the practice household's, not secrets):"
# Printed by the PR's own code, so every line is marked as such: nothing it prints can pass for one of
# this script's lines (the workflow reads the URL and evictions from those).
{ preview_compose "$n" exec -T app node scripts/practice-logins.ts < /dev/null 2> /dev/null || echo "  see practice/data.ts"; } | head -n 20 | sed 's/^/login:/'
