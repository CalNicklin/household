#!/usr/bin/env bash
# PLT-8: run the real household-deploy (and household-setup, -status, -backup, -restore) against local Docker,
# the way the VPS runs them, with a local registry standing in for GHCR. Needs Docker and ports 80, 443
# and 5000 free, and no `household` compose project on this machine (it would be the same project: it
# refuses rather than touch one); leaves nothing behind.
# It builds the image itself with deploy/build-image.sh, the way the workflows do (HOU-145), from the
# committed tree at <ref> (default HEAD); that script's BUILDX_BUILDER and NPM_CA apply.
#   deploy/test-deploy.sh [<ref>]
set -euo pipefail
ref="${1:-HEAD}"
local_image="household:test-deploy-$$"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# The production project is named `household`, like the dev stack in docker-compose.yml. Its containers
# and volumes are only ever ours to remove when this run made them.
existing="$(docker ps -aq --filter label=com.docker.compose.project=household; docker volume ls -q --filter label=com.docker.compose.project=household)"
if [ -n "$existing" ] || docker volume inspect household_objects > /dev/null 2>&1; then
  echo "a household compose project (containers or volumes) already exists here; take it down first (docker compose down), or run this on another machine. Nothing was touched." >&2
  exit 1
fi
work="$(mktemp -d)"
export HOUSEHOLD_CONF="$work/household.conf"
cleanup() {
  ( cd "$work/srv" 2>/dev/null && HOUSEHOLD_IMAGE=x docker compose -p household -f compose.yml --env-file .env down -v --remove-orphans > /dev/null 2>&1 ) || true
  docker rm -f household-test-registry > /dev/null 2>&1 || true
  docker image rm -f "$local_image" > /dev/null 2>&1 || true
  [ -z "${stub:-}" ] || kill "$stub" 2> /dev/null || true
  rm -rf "$work" "${sites_root:-}"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FALSE PLT-8: $*" >&2; exit 1; }

step "the image, built as deploy.yml and preview.yml build it"
"$repo/deploy/build-image.sh" "$local_image" "$ref"

step "a registry standing in for GHCR, holding the image CI would have pushed"
docker run -d --rm --name household-test-registry -p 127.0.0.1:5000:5000 "${REGISTRY_IMAGE:-registry:2}" > /dev/null
docker tag "$local_image" localhost:5000/household:test
until docker push -q localhost:5000/household:test > /dev/null 2>&1; do sleep 1; done
digest="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:test | cut -d@ -f2)"
docker image rm localhost:5000/household:test > /dev/null
echo "pushed $digest"

step "the server as install.sh leaves it: deploy files, settings, secrets generated in place"
install -d -m 750 "$work/srv"
install -d -o 10001 -m 700 "$work/srv/credentials"
cp "$repo"/deploy/compose.yml "$repo"/deploy/compose.hindsight.yml "$repo"/deploy/compose.caddy-sites.yml "$repo"/deploy/Caddyfile "$work/srv/"
# HOU-175: where the trader side's *.caddy files would be; it doesn't exist until the sites step below.
sites_root="$(mktemp -d)"
chmod 755 "$sites_root"
sites="$sites_root/sites"
cat > "$HOUSEHOLD_CONF" <<CONF
HOUSEHOLD_DIR=$work/srv
HOUSEHOLD_REPO=localhost:5000/household
BACKUP_DEST=$work/backups
BACKUP_KEEP=1
SITES_DIR=$sites
CONF
docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
echo "HOUSEHOLD_DOMAIN=localhost" >> "$work/srv/.env"
# HOU-160: the real house needs its model's key; no call is made with it here.
# HOU-168: a stand-in key made up per run, so no key-shaped literal is in the repo.
model_key="stand-in-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
echo "ANTHROPIC_API_KEY=$model_key" >> "$work/srv/.env"
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
docker logs household-app-1 2>&1 | grep -q 'ports-missing-credentials.*shopping (no helper: nothing is added)' || fail "the app did not say it runs without a helper"
echo "healthy behind Caddy; login works; no helper"
[ "$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}{{.HostConfig.ExtraHosts}}' household-caddy-1)" = "/config /data /etc/caddy/Caddyfile []" ] || fail "with no sites directory, Caddy has more than the house's mounts or hosts (HOU-175)"

step "HOU-160: a .env the new image refuses never takes the house down: the old container keeps running"
# Built FROM the image above, so on the Docker daemon's own builder, which can see it (not BUILDX_BUILDER's).
printf 'FROM %s\nLABEL household.test=next\n' "$local_image" | env -u BUILDX_BUILDER docker build -q -t localhost:5000/household:next - > /dev/null
docker push -q localhost:5000/household:next > /dev/null
next="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:next | cut -d@ -f2)"
docker image rm localhost:5000/household:next > /dev/null
running="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' household-app-1)"
cp "$work/srv/.env" "$work/env.good"
n=0
refused() { # <what> <expected line>: deploy $next with this .env; it must refuse and change nothing
  n=$((n + 1)); log="$work/refused-$n.log"
  set +e; "$lib/household-deploy.sh" "$next" < /dev/null > "$log" 2>&1; rc=$?; set -e
  [ "$rc" -eq 1 ] || { cat "$log" >&2; fail "household-deploy took $1 (exit $rc)"; }
  grep -q "\"event\":\"settings-refused\".*$2" "$log" || { cat "$log" >&2; fail "no settings-refused line for $1"; }
  grep -q "refuses $work/srv/.env, so it was not started; the house keeps running localhost:5000/household@$digest" "$log" || fail "household-deploy did not say the house keeps running for $1"
  [ "$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' household-app-1)" = "$running" ] || fail "the running app was replaced or restarted for $1"
  [ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] || fail "the app is not healthy after $1"
  [ "$(curl -sk --resolve localhost:443:127.0.0.1 https://localhost/healthz)" = ok ] || fail "healthz after $1"
  [ "$(cat "$work/srv/image")" = "localhost:5000/household@$digest" ] || fail "$1 was recorded as deployed"
  echo "refused $1; the house kept running"
}
# A .env as install.sh wrote it before HOU-148: no MODEL_PROVIDER or MODEL_ID, so the practice model.
grep -vE '^MODEL_(PROVIDER|ID)=' "$work/env.good" > "$work/srv/.env"
refused "an old .env (no MODEL_PROVIDER)" "will not run on the practice model: set MODEL_PROVIDER=anthropic"
sed 's/^MODEL_PROVIDER=.*/MODEL_PROVIDER=practice/' "$work/env.good" > "$work/srv/.env"
refused "MODEL_PROVIDER=practice" "will not run on the practice model"
sed 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=/' "$work/env.good" > "$work/srv/.env"
refused "no ANTHROPIC_API_KEY" "MODEL_PROVIDER=anthropic needs ANTHROPIC_API_KEY"

step "HOU-160: the practice model's test-only opt-in never reaches the real house: household-deploy and -setup refuse it"
cp "$work/env.good" "$work/srv/.env"
echo "PRACTICE_MODEL_FOR_TESTS=yes" >> "$work/srv/.env"
for cmd in "household-deploy.sh $next" household-setup.sh; do
  set +e; "$lib/"$cmd < /dev/null > "$work/test-flag.log" 2>&1; rc=$?; set -e
  [ "$rc" -eq 1 ] || { cat "$work/test-flag.log" >&2; fail "${cmd%% *} took a .env with PRACTICE_MODEL_FOR_TESTS (exit $rc)"; }
  grep -q "sets PRACTICE_MODEL_FOR_TESTS, which is for Docker test harnesses only; delete that line" "$work/test-flag.log" || fail "${cmd%% *} did not say how to fix it"
done
[ "$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' household-app-1)" = "$running" ] || fail "the running app was touched for PRACTICE_MODEL_FOR_TESTS"
[ "$(cat "$work/srv/image")" = "localhost:5000/household@$digest" ] || fail "an image was recorded for PRACTICE_MODEL_FOR_TESTS"
echo "refused PRACTICE_MODEL_FOR_TESTS in .env; the house kept running"

step "HOU-160: install.sh's env-init fills in what an old .env lacks, changing nothing already there"
grep -vE '^MODEL_(PROVIDER|ID)=' "$work/env.good" > "$work/srv/.env"
cp "$work/srv/.env" "$work/env.old"
added="$(docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real | sed -n 's/^added to .env: //p')"
[ "$added" = "MODEL_PROVIDER, MODEL_ID" ] || fail "env-init added '$added' to an old .env"
[ "$(head -c "$(wc -c < "$work/env.old")" "$work/srv/.env")" = "$(cat "$work/env.old")" ] || fail "env-init changed a line already in .env"
[ "$(tail -n 2 "$work/srv/.env")" = "$(printf 'MODEL_PROVIDER=anthropic\nMODEL_ID=claude-opus-5-5')" ] || fail "env-init did not add the real model"
"$lib/household-deploy.sh" "$next" < /dev/null | tee "$work/deploy-next.log"
grep -q "^deployed localhost:5000/household@$next" "$work/deploy-next.log" || fail "the filled-in .env did not deploy"
digest="$next"

step "HOU-160: household-status says which model the running house uses"
"$lib/household-status.sh" | tee "$work/status.log" || fail "household-status said the house is not healthy"
grep -qx "image: localhost:5000/household@$digest" "$work/status.log" || fail "household-status image"
grep -qx "app: running healthy" "$work/status.log" || fail "household-status app"
grep -qx "model: anthropic claude-opus-5-5 (ANTHROPIC_API_KEY set)" "$work/status.log" || fail "household-status model"
docker logs household-app-1 2>&1 | grep -q '"event":"listening".*"model":"anthropic claude-opus-5-5 (ANTHROPIC_API_KEY set)"' || fail "the app did not log its model at start"

step "a broken image never replaces a working one: household-deploy rolls back"
# On the daemon's own builder, like the image above (it is built FROM the local image).
printf 'FROM %s\nCMD ["node", "-e", "process.exit(1)"]\n' "$local_image" | env -u BUILDX_BUILDER docker build -q -t localhost:5000/household:broken - > /dev/null
docker push -q localhost:5000/household:broken > /dev/null
broken="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:broken | cut -d@ -f2)"
docker image rm localhost:5000/household:broken > /dev/null
set +e; "$lib/household-deploy.sh" "$broken" < /dev/null > "$work/deploy3.log" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] || fail "deploying a broken image exited $rc"
grep -q "rolled back to localhost:5000/household@$digest" "$work/deploy3.log" || fail "no rollback"
[ "$(cat "$work/srv/image")" = "localhost:5000/household@$digest" ] || fail "the broken image was recorded as deployed"
[ "$(curl -sk https://localhost/healthz)" = ok ] || fail "not healthy after the rollback"
echo "the broken image failed its health check; rolled back to the working one"

step "HOU-175: other apps' sites on the house's Caddy, only from a directory root alone can write, validated first"
caddy_now() { docker inspect -f '{{.Id}} {{.State.StartedAt}}' household-caddy-1; }
deploy_sites() { # <log name>: redeploy the running image; its exit code
  set +e; "$lib/household-deploy.sh" "$digest" < /dev/null > "$work/$1.log" 2>&1; local rc=$?; set -e
  return "$rc"
}
# The trader side's stand-in: a server on the host, listening only on the address host-gateway names.
gateway="$(docker run --rm --add-host host.docker.internal:host-gateway --entrypoint getent caddy:2.10.2-alpine hosts host.docker.internal | cut -d' ' -f1)"
[ -n "$gateway" ] || fail "no host-gateway address"
port=38470
node -e 'require("http").createServer((q,r)=>r.end("trader stub "+q.headers.host)).listen(+process.argv[2],process.argv[1])' "$gateway" "$port" &
stub=$!
for _ in $(seq 20); do curl -sf "http://$gateway:$port/" > /dev/null && break; sleep 0.5; done
# A login made up for this run, put in front of the site the way docs/OPERATIONS.md recommends.
site_password="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
site_hash="$(printf '%s\n%s\n' "$site_password" "$site_password" | docker run --rm -i caddy:2.10.2-alpine caddy hash-password | tail -n1)"
[[ "$site_hash" == '$2'* ]] || fail "caddy hash-password gave no bcrypt hash"
trader="$(printf 'trader.localhost {\n\tbasic_auth {\n\t\tcal %s\n\t}\n\treverse_proxy host.docker.internal:%s\n}\n' "$site_hash" "$port")"
house_ok() { [ "$(curl -sk --resolve localhost:443:127.0.0.1 https://localhost/healthz)" = ok ] || fail "the house stopped serving: $1"; }
trader_code() { curl -sk -o /dev/null -w '%{http_code}' --resolve trader.localhost:443:127.0.0.1 "$@" https://trader.localhost/; }

# A directory someone besides root can write: left out, and the house deploys exactly as before.
before="$(caddy_now)"
install -d -m 775 "$sites"
printf '%s' "$trader" > "$sites/trader.caddy"
deploy_sites sites-unsafe || { cat "$work/sites-unsafe.log" >&2; fail "a deploy with an unsafe sites directory failed"; }
grep -q "^note: $sites is not root's alone" "$work/sites-unsafe.log" || fail "no note about the group-writable directory"
chmod 755 "$sites"; chown 1000 "$sites/trader.caddy"
deploy_sites sites-unsafe-file || fail "a deploy with a site file root doesn't own failed"
grep -q "^note: $sites/trader.caddy is not a root-owned file" "$work/sites-unsafe-file.log" || fail "no note about the file root doesn't own"
chown 0 "$sites/trader.caddy"; ln -s /etc/hostname "$sites/link.caddy"
deploy_sites sites-symlink || fail "a deploy with a symlinked site failed"
grep -q "^note: $sites/link.caddy is not a root-owned file" "$work/sites-symlink.log" || fail "no note about the symlink"
rm "$sites/link.caddy"
[ "$(caddy_now)" = "$before" ] || fail "Caddy was recreated while the sites directory was unsafe"
echo "an unsafe directory, a file root doesn't own, and a symlink were each left out; Caddy untouched"

# The deploy user (any user but root) can't add a site.
chmod 644 "$sites/trader.caddy"
if setpriv --reuid=65534 --regid=65534 --clear-groups sh -c "echo x > '$sites/evil.caddy'" 2> /dev/null; then fail "a non-root user could add a site"; fi
if setpriv --reuid=65534 --regid=65534 --clear-groups sh -c "echo x >> '$sites/trader.caddy'" 2> /dev/null; then fail "a non-root user could change a site"; fi
echo "a non-root user can neither add nor change a site"

# A valid site: Caddy is recreated with it, and serves it (behind its login) next to the house.
deploy_sites sites-valid || { cat "$work/sites-valid.log" >&2; fail "a deploy with a valid site failed"; }
grep -q "^caddy config with $sites is valid$" "$work/sites-valid.log" || fail "the deploy did not validate the sites"
[ "$(docker inspect -f '{{.HostConfig.ExtraHosts}}' household-caddy-1)" = "[host.docker.internal:host-gateway]" ] || fail "Caddy has no host-gateway name"
docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/sites"}}{{.Source}} {{.RW}}{{end}}{{end}}' household-caddy-1 | grep -qx "$sites false" || fail "the sites are not mounted read-only"
for _ in $(seq 30); do [ "$(trader_code)" = 401 ] && break; sleep 1; done
[ "$(trader_code)" = 401 ] || fail "the trader site answered $(trader_code) without its login"
[ "$(curl -sk --resolve trader.localhost:443:127.0.0.1 -u "cal:$site_password" https://trader.localhost/)" = "trader stub trader.localhost" ] || fail "the trader site did not reach the stub on the host"
house_ok "with a valid site"
echo "trader.localhost reaches the stub on $gateway:$port through Caddy, behind its login; the house serves as before"

# An invalid site: the deploy refuses before switching anything, names the file, and nothing stops serving.
before="$(caddy_now)"
printf 'monitor.localhost {\n\tnot_a_directive\n}\n' > "$sites/monitor.caddy"
if deploy_sites sites-invalid; then fail "a deploy with an invalid site went ahead"; fi
grep -q "^Error: .*$sites/monitor.caddy:2: unrecognized directive: not_a_directive" "$work/sites-invalid.log" || { cat "$work/sites-invalid.log" >&2; fail "the refusal did not name the invalid file"; }
grep -q "nothing was switched; the house keeps running localhost:5000/household@$digest" "$work/sites-invalid.log" || fail "the refusal did not say the house carries on"
[ "$(caddy_now)" = "$before" ] || fail "Caddy was touched by an invalid site"
house_ok "with an invalid site"
[ "$(curl -sk --resolve trader.localhost:443:127.0.0.1 -u "cal:$site_password" https://trader.localhost/)" = "trader stub trader.localhost" ] || fail "the valid site stopped serving"
echo "an invalid site was refused, naming $sites/monitor.caddy:2; Caddy, the house and the valid site carried on"

# No sites again: the house goes back to exactly its own Caddy.
rm "$sites"/*.caddy
deploy_sites sites-none || fail "a deploy with an empty sites directory failed"
[ "$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}{{.HostConfig.ExtraHosts}}' household-caddy-1)" = "/config /data /etc/caddy/Caddyfile []" ] || fail "Caddy kept the sites after they were removed"
house_ok "after the sites were removed"
[ "$(trader_code)" != 401 ] || fail "the trader site is still served"
if grep -lF -e "$site_password" "$work"/*.log; then fail "the site's password was printed"; fi
echo "with an empty sites directory Caddy is the house's own again"

step "memory: every container has its cap"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' household-app-1 household-postgres-1 household-objects-1 household-caddy-1

step "household-backup and household-restore"
"$lib/household-backup.sh"
backup="$(find "$work/backups" -mindepth 1 -maxdepth 1 -type d | head -n1)"
( cd "$backup" && sha256sum -c SHA256SUMS > /dev/null ) || fail "backup sums"
# A new server: the old .env comes back from the password manager, so storage's login file (made from the
# new server's .env) no longer matches it. The restore remakes it from .env.
printf '%s' '{"identities":[{"name":"stale","credentials":[{"accessKey":"stale","secretKey":"stale-secret"}],"actions":["Admin"]}]}' > "$work/srv/.secrets/seaweedfs-s3.json"
"$lib/household-restore.sh" "$backup" > /dev/null
grep -q "$(grep '^S3_ACCESS_KEY_ID=' "$work/srv/.env" | cut -d= -f2)" "$work/srv/.secrets/seaweedfs-s3.json" || fail "the restore left storage on another login"
for _ in $(seq 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] && break; sleep 2; done
[ "$(docker inspect -f '{{.State.Health.Status}}' household-app-1)" = healthy ] || fail "app not healthy after the restore"
grep -q '^  sam ' "$work/logins" && [ -n "$(curl -sk -D - -o /dev/null -H 'content-type: application/json' -d "{\"username\":\"sam\",\"password\":\"$password\"}" https://localhost/api/login | grep -i '^set-cookie')" ] || fail "sam's login did not survive the restore"
echo "backed up to $(basename "$backup") and restored; the house came back healthy"
# HOU-160: no deploy, refusal, rollback or status output ever carries the key.
if grep -lF -e "$model_key" "$work"/*.log; then fail "the API key was printed"; fi
step "PASS: household-deploy, -setup, -status, -backup and -restore against local Docker"
