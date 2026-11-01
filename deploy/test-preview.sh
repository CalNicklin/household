#!/usr/bin/env bash
# FB-5: run the real household-preview (next to the real house, deployed by the real household-deploy)
# against local Docker, the way the VPS runs them, with a local registry standing in for GHCR. Needs
# Docker, ports 80, 443 and 5000 free, and no household project, preview or household-previews network on
# this machine (it refuses rather than touch them); leaves nothing behind.
#   docker build -t household:local . && deploy/test-preview.sh household:local
set -euo pipefail
local_image="${1:?usage: deploy/test-preview.sh <locally built household image>}"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
existing="$(docker ps -aq --filter label=com.docker.compose.project=household; docker volume ls -q --filter label=com.docker.compose.project=household; docker ps -aq --filter name='^household-pr-')"
if [ -n "$existing" ] || docker network inspect household-previews > /dev/null 2>&1; then
  echo "a household project, preview or the household-previews network already exists here; take it down first, or run this on another machine. Nothing was touched." >&2
  exit 1
fi
work="$(mktemp -d)"
export HOUSEHOLD_CONF="$work/household.conf"
lib="$work/lib"
cleanup() {
  for p in $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | grep -E '^household-pr-[0-9]+$' | sort -u); do
    PREVIEW_IMAGE=x PREVIEW_NUMBER=0 PREVIEW_DOMAIN=x PREVIEW_SESSION_SECRET=x docker compose -p "$p" -f "$work/previews/compose.preview.yml" --env-file /dev/null down -v --remove-orphans > /dev/null 2>&1 || true
  done
  ( cd "$work/srv" 2>/dev/null && HOUSEHOLD_IMAGE=x PREVIEWS_DIR="$work/previews" docker compose -p household -f compose.yml -f compose.caddy-previews.yml --env-file .env down -v --remove-orphans > /dev/null 2>&1 ) || true
  docker network rm household-previews > /dev/null 2>&1 || true
  docker rm -f household-test-hindsight > /dev/null 2>&1 || true
  docker network rm household-test-hindsight > /dev/null 2>&1 || true
  docker rm -f household-test-registry > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FALSE FB-5: $*" >&2; exit 1; }
https() { local host="$1" path="$2"; shift 2; curl -sk --max-time 20 --resolve "$host:443:127.0.0.1" "$@" "https://$host$path"; }
# A removed preview's URL reaches nothing: no certificate, or (once Caddy holds one) a 502 from Caddy.
gone() { case "$(https "$1.preview.localhost" /healthz -o /dev/null -w '%{http_code}')" in 000 | 502) return 0 ;; *) return 1 ;; esac; }
login_cookie() { https "$1" /api/login -D - -o /dev/null -H 'content-type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}" | grep -i '^set-cookie: .*; Secure' || true; }
# The house as it stands: each container's id, start time and restart count, its volumes and its .env.
house_state() {
  for c in household-caddy-1 household-app-1 household-postgres-1 household-objects-1; do docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}} {{.RestartCount}}' "$c"; done
  docker volume ls -q --filter label=com.docker.compose.project=household | sort
  sha256sum "$work/srv/.env"
}

step "a registry standing in for GHCR: the house's image and three PRs' images"
docker run -d --rm --name household-test-registry -p 127.0.0.1:5000:5000 "${REGISTRY_IMAGE:-registry:2}" > /dev/null
# push <repo>:<tag>: prints the digest. The house's images and the PRs' live in separate repos, as on GHCR.
push() {
  docker push -q "localhost:5000/$1" > /dev/null 2>&1 || { sleep 1; push "$1"; return; }
  docker image inspect --format '{{index .RepoDigests 0}}' "localhost:5000/$1" | cut -d@ -f2
  docker image rm "localhost:5000/$1" > /dev/null
}
docker tag "$local_image" localhost:5000/household:main
house="$(push household:main)"
declare -A pr
for n in 1 2 3; do
  printf 'FROM %s\nLABEL pr=%s\n' "$local_image" "$n" | docker build -q -t "localhost:5000/household-preview:pr-$n" - > /dev/null
  pr[$n]="$(push "household-preview:pr-$n")"
done
echo "pushed the house's image and pr-1, pr-2, pr-3"

step "the server as install.sh leaves it, with --preview-domain: the house's files and the previews' own directory"
install -d -m 750 "$work/srv"
install -d -o 10001 -m 700 "$work/srv/credentials"
cp "$repo"/deploy/compose.yml "$repo"/deploy/compose.hindsight.yml "$repo"/deploy/compose.caddy-previews.yml "$repo"/deploy/Caddyfile "$repo"/deploy/Caddyfile.previews "$work/srv/"
install -d -m 755 "$work/previews" "$work/previews/live"
cp "$repo/deploy/compose.preview.yml" "$work/previews/"
cat > "$HOUSEHOLD_CONF" <<CONF
HOUSEHOLD_DIR=$work/srv
HOUSEHOLD_REPO=localhost:5000/household
PREVIEW_REPO=localhost:5000/household-preview
PREVIEWS_DIR=$work/previews
PREVIEW_BUDGET_MB=600
CONF
docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
printf 'HOUSEHOLD_DOMAIN=localhost\nPREVIEW_DOMAIN=preview.localhost\n' >> "$work/srv/.env"
docker network create --internal household-previews > /dev/null
install -d "$lib"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"

step "the real house: deployed by household-deploy, set up, healthy behind Caddy"
"$lib/household-deploy.sh" "$house" < /dev/null > /dev/null
printf '%s' '{"name":"Home","timezone":"Europe/London","latitude":51.45,"longitude":-2.59,"adults":[{"id":"sam","name":"Sam"}]}' | "$lib/household-setup.sh" > "$work/logins" 2> /dev/null
house_password="$(awk '$1=="sam"{print $2}' "$work/logins")"
"$lib/household-deploy.sh" "$house" < /dev/null | grep "^deployed" || fail "the house did not deploy"
[ "$(https localhost /healthz)" = ok ] || fail "the house is not up"
[ -n "$(login_cookie localhost sam "$house_password")" ] || fail "sam cannot log in to the house"
docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' household-app-1 | grep -qx household-previews && fail "the house's app is on the previews' network"
house_state > "$work/house.before"
echo "the house is up; sam logs in"

step "household-preview refuses anything malformed (and household-deploy refuses the preview forms)"
bad=(""
  "preview"
  "preview 1"
  "preview 0 ${pr[1]}"
  "preview 01 ${pr[1]}"
  "preview -1 ${pr[1]}"
  "preview 1234567 ${pr[1]}"
  "preview x ${pr[1]}"
  "preview 1 latest"
  "preview 1 sha256:abc"
  "preview 1 ${pr[1]}; id"
  "preview 1 ${pr[1]} extra"
  "preview  1 ${pr[1]}"
  "preview-stop"
  "preview-stop 0"
  "preview-stop 1; rm -rf /"
  "preview-stop ../1"
  "preview-stop 1 2"
  "${pr[1]}"
  "sha256:0000000000000000000000000000000000000000000000000000000000000000")
for arg in "${bad[@]}"; do
  set +e; "$lib/household-preview.sh" "$arg" < /dev/null > /dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 2 ] || fail "household-preview accepted '$arg' (exit $rc)"
done
set +e; "$lib/household-preview.sh" "preview-stop" "1" < /dev/null > /dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] || fail "household-preview accepted two arguments (exit $rc)"
for arg in "preview 1 ${pr[1]}" "preview-stop 1"; do
  set +e; "$lib/household-deploy.sh" "$arg" < /dev/null > /dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 2 ] || fail "household-deploy accepted '$arg' (exit $rc)"
done
[ -z "$(docker ps -aq --filter name='^household-pr-')" ] || fail "a refused command started something"
echo "refused ${#bad[@]} malformed commands and two arguments; household-deploy refused both preview forms"

step "two previews at once, each its own practice household at its own URL"
for n in 1 2; do
  "$lib/household-preview.sh" "preview $n ${pr[$n]}" < /dev/null | tee "$work/pr-$n.log"
  grep -qx "preview pr-$n: https://pr-$n.preview.localhost/" "$work/pr-$n.log" || fail "pr-$n did not say its URL"
  grep -qx "login:  priya  practice" "$work/pr-$n.log" || fail "pr-$n did not print the practice logins"
done
for n in 1 2; do
  host="pr-$n.preview.localhost"
  [ "$(https "$host" /healthz)" = ok ] || fail "$host is not up"
  [ "$(https "$host" /api/trpc/views.home -o /dev/null -w '%{http_code}')" = 401 ] || fail "$host answered without a login (PRV-6)"
  [ -n "$(login_cookie "$host" priya practice)" ] || fail "priya cannot log in to $host"
  [ -z "$(login_cookie "$host" sam "$house_password")" ] || fail "the house's login works on $host"
  [ "$(docker inspect -f '{{.Config.Image}}' "household-pr-$n-app-1")" = "localhost:5000/household-preview@${pr[$n]}" ] || fail "$host runs the wrong image"
done
[ -z "$(login_cookie localhost priya practice)" ] || fail "a practice login works on the real house"
# Their own households: a mark in pr-1's database is not in pr-2's.
docker exec household-pr-1-postgres-1 psql -U postgres -qc "create database only_pr_1" > /dev/null
[ "$(docker exec household-pr-1-postgres-1 psql -U postgres -tAc "select count(*) from pg_database where datname = 'only_pr_1'")" = 1 ] || fail "no mark in pr-1"
[ "$(docker exec household-pr-2-postgres-1 psql -U postgres -tAc "select count(*) from pg_database where datname = 'only_pr_1'")" = 0 ] || fail "pr-1 and pr-2 share a database"
echo "pr-1 and pr-2 are up behind the house's Caddy; priya logs in to each; their databases are their own"

step "a preview cannot reach the house, Hindsight, the internet, or the house's settings"
# A stand-in Hindsight on its own network, as on the VPS.
docker network create household-test-hindsight > /dev/null
docker run -d --rm --name household-test-hindsight --network household-test-hindsight --network-alias hindsight "${REGISTRY_IMAGE:-registry:2}" > /dev/null
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1" | cut -d' ' -f1; }
probe='const [h] = process.argv.slice(1); require("dns").lookup(h, (e) => { if (!e) { console.log("resolved " + h); process.exit(1); } })'
reach='const [u] = process.argv.slice(1); fetch(u, { signal: AbortSignal.timeout(5000) }).then(() => { console.log("reached " + u); process.exit(1); }, () => process.exit(0))'
for h in household-app-1 household-postgres-1 household-objects-1 hindsight household-test-hindsight example.com; do
  docker exec household-pr-1-app-1 node -e "$probe" "$h" || fail "pr-1 can find $h"
done
for u in "http://$(ip_of household-app-1):3001/healthz" "http://$(ip_of household-objects-1):8333/healthz" "http://$(ip_of household-test-hindsight):5000/" "https://example.com/" "http://household-caddy-1:5555/?domain=pr-1.preview.localhost"; do
  docker exec household-pr-1-app-1 node -e "$reach" "$u" || fail "pr-1 reached $u"
done
docker rm -f household-test-hindsight > /dev/null && docker network rm household-test-hindsight > /dev/null
env_of_pr="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' household-pr-1-app-1 household-pr-2-app-1)"
grep -E '^[A-Z0-9_]+=.{8,}$' "$work/srv/.env" | grep -vE '^(PRACTICE|DB_PREFIX|HOUSEHOLD_ID|HOUSEHOLD_DOMAIN|PREVIEW_DOMAIN|SUPERMARKET_SECRET_FILE)=' | cut -d= -f2- | while IFS= read -r secret; do
  if grep -qF -- "$secret" <<< "$env_of_pr"; then fail "a preview has one of the house's secrets"; fi
done
[ -z "$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' household-pr-1-app-1 household-pr-1-postgres-1 | grep -F "$work/srv" || true)" ] || fail "a preview mounts the house's files"
grep -qE '^PRACTICE=true$' <<< "$env_of_pr" || fail "a preview is not in practice mode"
# No preview runs on a practice default published in server/env.ts, and no two share a value.
for name in SESSION_SECRET MCP_TOKEN TELEGRAM_WEBHOOK_SECRET EMAIL_WEBHOOK_SECRET CALENDAR_WEBHOOK_TOKEN HELPER_TOKEN; do
  values="$(grep -E "^$name=" <<< "$env_of_pr" | cut -d= -f2-)"
  [ "$(sort -u <<< "$values" | grep -cE '^[0-9a-f]{64}$')" = 2 ] || fail "$name is not made per preview"
done
# Confined: not root, no capabilities, no privilege escalation, bounded CPU and processes.
for c in household-pr-1-app-1 household-pr-1-postgres-1; do
  docker inspect -f '{{.Config.User}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}' "$c" \
    | grep -qE '^(10001:10001|70:70) \[ALL\] \[no-new-privileges:true\] [1-9][0-9]+ [1-9][0-9]+$' || fail "$c is not confined"
done
[ "$(docker exec household-pr-1-app-1 id -u)" = 10001 ] || fail "pr-1's app runs as root"
echo "a preview finds and reaches no house container, no Hindsight, no internet (not even DNS) and not Caddy's ask; it runs confined, with its own secrets; the house's Caddy, the public front, is the one house container on its network; none of the house's secrets or files in one"

step "a third preview: the budget (600 MB, two previews) is full, so the oldest, pr-1, is removed"
"$lib/household-preview.sh" "preview 3 ${pr[3]}" < /dev/null | tee "$work/pr-3.log"
grep -q "^evicted pr-1: " "$work/pr-3.log" || fail "pr-1 was not evicted"
[ -z "$(docker ps -aq --filter name='^household-pr-1-')" ] || fail "pr-1's containers are still there"
[ -z "$(docker volume ls -q --filter label=com.docker.compose.project=household-pr-1)" ] || fail "pr-1's volumes are still there"
! docker image inspect "localhost:5000/household-preview@${pr[1]}" > /dev/null 2>&1 || fail "pr-1's image is still there"
gone "pr-1" || fail "pr-1's URL still reaches a preview"
for n in 2 3; do [ "$(https "pr-$n.preview.localhost" /healthz)" = ok ] || fail "pr-$n is not up"; done
total=0
for c in $(docker ps -q --filter name='^household-pr-'); do total=$((total + $(docker inspect -f '{{.HostConfig.Memory}}' "$c") / 1048576)); done
[ "$total" -le 600 ] || fail "previews may use ${total} MB together"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(docker ps -q --filter name='^household-pr-')
echo "pr-1 removed; pr-2 and pr-3 up; their caps add up to ${total} MB"

step "a new push to a PR: a fresh practice household, and no eviction"
docker exec household-pr-2-postgres-1 psql -U postgres -qc "create database only_old_pr_2" > /dev/null
"$lib/household-preview.sh" "preview 2 ${pr[2]}" < /dev/null > "$work/pr-2b.log"
[ "$(docker exec household-pr-2-postgres-1 psql -U postgres -tAc "select count(*) from pg_database where datname = 'only_old_pr_2'")" = 0 ] || fail "the new pr-2 kept the old one's database"
! grep -q "^evicted" "$work/pr-2b.log" || fail "redeploying pr-2 evicted another preview"
[ "$(https pr-3.preview.localhost /healthz)" = ok ] || fail "pr-3 went down"
[ -n "$(login_cookie pr-2.preview.localhost priya practice)" ] || fail "priya cannot log in to the new pr-2"
echo "pr-2 redeployed fresh; pr-3 untouched"

step "closing a PR removes its preview"
"$lib/household-preview.sh" "preview-stop 3" < /dev/null | grep -qx "removed pr-3" || fail "preview-stop 3 failed"
[ -z "$(docker ps -aq --filter name='^household-pr-3-')" ] || fail "pr-3's containers are still there"
[ -z "$(docker volume ls -q --filter label=com.docker.compose.project=household-pr-3)" ] || fail "pr-3's volumes are still there"
[ ! -e "$work/previews/live/pr-3.preview.localhost" ] || fail "pr-3 is still marked live"
gone "pr-3" || fail "pr-3's URL still reaches a preview"
"$lib/household-preview.sh" "preview-stop 3" < /dev/null | grep -qx "removed pr-3" || fail "stopping it again failed"
[ "$(https pr-9.preview.localhost /healthz -o /dev/null -w '%{http_code}')" = 000 ] || fail "a PR with no preview got a certificate"
echo "pr-3 removed, and its URL no longer answers; stopping again is harmless"

step "the real house is untouched throughout"
house_state > "$work/house.after"
diff "$work/house.before" "$work/house.after" || fail "the house changed"
[ "$(https localhost /healthz)" = ok ] || fail "the house is not up"
[ -n "$(login_cookie localhost sam "$house_password")" ] || fail "sam cannot log in to the house"
echo "same containers, never restarted, healthy; same volumes and .env; sam still logs in"
"$lib/household-preview.sh" "preview-stop 2" < /dev/null > /dev/null
step "PASS: household-preview against local Docker"
