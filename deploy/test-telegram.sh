#!/usr/bin/env bash
# CH-2 / CH-3 (HOU-146): run the real `household-telegram` against a real house on local Docker, the way
# the VPS runs it (household-deploy, household-setup, Caddy in front), with a stand-in for
# api.telegram.org on the house's network. Like test-deploy.sh it needs Docker, ports 80, 443 and 5000
# free and no `household` compose project here, builds the image from the committed tree at <ref>
# (deploy/build-image.sh; its BUILDX_BUILDER and NPM_CA apply), and leaves nothing behind.
#   deploy/test-telegram.sh [<ref>]
set -euo pipefail
ref="${1:-HEAD}"
local_image="household:test-telegram-$$"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
existing="$(docker ps -aq --filter label=com.docker.compose.project=household; docker volume ls -q --filter label=com.docker.compose.project=household)"
if [ -n "$existing" ] || docker volume inspect household_objects > /dev/null 2>&1; then
  echo "a household compose project (containers or volumes) already exists here; take it down first, or run this on another machine. Nothing was touched." >&2
  exit 1
fi
work="$(mktemp -d)"
export HOUSEHOLD_CONF="$work/household.conf"
cleanup() {
  docker rm -f household-test-telegram-api > /dev/null 2>&1 || true
  ( cd "$work/srv" 2>/dev/null && HOUSEHOLD_IMAGE=x docker compose -p household -f compose.yml --env-file .env down -v --remove-orphans > /dev/null 2>&1 ) || true
  docker rm -f household-test-registry > /dev/null 2>&1 || true
  docker image rm -f "$local_image" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FALSE CH-3: $*" >&2; exit 1; }
# A made-up token: the stand-in accepts only this one.
token="424242:test-telegram-stand-in-token"

step "the image, built as deploy.yml builds it"
"$repo/deploy/build-image.sh" "$local_image" "$ref"
docker run -d --rm --name household-test-registry -p 127.0.0.1:5000:5000 "${REGISTRY_IMAGE:-registry:2}" > /dev/null
docker tag "$local_image" localhost:5000/household:test
until docker push -q localhost:5000/household:test > /dev/null 2>&1; do sleep 1; done
digest="$(docker image inspect --format '{{index .RepoDigests 0}}' localhost:5000/household:test | cut -d@ -f2)"
docker image rm localhost:5000/household:test > /dev/null

step "the server as install.sh leaves it, deployed and set up (Sam with no Telegram ID yet)"
install -d -m 750 "$work/srv"
install -d -o 10001 -m 700 "$work/srv/credentials"
cp "$repo"/deploy/compose.yml "$repo"/deploy/compose.hindsight.yml "$repo"/deploy/Caddyfile "$work/srv/"
printf 'HOUSEHOLD_DIR=%s\nHOUSEHOLD_REPO=localhost:5000/household\n' "$work/srv" > "$HOUSEHOLD_CONF"
docker run --rm --network none --memory 128m -v "$repo/scripts/env-init.ts:/env-init.ts:ro" -v "$work/srv:/work" -w /work node:22-bookworm-slim node /env-init.ts --real > /dev/null
echo "HOUSEHOLD_DOMAIN=localhost" >> "$work/srv/.env"
lib="$work/lib"
install -d "$lib"
install -m 755 "$repo"/deploy/household-*.sh "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$lib/"
"$lib/household-deploy.sh" "$digest" < /dev/null > /dev/null || true
printf '%s' '{"name":"Home","timezone":"Europe/London","latitude":51.45,"longitude":-2.59,"adults":[{"id":"sam","name":"Sam"},{"id":"alex","name":"Alex","telegram":"700000002"}]}' \
  | "$lib/household-setup.sh" > /dev/null 2> "$work/setup.err" || { cat "$work/setup.err" >&2; fail "setup failed"; }

step "household-telegram before there is a token"
set +e; "$lib/household-telegram.sh" connect > "$work/notoken.out" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && grep -q "TELEGRAM_BOT_TOKEN is not set" "$work/notoken.out" || { cat "$work/notoken.out"; fail "connect without a token exited $rc"; }
for bad in "connect now" "set sam" "set sam 12x" "set Sam 1" "senders; id"; do
  set +e; read -ra words <<< "$bad"; "$lib/household-telegram.sh" "${words[@]}" > /dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 2 ] || fail "household-telegram accepted '$bad' (exit $rc)"
done
echo "no token: says what to do; 5 bad command lines refused"

step "a stand-in for api.telegram.org on the house's network; the token goes in .env, then a redeploy"
cat > "$work/telegram-api.mjs" <<'JS'
import { createServer } from "node:http";
const token = process.env.STANDIN_TOKEN;
let webhook = { url: "", allowed: undefined };
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const [, t, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url) ?? [];
    const send = (status, answer) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); };
    console.log(JSON.stringify({ method, tokenOk: t === token, body: body === "" ? {} : JSON.parse(body) }));
    if (t !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return send(200, { ok: true, result: { id: 424242, is_bot: true, username: "house_stand_in_bot" } });
    if (method === "setWebhook") { const b = JSON.parse(body); webhook = { url: b.url, allowed: b.allowed_updates }; return send(200, { ok: true, result: true }); }
    if (method === "getWebhookInfo") return send(200, { ok: true, result: { url: webhook.url, pending_update_count: 0, ...(webhook.allowed ? { allowed_updates: webhook.allowed } : {}) } });
    if (method === "sendMessage") return send(200, { ok: true, result: { message_id: 1 } });
    return send(404, { ok: false, description: "Not Found" });
  });
}).listen(8081);
JS
chmod 644 "$work/telegram-api.mjs"
docker run -d --rm --name household-test-telegram-api --network household_default --network-alias telegram-api -e STANDIN_TOKEN="$token" -v "$work/telegram-api.mjs:/api.mjs:ro" node:22-bookworm-slim node /api.mjs > /dev/null
printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_API_BASE=http://telegram-api:8081\n' "$token" >> "$work/srv/.env"
"$lib/household-deploy.sh" "$digest" < /dev/null > "$work/deploy.log" || { cat "$work/deploy.log"; fail "redeploy with the token failed"; }

step "sudo household-telegram status, then connect"
set +e; "$lib/household-telegram.sh" status > "$work/status0.out" 2>&1; rc=$?; set -e
cat "$work/status0.out"
[ "$rc" -eq 1 ] && grep -q "^webhook: not set$" "$work/status0.out" || fail "status before connect exited $rc"
"$lib/household-telegram.sh" connect 2>&1 | tee "$work/connect.out"
grep -qx "webhook: https://localhost/webhooks/telegram (this house)" "$work/connect.out" || fail "connect did not point the webhook at the house"
grep -qx "updates: message, callback_query" "$work/connect.out" || fail "connect asked for other updates"
secret="$(grep '^TELEGRAM_WEBHOOK_SECRET=' "$work/srv/.env" | cut -d= -f2-)"
docker logs household-test-telegram-api 2>&1 | grep '"method":"setWebhook"' | grep -qF "\"secret_token\":\"$secret\"" || fail "setWebhook did not carry the house's secret"
for f in "$work"/*.out; do
  if grep -qF -e "$token" -e "$secret" "$f"; then fail "$(basename "$f") printed the token or the secret"; fi
done
echo "the stand-in saw setWebhook with the secret; nothing printed the token or the secret"

step "Telegram delivering: a stranger is dropped and gets no reply; senders shows their ID"
printf 'x-telegram-bot-api-secret-token: %s\n' "$secret" > "$work/header"
deliver() { curl -sk -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H @"$work/header" -d "{\"update_id\":$1,\"message\":{\"chat\":{\"id\":$2},\"from\":{\"id\":$2},\"text\":\"$3\"}}" https://localhost/webhooks/telegram; }
person_for() { docker compose -p household -f "$work/srv/compose.yml" --env-file "$work/srv/.env" exec -T postgres psql -U postgres -d home_jobs -tAc "select coalesce(person, '-') from messages where dedupe_key = 'telegram:update:$1'"; }
code="$(curl -sk -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'x-telegram-bot-api-secret-token: wrong' -d '{"update_id":1}' https://localhost/webhooks/telegram)"
[ "$code" = 401 ] || fail "a wrong secret got $code"
[ "$(deliver 101 700000001 'hi it is sam')" = 200 ] || fail "delivery refused"
sleep 1
[ -z "$(person_for 101)" ] || fail "the stranger's message was stored"
docker logs household-test-telegram-api 2>&1 | grep '"method":"sendMessage"' | grep -q 700000001 && fail "the house replied to a stranger"
"$lib/household-telegram.sh" senders | tee "$work/senders.out"
grep -qE '^  700000001  last \S+  once$' "$work/senders.out" || fail "senders did not show the stranger's ID"
grep -q "hi it is sam" "$work/senders.out" && fail "senders printed what the stranger said"

step "set gives Sam that ID: Sam's next message reaches the house as Sam"
"$lib/household-telegram.sh" set sam 700000001 | tee "$work/set.out"
grep -q "sam's Telegram ID is now 700000001" "$work/set.out" || fail "set did not confirm"
set +e; "$lib/household-telegram.sh" set sam 700000002 > "$work/taken.out" 2>&1; rc=$?; set -e
[ "$rc" -eq 1 ] && grep -q "already alex's" "$work/taken.out" || fail "set gave sam alex's ID (exit $rc)"
[ "$(deliver 102 700000001 'we need to oil the squeaky door')" = 200 ] || fail "delivery refused"
[ "$(deliver 103 700000002 'and buy bin bags')" = 200 ] || fail "delivery refused"
for _ in $(seq 20); do [ -n "$(person_for 103)" ] && break; sleep 0.5; done
[ "$(person_for 102)" = sam ] || fail "sam's message did not reach the house as sam"
[ "$(person_for 103)" = alex ] || fail "alex's message (ID from house.json) did not reach the house as alex"
docker logs household-app-1 2>&1 | grep -c '"event":"dropped-unknown-sender"' | xargs printf 'dropped-unknown-sender log lines: %s\n'
"$lib/household-telegram.sh" status > "$work/status1.out" || fail "status not connected at the end"
for f in "$work"/*.out; do
  if grep -qF -e "$token" -e "$secret" "$f"; then fail "$(basename "$f") printed the token or the secret"; fi
done
step "PASS: household-telegram connect, status, senders and set against a real house on local Docker"
