#!/usr/bin/env bash
# sudo household-email last-confirmation
# HOU-150: prints the code from Gmail's most recent forwarding-confirmation email to orders@, if it came
# in the last hour, and nothing else. Only root runs it (the deploy user's sudo rule doesn't name it).
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
case "${1:-}" in
  last-confirmation)
    grep -qE '^MAIL_DOMAIN=.+' "$HOUSEHOLD_DIR/.env" || { echo "no mail receiver: run deploy/install.sh --mail-domain orders.example.com first" >&2; exit 1; }
    household_compose exec -T mail node mail/last-confirmation.ts
    ;;
  *) echo "usage: household-email last-confirmation" >&2; exit 2 ;;
esac
