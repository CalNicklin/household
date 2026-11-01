#!/usr/bin/env bash
# household-backup: the nightly backup (household-backup.timer), also safe to run by hand.
# The same procedure as scripts/backup.sh (PLT-8), against the production project, into BACKUP_DEST,
# keeping the newest BACKUP_KEEP; then copied to BACKUP_REMOTE (an rsync target) when one is set.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
image="$(deployed_image)"
[ -n "$image" ] || { echo "nothing deployed yet; nothing to back up"; exit 0; }
export HOUSEHOLD_IMAGE="$image"
mkdir -p "$BACKUP_DEST"
COMPOSE="${HOUSEHOLD_COMPOSE[*]}" BACKUP_ROOT="$BACKUP_DEST" "$HOUSEHOLD_LIB/backup.sh"
find "$BACKUP_DEST" -mindepth 1 -maxdepth 1 -type d -name '2*Z' | sort | head -n "-$BACKUP_KEEP" | xargs -r rm -rf
if [ -n "$BACKUP_REMOTE" ]; then rsync -a --delete "$BACKUP_DEST/" "$BACKUP_REMOTE/"; fi
