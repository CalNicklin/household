#!/usr/bin/env bash
# HOU-150: the house's mail receiver against local Docker, deployed by the real household-deploy with
# MAIL_DOMAIN set, the way the VPS runs it once install.sh is given --mail-domain. Real SMTP into port 25:
# a Gmail-shaped forwarded order (with Google's ARC seal) becomes an arrival on the home screen; spoofed ones are dropped; mail for
# anyone else, relaying and an oversize message are refused; Gmail's forwarding confirmation is what
# `household-email last-confirmation` prints; and the memory cap holds at idle and under a burst.
# The receiver's DNS (SPF, DKIM, DMARC) is answered with test records by scripts/mail-proof.ts in its own
# container, so the receiver's compose file here gets `dns:` and a seat on that container's network; that
# is its only change. Needs Docker, Node, ports 25, 80, 443 and 5000 free, the 10.250.53.0/24 range
# unused, and no `household` compose project on this machine; leaves nothing behind.
#   deploy/test-mail.sh [<ref>]       IMAGE=<local tag> uses an image already built instead of building <ref>
set -euo pipefail
ref="${1:-HEAD}"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
local_image="${IMAGE:-household:test-mail-$$}"
existing="$(docker ps -aq --filter label=com.docker.compose.project=household; docker volume ls -q --filter label=com.docker.compose.project=household)"
if [ -n "$existing" ]; then
  echo "a household compose project already exists here; take it down first. Nothing was touched." >&2
  exit 1
fi
work="$(mktemp -d)"
export HOUSEHOLD_CONF="$work/household.conf"
cleanup() {
  ( cd "$work/srv" 2>/dev/null && HOUSEHOLD_IMAGE=x MAIL_DOMAIN=x EMAIL_WEBHOOK_SECRET=x docker compose -p household -f compose.yml -f compose.mail.yml --env-file .env down -v --remove-orphans > /dev/null 2>&1 ) || true
  docker rm -f household-test-registry household-test-dns > /dev/null 2>&1 || true
  docker network rm household-test-dns > /dev/null 2>&1 || true
  [ -n "${IMAGE:-}" ] || docker image rm -f "$local_image" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() {
  docker logs household-mail-1 2>&1 | grep -E '"event":"mail-' | tail -30 >&2 || true
  echo "FALSE HOU-150: $*" >&2
  exit 1
}

step "the image"
[ -n "${IMAGE:-}" ] || "$repo/deploy/build-image.sh" "$local_image" "$ref"
docker run -d --rm --name household-test-registry -p 127.0.0.1:5000:5000 "${REGISTRY_IMAGE:-registry:2}" > /dev/null
docker tag "$local_image" localhost:5000/household:test
until docker push -q localhost:5000/household:test > /dev/null 2>&1; do sleep 1; done
digest="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:test | cut -d@ -f2)"
docker image rm localhost:5000/household:test > /dev/null

step "the server as install.sh --domain localhost --mail-domain orders.localhost leaves it"
install -d -m 750 "$work/srv"
install -d -o 10001 -m 700 "$work/srv/credentials"
cp "$repo"/deploy/compose.yml "$repo"/deploy/compose.hindsight.yml "$repo"/deploy/compose.mail.yml "$repo"/deploy/Caddyfile "$repo"/deploy/Caddyfile.mail "$work/srv/"
# The one change from the installed file: the receiver asks the test DNS, on a network of its own.
docker network create --subnet 10.250.53.0/24 household-test-dns > /dev/null
sed -i 's|^  mail:$|  mail:\n    dns: ["10.250.53.53"]|; s|^    networks: \[mailhook\]$|    networks: [mailhook, testdns]|' "$work/srv/compose.mail.yml"
printf '  testdns:\n    name: household-test-dns\n    external: true\n' >> "$work/srv/compose.mail.yml"
cat > "$HOUSEHOLD_CONF" <<CONF
HOUSEHOLD_DIR=$work/srv
HOUSEHOLD_REPO=localhost:5000/household
CONF
docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
printf 'HOUSEHOLD_DOMAIN=localhost\nMAIL_DOMAIN=orders.localhost\n' >> "$work/srv/.env"
# No model key here: the practice model reads the order (record_arrival), as the house's model would. The
# real house refuses the practice model (HOU-160) unless a test harness says so by name, as this one does,
# in its own copy of compose.yml: household-deploy refuses a .env that carries it.
sed -i 's/^MODEL_PROVIDER=.*/MODEL_PROVIDER=practice/; s/^MODEL_ID=.*/MODEL_ID=practice-1/' "$work/srv/.env"
sed -i 's|^      PRACTICE: "false"$|      PRACTICE: "false"\n      PRACTICE_MODEL_FOR_TESTS: "yes"|' "$work/srv/compose.yml"
grep -q 'PRACTICE_MODEL_FOR_TESTS: "yes"' "$work/srv/compose.yml" || fail "could not give the test house the practice model"
lib="$work/lib"
install -d "$lib"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"

step "deploy, set up a house whose adult forwards from sam@gmail.com, deploy again"
"$lib/household-deploy.sh" "$digest" < /dev/null > /dev/null
printf '%s' '{"name":"Home","timezone":"Europe/London","latitude":51.45,"longitude":-2.59,"adults":[{"id":"sam","name":"Sam","email":"sam@gmail.com"},{"id":"alex","name":"Alex"}]}' \
  | "$lib/household-setup.sh" > "$work/logins" 2> "$work/setup.err" || { cat "$work/setup.err" >&2; fail "setup failed"; }
"$lib/household-deploy.sh" "$digest" < /dev/null | tee "$work/deploy.log"
grep -q "^deployed " "$work/deploy.log" || fail "deploy did not finish"
[ "$(docker inspect -f '{{.State.Health.Status}}' household-mail-1)" = healthy ] || fail "the mail receiver is not healthy"
docker inspect -f 'mail container: user {{.Config.User}}, read-only {{.HostConfig.ReadonlyRootfs}}, cap_drop {{.HostConfig.CapDrop}}, cap_add {{.HostConfig.CapAdd}}, ports {{json .HostConfig.PortBindings}}' household-mail-1
docker exec household-mail-1 sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/comm)" = node ] && grep -E "^(Uid|CapEff)" $p/status; done; true' | tee "$work/procs"
grep -q $'^Uid:\t10001' "$work/procs" || fail "the receiver does not run as the unprivileged house user"
grep -q $'^CapEff:\t0000000000000000' "$work/procs" || fail "the receiver kept a capability"
for target in postgres:5432 objects:8333 objects:9333 caddy:443 app:3001; do
  docker exec household-mail-1 node -e "const s=require('net').connect(${target##*:},'${target%%:*}');s.setTimeout(3000,()=>process.exit(1));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))" && echo "mail reaches $target" || echo "mail can't reach $target"
done | tee "$work/reach"
[ "$(grep -c "can't reach" "$work/reach")" -eq 4 ] && grep -q "^mail reaches app:3001$" "$work/reach" || fail "the receiver reaches more of the house than the app"

step "STARTTLS with the certificate Caddy got for orders.localhost"
for _ in $(seq 30); do docker exec household-caddy-1 sh -c 'ls /data/caddy/certificates/*/orders.localhost/orders.localhost.crt' > /dev/null 2>&1 && break; sleep 2; done
docker restart household-mail-1 > /dev/null
for _ in $(seq 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' household-mail-1)" = healthy ] && break; sleep 2; done
subject="$(openssl s_client -starttls smtp -connect 127.0.0.1:25 -servername orders.localhost < /dev/null 2> /dev/null | openssl x509 -noout -issuer -ext subjectAltName 2> /dev/null || true)"
echo "$subject"
grep -q "orders.localhost" <<< "$subject" || fail "no STARTTLS with Caddy's certificate for orders.localhost"

step "memory at idle"
sleep 5
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' household-mail-1 | tee "$work/idle"

step "real SMTP into port 25"
subnet="$(docker network inspect household_mailhook --format '{{(index .IPAM.Config 0).Subnet}}')"
( while :; do docker stats --no-stream --format '{{.MemUsage}}' household-mail-1 | cut -d/ -f1; done ) > "$work/mem" 2> /dev/null &
sampler=$!
# Docker's port 25 hands connections over from a gateway on one of the receiver's networks: as far as
# the receiver can tell, those are Google's servers.
node "$repo/scripts/mail-proof.ts" world "$subnet" 10.250.53.0/24 > "$work/world.json"
docker run -d --rm --name household-test-dns --network household-test-dns --ip 10.250.53.53 -v "$repo:/repo:ro" -v "$work/world.json:/world.json:ro" -w /repo node:22-bookworm-slim node scripts/mail-proof.ts dns /world.json > /dev/null
for _ in $(seq 30); do docker logs household-test-dns 2>&1 | grep -q "listening" && break; sleep 1; done
timeout 600 node "$repo/scripts/mail-proof.ts" send "$work/world.json" 25 orders@orders.localhost sam@gmail.com | tee "$work/proof"
kill "$sampler" 2> /dev/null || true
peak="$(sed -nE 's/^ *([0-9.]+)MiB.*/\1/p' "$work/mem" | sort -n | tail -n1)"
echo "mail container memory, peak during the run: ${peak} MiB (cap 128 MiB); OOM-killed: $(docker inspect -f '{{.State.OOMKilled}}' household-mail-1); restarts: $(docker inspect -f '{{.RestartCount}}' household-mail-1)"
result() { grep -F "$1: " "$work/proof" | sed "s|^.*: ||"; }
[ "$(result 'genuine Gmail forward of a Screwfix order')" = '{"mail":250,"rcpts":[250],"data":250}' ] || fail "the forwarded order was not taken"
[ "$(result 'a forward by hand of a Currys order')" = '{"mail":250,"rcpts":[250],"data":250}' ] || fail "the hand-forwarded order was not taken"
for spoof in "spoof: forwarding headers naming the household, from a server that isn't Google" "spoof: From the household person, sent from evil.test" "spoof: a stranger's own Gmail forwarding, headers rewritten to name the household"; do
  [ "$(result "$spoof")" = '{"mail":250,"rcpts":[250],"data":250}' ] || fail "$spoof: not answered 250 (a refusal would bounce to whoever is in the envelope)"
done
[ "$(result 'mail for another recipient here')" = '{"mail":250,"rcpts":[550],"data":null}' ] || fail "mail for another recipient was not refused at RCPT"
[ "$(result 'relay attempt (RCPT to someone elsewhere)')" = '{"mail":250,"rcpts":[550,550],"data":null}' ] || fail "a relay attempt was not refused"
[ "$(result 'oversize message (5.3 MB)')" = '{"mail":250,"rcpts":[250],"data":552}' ] || fail "an oversize message was not refused"
[ "$(result 'three sessions at once from one address (greetings)')" = '[220,220,421]' ] || fail "one address held more than two sessions"
[ "$(result 'burst of 40 x 1 MB (data replies)')" = '[["250",40]]' ] || fail "the burst was not all taken"
[ "$(docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' household-mail-1)" = "false 0" ] || fail "the receiver ran out of memory"

step "what the receiver logged"
docker logs household-mail-1 2>&1 | grep -E '"event":"mail-' | sort | uniq -c | sed -E 's/^ +//' | tee "$work/mail-log"

step "the app: Arriving rows for Screwfix and Currys, nothing for the spoofs"
# CAP-9's Arriving row, as the parcels domain keeps it. (The home screen draws it as an Arriving block
# from tomorrow's plan, but planning a day needs the weather service, which this sandbox can't reach.)
arrivals=""
for _ in $(seq 30); do
  arrivals="$(docker exec household-postgres-1 psql -U postgres -d home_parcels -tAc "select shop, expected_date, time_window, needs_someone_in, person from arrivals order by created_at")"
  [ "$(grep -cE '^(Screwfix|Currys)\|' <<< "$arrivals")" -eq 2 ] && break
  sleep 2
done
echo "$arrivals"
[ -n "$arrivals" ] || { docker logs household-app-1 2>&1 | grep -vE '^\s+at ' | tail -15 >&2; fail "no arrivals at all"; }
grep -qE "^Screwfix\|$(date -u -d tomorrow +%F)\|8am–1pm\|t\|sam$" <<< "$arrivals" || fail "no Arriving row for sam's forwarded Screwfix order (tomorrow, 8am–1pm, someone in)"
grep -qE "^Currys\|$(date -u -d tomorrow +%F)\|10am–2pm\|f\|sam$" <<< "$arrivals" || fail "no Arriving row named after the shop for sam's forward by hand"
[ "$(wc -l <<< "$arrivals")" -eq 2 ] || fail "a spoofed order became an arrival"
grep -E '"event":"dropped-unknown-sender"' <(docker logs household-app-1 2>&1) | sort | uniq -c || fail "the app did not drop and log the stranger"

step "household-email last-confirmation"
printed="$("$lib/household-email.sh" last-confirmation)"
echo "$printed"
code="$(head -n1 <<< "$printed")"
[ "$code" = 693452117 ] || fail "household-email printed '$code', not Gmail's code"
grep -qxF 'https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc' <<< "$printed" || fail "household-email didn't print Gmail's confirmation link"
step "PASS: HOU-150 against local Docker"
