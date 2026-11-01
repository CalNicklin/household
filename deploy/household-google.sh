#!/usr/bin/env bash
# sudo household-google check
# HOU-147: is Google Calendar connected? Refreshes a token, lists the calendars it can see (names and IDs,
# no events) and says when the watch ends, in the deployed image with the house's own settings and
# credentials. It prints no token. Exit 0 when everything is right.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
[ "${1:-}" = check ] && [ $# -eq 1 ] || { echo "usage: sudo household-google check" >&2; exit 2; }
image="$(deployed_image)"
[ -n "$image" ] || { echo "nothing deployed yet: push to main (or re-run the deploy workflow) first" >&2; exit 1; }
export HOUSEHOLD_IMAGE="$image"
household_compose run --rm -T --no-deps app node scripts/google-check.ts
