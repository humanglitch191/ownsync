#!/usr/bin/env bash
# Signs a release with the release key, then checks it the way Workers' updaters will. Doesn't push.
# First bump the version (node scripts/sync-manifest.mjs 0.2.0) and commit. Usage: scripts/sign-release.sh 0.2.0
set -euo pipefail
v=${1:?usage: scripts/sign-release.sh <version, e.g. 0.2.0>}
fail() { echo "$*" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Versions look like 0.2.0."
[ "$(git branch --show-current)" = main ] || fail "Not on main."
[ -z "$(git status --porcelain)" ] || fail "The working tree isn't clean."
grep -q "\"version\": \"$v\"" plugin/manifest.json || fail "plugin/manifest.json isn't at $v."
grep -qx "export const VERSION = \"$v\";" server/src/dashboard.ts || fail "server/src/dashboard.ts isn't at $v."
git -c gpg.format=ssh tag -s "$v" -m "$v"
scripts/verify-release-tag.sh "$v" > /dev/null || { git tag -d "$v" > /dev/null; fail "Deleted tag $v: it doesn't pass the updater's check."; }
echo "Signed $v. Publish it with: git push origin main $v"
