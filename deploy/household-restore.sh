#!/usr/bin/env bash
# sudo household-restore /var/backups/household/<timestamp>
# docs/OPERATIONS.md's restore (scripts/restore.sh), against the production project.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
image="$(deployed_image)"
[ -n "$image" ] || { echo "deploy once first, so there is an app to restore into" >&2; exit 1; }
export HOUSEHOLD_IMAGE="$image"
COMPOSE="${HOUSEHOLD_COMPOSE[*]}" "$HOUSEHOLD_LIB/restore.sh" "${1:?usage: household-restore <backup directory>}"
