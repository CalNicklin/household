#!/usr/bin/env bash
# household-deploy sha256:<digest>
# The only thing the `household` user can run (its SSH key is forced to this command, and sudoers lets
# it run this one file as root). It deploys the household image CI built, by digest, and nothing else:
# the compose file, Caddyfile and these scripts are the ones deploy/install.sh put on the server.
# A registry token may arrive on stdin (one line, valid only while the GitHub job runs); it is used for
# this pull and then removed. Nothing about the other apps on the server is named or touched.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"

digest="${1:-}"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "usage: household-deploy sha256:<64 hex digits>" >&2
  exit 2
fi
image="$HOUSEHOLD_REPO@$digest"
refuse_test_only_settings

exec 9>"$HOUSEHOLD_DIR/.deploy.lock"
flock -w 600 9

token=""
if [ ! -t 0 ]; then IFS= read -r -t 10 token || true; fi
# A digest names exactly one image, so one already here is the same image (a redeploy by hand needs no token).
if docker image inspect "$image" > /dev/null 2>&1; then
  :
elif [ -n "$token" ]; then
  login_dir="$(mktemp -d)"
  trap 'rm -rf "$login_dir"' EXIT
  printf '%s' "$token" | DOCKER_CONFIG="$login_dir" docker login "${HOUSEHOLD_REPO%%/*}" -u household --password-stdin > /dev/null 2>&1 || { echo "the registry refused the token" >&2; exit 1; }
  DOCKER_CONFIG="$login_dir" docker pull -q "$image" > /dev/null
  rm -rf "$login_dir"
else
  docker pull -q "$image" > /dev/null
fi
token=""
echo "have $image"

# The deploy files are pinned on the server; say so when this image carries different ones.
for f in compose.yml compose.hindsight.yml compose.mail.yml compose.caddy-sites.yml Caddyfile Caddyfile.mail; do
  theirs="$(docker run --rm --network none --memory 32m --entrypoint sha256sum "$image" "/app/deploy/$f" 2> /dev/null | cut -d' ' -f1 || true)"
  ours="$(sha256sum "$HOUSEHOLD_DIR/$f" 2> /dev/null | cut -d' ' -f1 || true)"
  if [ -n "$theirs" ] && [ "$theirs" != "$ours" ]; then echo "note: deploy/$f changed in this image; re-run deploy/install.sh on the server to use it"; fi
done

export HOUSEHOLD_IMAGE="$image"
previous="$(deployed_image)"

# HOU-175: other apps' sites are files the house doesn't write, so Caddy's whole config, with them, is
# validated in a throwaway Caddy before anything is switched. If it is invalid the deploy stops here, naming
# the file and line, and the running Caddy (and house) carry on untouched.
if [[ ":$COMPOSE_FILE:" == *":$HOUSEHOLD_DIR/compose.caddy-sites.yml:"* ]]; then
  set +e
  validation="$(household_compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null 2>&1)"
  valid=$?
  set -e
  if [ "$valid" -ne 0 ]; then
    echo "the house's Caddy config with $SITES_DIR is invalid, so nothing was switched; ${previous:+the house keeps running $previous and }the running Caddy carries on:" >&2
    grep -E '^Error:' <<< "$validation" | sed "s|/etc/caddy/sites/|$SITES_DIR/|g" >&2 || tail -n 5 <<< "$validation" >&2
    echo "fix or remove that file, then redeploy: sudo household-deploy $digest" >&2
    exit 1
  fi
  echo "caddy config with $SITES_DIR is valid"
fi
household_compose up -d --wait --wait-timeout 180 postgres objects

set +e
household_compose run --rm -T --no-deps app node scripts/house-setup.ts --check < /dev/null
setup=$?
set -e
if [ "$setup" -eq 3 ]; then
  echo "$image" > "$HOUSEHOLD_DIR/image"
  echo "The house is not set up yet, so the app is not started. On the server: sudo household-setup < house.json"
  exit 0
elif [ "$setup" -eq 78 ]; then
  # HOU-160 / PRV-6: the new image would refuse these settings at startup (the settings-refused line above
  # says what to set), so nothing is switched and the running house carries on.
  echo "$image refuses $HOUSEHOLD_DIR/.env, so it was not started; ${previous:+the house keeps running $previous; }fix .env and redeploy: sudo household-deploy $digest" >&2
  exit 1
elif [ "$setup" -ne 0 ]; then
  echo "could not check the house with $image (exit $setup)" >&2
  exit 1
fi

if household_compose up -d --wait --wait-timeout 300 --remove-orphans; then
  echo "$image" > "$HOUSEHOLD_DIR/image"
  echo "deployed $image"
else
  echo "$image did not come up healthy; on the server: sudo docker logs household-app-1" >&2
  if [ -n "$previous" ] && [ "$previous" != "$image" ]; then
    HOUSEHOLD_IMAGE="$previous" household_compose up -d --wait --wait-timeout 300 && echo "rolled back to $previous" >&2
  fi
  exit 1
fi

# Keep this image and the one before it (for a rollback); remove older household images only.
docker image ls --digests --format '{{.Digest}} {{.ID}}' "$HOUSEHOLD_REPO" | while read -r d id; do
  [ "$HOUSEHOLD_REPO@$d" = "$image" ] || [ "$HOUSEHOLD_REPO@$d" = "$previous" ] || docker image rm "$id" > /dev/null 2>&1 || true
done
