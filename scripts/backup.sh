#!/usr/bin/env bash
# PLT-8: back up everything about the house — every Postgres database (all domains, DBOS) and the
# object store's volume (screenshots and documents, already encrypted). Run from the repo root on the server.
#   scripts/backup.sh            → backups/<UTC timestamp>/
set -euo pipefail
dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dir"
docker compose exec -T postgres pg_dumpall -U postgres --clean --if-exists > "$dir/postgres.sql"
# Object storage is copied while stopped, so the volume files are consistent (a few seconds).
docker compose stop objects
docker run --rm -v household_objects:/data:ro -v "$PWD/$dir:/backup" --entrypoint tar postgres:16-alpine czf /backup/objects.tgz -C /data .
docker compose start objects
( cd "$dir" && sha256sum postgres.sql objects.tgz > SHA256SUMS )
echo "backed up to $dir"
