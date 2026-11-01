#!/usr/bin/env bash
# sudo household-status
# HOU-160: which image is deployed, whether the app is up and healthy, and which model it is using (asked
# inside the running app container, so it is what that container started with). Prints no secret.
# Exit 0 when the app is running and healthy.
source "$(dirname "$(readlink -f "$0")")/household-common.sh"
[ $# -eq 0 ] || { echo "usage: sudo household-status" >&2; exit 2; }
image="$(deployed_image)"
echo "image: ${image:-nothing deployed yet}"
export HOUSEHOLD_IMAGE="${image:-none}"
id="$(household_compose ps -q app 2> /dev/null || true)"
[ -n "$id" ] || { echo "app: not running"; exit 1; }
health="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")"
echo "app: $health"
household_compose exec -T app node scripts/house-status.ts
[ "$health" = "running healthy" ]
