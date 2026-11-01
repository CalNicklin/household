#!/usr/bin/env bash
# PLT-8, FB-5 (HOU-145): build the household image the way deploy.yml and preview.yml build it, and load
# it into local Docker as <tag>. Like the workflow: the committed tree at <ref> (a fresh checkout has
# nothing untracked), the repo's Dockerfile and .dockerignore, on a BuildKit builder running in its own
# container (docker/setup-buildx-action's docker-container driver), never the Docker daemon's built-in
# builder. HOU-138's runs used `docker build .` from a working tree instead.
#   deploy/build-image.sh household:local [<ref>]
# BUILDX_BUILDER=<name> uses an existing docker-container builder (e.g. one set up for a proxy or a
# registry mirror) instead of a throwaway one. Behind a TLS-intercepting proxy, NPM_CA=<ca.pem> passes the
# proxy's CA to the Dockerfile's npm_ca secret.
set -euo pipefail
tag="${1:?usage: deploy/build-image.sh <tag> [<ref>]}"
ref="${2:-HEAD}"
repo="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
work="$(mktemp -d)"
builder="${BUILDX_BUILDER:-}"
own_builder=""
cleanup() {
  [ -z "$own_builder" ] || docker buildx rm -f "$own_builder" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
git -C "$repo" archive --format=tar "$ref" | tar -x -C "$work"
if [ -z "$builder" ]; then
  own_builder="household-build-$$"
  builder="$own_builder"
  docker buildx create --name "$builder" --driver docker-container > /dev/null
fi
driver="$(docker buildx inspect "$builder" | sed -nE 's/^Driver: +//p' | head -n1)"
[ "$driver" = docker-container ] || { echo "builder $builder uses the $driver driver; the workflow's uses docker-container" >&2; exit 1; }
secret=()
[ -z "${NPM_CA:-}" ] || secret=(--secret "id=npm_ca,src=$NPM_CA")
docker buildx build --builder "$builder" ${secret[@]+"${secret[@]}"} --load -t "$tag" "$work"
