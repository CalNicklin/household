#!/usr/bin/env bash
# PLT-8: restore a backup made by scripts/backup.sh onto this server, replacing what is there.
#   scripts/restore.sh backups/<timestamp>
set -euo pipefail
dir="${1:?usage: scripts/restore.sh backups/<timestamp>}"
( cd "$dir" && sha256sum -c SHA256SUMS )
docker compose stop app helper
docker compose up -d postgres objects
until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker compose exec -T postgres psql -q -U postgres -d postgres -v ON_ERROR_STOP=0 < "$dir/postgres.sql" > /dev/null
docker compose stop objects
docker run --rm -v household_objects:/data -v "$PWD/$dir:/backup:ro" --entrypoint sh postgres:16-alpine -c 'rm -rf /data/* && tar xzf /backup/objects.tgz -C /data'
docker compose up -d
echo "restored from $dir"
