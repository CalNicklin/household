#!/bin/sh
# HOU-150: the mail receiver's entrypoint (deploy/compose.mail.yml). It starts as root with no
# capabilities but SETUID and SETGID, only so it can read Caddy's certificate for MAIL_DOMAIN (Caddy
# keeps its keys root-only, mounted here read-only). It copies that one certificate and key into the
# container's own memory-backed /run/mail-tls, checks for a new one every ten minutes, and runs the receiver
# itself as the image's unprivileged `house` user, which never sees the rest of Caddy's data.
set -eu
case "${MAIL_DOMAIN:-}" in
  "" | *[!a-z0-9.-]*) echo "MAIL_DOMAIN must be a lowercase host name" >&2; exit 2 ;;
esac
tls=/run/mail-tls
copy_certificate() {
  # Caddy's file storage: certificates/<issuer>/<name>/<name>.crt and .key; the newest issuer wins.
  crt="$(ls -t /caddy-data/caddy/certificates/*/"$MAIL_DOMAIN"/"$MAIL_DOMAIN".crt 2> /dev/null | head -n1 || true)"
  [ -n "$crt" ] && [ -f "${crt%.crt}.key" ] || return 0
  if cmp -s "$crt" "$tls/cert.pem" 2> /dev/null; then return 0; fi
  install -m 644 "${crt%.crt}.key" "$tls/key.pem.new" && mv "$tls/key.pem.new" "$tls/key.pem"
  install -m 644 "$crt" "$tls/cert.pem.new" && mv "$tls/cert.pem.new" "$tls/cert.pem"
}
copy_certificate
( while sleep 600; do copy_certificate; done ) &
exec setpriv --reuid="$(id -u house)" --regid="$(id -g house)" --clear-groups --inh-caps=-all node mail/main.ts
