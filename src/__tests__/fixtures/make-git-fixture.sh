#!/usr/bin/env bash
# Copy the .planning fixture into a temp dir and give it the atomic task commits GSD's executor
# would have produced, so gsdState's live-execution path can be tested end to end.
set -e
DEST=$(mktemp -d /tmp/codedeck-gsd-git.XXXXXX)
cp -r "$(dirname "$0")/gsd-project/.planning" "$DEST/.planning"
cd "$DEST"
git init -q && git config user.email t@t && git config user.name t
git add -A && git commit -qm "chore: seed planning"
git commit -q --allow-empty -m "feat(02-01): scaffold the build step"
git commit -q --allow-empty -m "test(02-01): cover the build step"
git commit -q --allow-empty -m "chore: unrelated work that must be ignored"
echo "$DEST"
