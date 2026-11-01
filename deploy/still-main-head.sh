#!/usr/bin/env bash
# deploy/still-main-head.sh <sha>: the deploy workflow's one check that <sha> is still main's head, asked
# before the build and again right before SSH. Writes current=true|false to $GITHUB_OUTPUT. CI runs once
# per push and can finish out of order, so only main's newest commit is ever deployed.
set -euo pipefail
sha="${1:?usage: deploy/still-main-head.sh <sha>}"
main="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)"
if [ "$main" = "$sha" ]; then
  echo "current=true" >> "$GITHUB_OUTPUT"
else
  echo "current=false" >> "$GITHUB_OUTPUT"
  echo "::notice title=Deploy skipped::$sha is no longer main's head ($main); the run for $main deploys that."
fi
