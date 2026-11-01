#!/usr/bin/env bash
# PLT-8: back up everything about the house — every Postgres database (all domains, DBOS) and the
# object store's volume (screenshots and documents, already encrypted). Run from the repo root.
#   scripts/backup.sh            → backups/<UTC timestamp>/
# On the server, household-backup runs this nightly with COMPOSE set to the production project and
# BACKUP_ROOT to the configured destination.
set -euo pipefail
read -r -a compose <<< "${COMPOSE:-docker compose}"
dir="${BACKUP_ROOT:-backups}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dir"
"${compose[@]}" exec -T postgres pg_dumpall -U postgres --clean --if-exists > "$dir/postgres.sql"
# Object storage is copied while stopped, so the volume files are consistent (a few seconds).
"${compose[@]}" stop objects
trap '"${compose[@]}" start objects' EXIT
docker run --rm --memory 64m -v household_objects:/data:ro -v "$(cd "$dir" && pwd):/backup" --entrypoint tar postgres:16-alpine czf /backup/objects.tgz -C /data .
"${compose[@]}" start objects
trap - EXIT
( cd "$dir" && sha256sum postgres.sql objects.tgz > SHA256SUMS )
echo "backed up to $dir"
