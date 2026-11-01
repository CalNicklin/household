#!/usr/bin/env bash
# deploy/preview-comment.sh <PR number> <file with the comment's body>
# FB-5: the preview workflow's one comment on a PR, kept up to date: it edits its own earlier comment
# (marked <!-- household-preview -->) rather than adding another. Needs GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail
pr="${1:?usage: deploy/preview-comment.sh <PR number> <body file>}"
body_file="${2:?usage: deploy/preview-comment.sh <PR number> <body file>}"
[[ "$pr" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "not a PR number: $pr" >&2; exit 2; }
marker='<!-- household-preview -->'
body="$(printf '%s\n%s' "$marker" "$(cat "$body_file")")"
id="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$pr/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | tail -n1)"
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" > /dev/null
else
  gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" -f body="$body" > /dev/null
fi
