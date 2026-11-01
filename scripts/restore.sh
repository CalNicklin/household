#!/usr/bin/env bash
# PLT-8: restore a backup made by scripts/backup.sh onto this server, replacing what is there.
#   scripts/restore.sh backups/<timestamp>
# On the server: sudo household-restore /var/backups/household/<timestamp> (the same steps, against the
# production project).
set -euo pipefail
dir="$(cd "${1:?usage: scripts/restore.sh backups/<timestamp>}" && pwd)"
read -r -a compose <<< "${COMPOSE:-docker compose}"
( cd "$dir" && sha256sum -c SHA256SUMS )
# The app (and the helper, where it runs) stop so nothing writes during the restore.
mapfile -t writers < <("${compose[@]}" config --services | grep -xE 'app|helper')
"${compose[@]}" stop "${writers[@]}"
"${compose[@]}" up -d postgres objects
until "${compose[@]}" exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
"${compose[@]}" exec -T postgres psql -q -U postgres -d postgres -v ON_ERROR_STOP=0 < "$dir/postgres.sql" > /dev/null
"${compose[@]}" stop objects
docker run --rm --memory 64m -v household_objects:/data -v "$dir:/backup:ro" --entrypoint sh postgres:16-alpine -c 'rm -rf /data/* && tar xzf /backup/objects.tgz -C /data'
"${compose[@]}" up -d
echo "restored from $dir"
