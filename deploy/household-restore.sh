#!/usr/bin/env bash
# sudo household-restore /var/backups/household/<timestamp>
# docs/OPERATIONS.md's restore (scripts/restore.sh), against the production project.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
image="$(deployed_image)"
[ -n "$image" ] || { echo "deploy once first, so there is an app to restore into" >&2; exit 1; }
export HOUSEHOLD_IMAGE="$image"
# HOU-175: the restore starts the house again, so never with a Caddy whose other apps' sites are invalid.
sites_valid || { echo "fix or remove that file in $SITES_DIR, then run this again; nothing was restored" >&2; exit 1; }
# The object store's login file is made from .env, which may just have been put back from the password
# manager (a new server): remake it from this .env, so storage and the app agree. Keeps every value.
docker run --rm --network none --memory 128m --user 0 -v "$HOUSEHOLD_DIR:/work" -w /work --entrypoint node "$image" /app/scripts/env-init.ts --real > /dev/null
chmod 600 "$HOUSEHOLD_DIR/.env"
"$HOUSEHOLD_LIB/restore.sh" "${1:?usage: household-restore <backup directory>}"
