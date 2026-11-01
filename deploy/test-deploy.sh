#!/usr/bin/env bash
# PLT-8: run the real household-deploy (and household-setup, -backup, -restore) against local Docker,
# the way the VPS runs them, with a local registry standing in for GHCR. Needs Docker and ports 80, 443
# and 5000 free; leaves nothing behind.
#   docker build -t household:local . && deploy/test-deploy.sh household:local
set -euo pipefail
local_image="${1:?usage: deploy/test-deploy.sh <locally built household image>}"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
work="$(mktemp -d)"
export HOUSEHOLD_CONF="$work/household.conf"
cleanup() {
  ( cd "$work/srv" 2>/dev/null && HOUSEHOLD_IMAGE=x docker compose -p household -f compose.yml --env-file .env down -v --remove-orphans > /dev/null 2>&1 ) || true
  docker rm -f household-test-registry > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FALSE PLT-8: $*" >&2; exit 1; }

step "a registry standing in for GHCR, holding the image CI would have pushed"
docker run -d --rm --name household-test-registry -p 127.0.0.1:5000:5000 "${REGISTRY_IMAGE:-registry:2}" > /dev/null
docker tag "$local_image" localhost:5000/household:test
until docker push -q localhost:5000/household:test > /dev/null 2>&1; do sleep 1; done
digest="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:test | cut -d@ -f2)"
docker image rm localhost:5000/household:test > /dev/null
echo "pushed $digest"

step "the server as install.sh leaves it: deploy files, settings, secrets generated in place"
install -d -m 750 "$work/srv"
cp "$repo"/deploy/compose.yml "$repo"/deploy/compose.hindsight.yml "$repo"/deploy/Caddyfile "$work/srv/"
cat > "$HOUSEHOLD_CONF" <<CONF
HOUSEHOLD_DIR=$work/srv
HOUSEHOLD_REPO=localhost:5000/household
BACKUP_DEST=$work/backups
BACKUP_KEEP=1
CONF
docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
echo "HOUSEHOLD_DOMAIN=localhost" >> "$work/srv/.env"
grep -q '^PRACTICE=false$' "$work/srv/.env" || fail "env-init --real did not write the real house"

# The household-* commands, laid out as install.sh installs them (with backup.sh and restore.sh beside them).
lib="$work/lib"
install -d "$lib"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"

step "household-deploy refuses anything but a digest"
for bad in "" "latest" "sha256:abc" 'sha256:0000000000000000000000000000000000000000000000000000000000000000; id'; do
  set +e; "$lib/household-deploy.sh" "$bad" < /dev/null > /dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 2 ] || fail "household-deploy accepted '$bad' (exit $rc)"
done
echo "refused 4 bad arguments"

step "first deploy: pulls by digest, starts the database and storage, and waits for the house to be set up"
"$lib/household-deploy.sh" "$digest" < /dev/null | tee "$work/deploy1.log"
grep -q "not set up yet" "$work/deploy1.log" || fail "first deploy did not ask for the house to be set up"

step "household-setup: the house once, logins generated and shown only here"
printf '%s' '{"name":"Home","timezone":"Europe/London","latitude":51.45,"longitude":-2.59,"adults":[{"id":"sam","name":"Sam"},{"id":"alex","name":"Alex"}]}' \
  | "$lib/household-setup.sh" > "$work/logins" 2> "$work/setup.err" || { cat "$work/setup.err" >&2; fail "setup failed"; }
[ "$(grep -c '^  sam ' "$work/logins")" -eq 1 ] || fail "no login printed for sam"
password="$(awk '$1=="sam"{print $2}' "$work/logins")"
echo "set up; 2 logins printed"

step "second deploy: the app comes up healthy behind Caddy, with no shopping helper"
"$lib/household-deploy.sh" "$digest" < /dev/null | tee "$work/deploy2.log"
grep -q "^deployed localhost:5000/household@$digest" "$work/deploy2.log" || fail "second deploy did not finish"
[ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] || fail "app is not healthy"
[ "$(curl -sk --resolve localhost:443:127.0.0.1 https://localhost/healthz)" = ok ] || fail "healthz through Caddy"
code="$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/trpc/views.home)"
[ "$code" = 401 ] || fail "the app answered $code without a login (PRV-6)"
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost/healthz)"
[ "$code" = 308 ] || fail "plain HTTP answered $code, not a redirect to HTTPS"
login="$(curl -sk -D - -o /dev/null -H 'content-type: application/json' -d "{\"username\":\"sam\",\"password\":\"$password\"}" https://localhost/api/login)"
grep -qi '^set-cookie: .*; Secure' <<< "$login" || fail "sam could not log in with the generated password over HTTPS"
docker logs household-app-1 2>&1 | grep -q 'ports-missing-credentials.*shopping (no helper: requests wait)' || fail "the app did not say it runs without a helper"
echo "healthy behind Caddy; login works; no helper"

step "a broken image never replaces a working one: household-deploy rolls back"
printf 'FROM %s\nCMD ["node", "-e", "process.exit(1)"]\n' "$local_image" | docker build -q -t localhost:5000/household:broken - > /dev/null
docker push -q localhost:5000/household:broken > /dev/null
broken="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:broken | cut -d@ -f2)"
docker image rm localhost:5000/household:broken > /dev/null
set +e; "$lib/household-deploy.sh" "$broken" < /dev/null > "$work/deploy3.log" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] || fail "deploying a broken image exited $rc"
grep -q "rolled back to localhost:5000/household@$digest" "$work/deploy3.log" || fail "no rollback"
[ "$(cat "$work/srv/image")" = "localhost:5000/household@$digest" ] || fail "the broken image was recorded as deployed"
[ "$(curl -sk https://localhost/healthz)" = ok ] || fail "not healthy after the rollback"
echo "the broken image failed its health check; rolled back to the working one"

step "memory: every container has its cap"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' household-app-1 household-postgres-1 household-objects-1 household-caddy-1

step "household-backup and household-restore"
"$lib/household-backup.sh"
backup="$(find "$work/backups" -mindepth 1 -maxdepth 1 -type d | head -n1)"
( cd "$backup" && sha256sum -c SHA256SUMS > /dev/null ) || fail "backup sums"
"$lib/household-restore.sh" "$backup" > /dev/null
for _ in $(seq 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] && break; sleep 2; done
[ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] || fail "app not healthy after the restore"
grep -q '^  sam ' "$work/logins" && [ -n "$(curl -sk -D - -o /dev/null -H 'content-type: application/json' -d "{\"username\":\"sam\",\"password\":\"$password\"}" https://localhost/api/login | grep -i '^set-cookie')" ] || fail "sam's login did not survive the restore"
echo "backed up to $(basename "$backup") and restored; the house came back healthy"
step "PASS: household-deploy, -setup, -backup and -restore against local Docker"
