#!/usr/bin/env bash
# sudo household-telegram connect | status | senders | set <person> <telegram user id>
# CH-2 / CH-3: connect the real house to its Telegram bot (docs/OPERATIONS.md, "Telegram"). Each command
# runs scripts/telegram.ts in the app's image, which reads the bot token and the webhook secret from the
# house's .env through compose's env file: neither is ever on a command line (`ps` shows only the words
# below) or printed.
#   connect   point the bot's webhook at https://<HOUSEHOLD_DOMAIN>/webhooks/telegram with the secret
#   status    which bot, and where its webhook points
#   senders   Telegram user IDs the house dropped (unknown senders), newest first, to find your own
#   set       give an adult their Telegram ID; it reaches the house from the next message
source "$(dirname "$(readlink -f "$0")")/household-common.sh"

usage() {
  echo "usage: household-telegram connect | status | senders | set <person> <telegram user id>" >&2
  exit 2
}
case "${1:-}" in
  connect | status | senders) [ $# -eq 1 ] || usage ;;
  set) [ $# -eq 3 ] && [[ "$2" =~ ^[a-z][a-z0-9-]{0,62}$ ]] && [[ "$3" =~ ^[1-9][0-9]{0,15}$ ]] || usage ;;
  *) usage ;;
esac

image="$(deployed_image)"
[ -n "$image" ] || { echo "nothing deployed yet: push to main (or re-run the deploy workflow) first" >&2; exit 1; }
export HOUSEHOLD_IMAGE="$image"
# The house must be running: senders and set use its database, and connect is for a house Telegram can reach.
household_compose run --rm -T --no-deps app node scripts/telegram.ts "$@"
