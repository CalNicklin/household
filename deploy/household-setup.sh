#!/usr/bin/env bash
# sudo household-setup < house.json
# Sets up the real house once (PLT-8), with the image household-deploy put in place, then starts it.
# Prints each adult's generated app password once, to this terminal only.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
refuse_test_only_settings
image="$(deployed_image)"
[ -n "$image" ] || { echo "nothing deployed yet: push to main (or re-run the deploy workflow) first" >&2; exit 1; }
export HOUSEHOLD_IMAGE="$image"
household_compose up -d --wait --wait-timeout 180 postgres objects
household_compose run --rm -T --no-deps app node scripts/house-setup.ts
household_compose up -d --wait --wait-timeout 300
echo "up: https://$(grep -E '^HOUSEHOLD_DOMAIN=' "$HOUSEHOLD_DIR/.env" | cut -d= -f2-)/"
