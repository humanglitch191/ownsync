#!/usr/bin/env bash
# Checks a release tag the way every Worker's updater does: annotated, naming itself, and signed with the release
# key in server/.github/workflows/update-ownsync.yml. Prints the commit it signs. Usage: scripts/verify-release-tag.sh 0.2.0
set -euo pipefail
tag=${1:?usage: scripts/verify-release-tag.sh <version>}
fail() { echo "$tag: $*" >&2; exit 1; }
signers=$(mktemp)
trap 'rm -f "$signers"' EXIT
grep -o '^ *\* namespaces="git" .*' "$(git rev-parse --show-toplevel)/server/.github/workflows/update-ownsync.yml" | sed 's/^ *//' > "$signers" \
  || fail "no release key in server/.github/workflows/update-ownsync.yml"
if grep -q PLACEHOLDER "$signers"; then fail "the release key in server/.github/workflows/update-ownsync.yml is still a placeholder"; fi
[ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null)" = tag ] || fail "not an annotated tag"
head=$(git cat-file tag "refs/tags/$tag" | sed '/^$/q')
{ grep -qx "type commit" <<<"$head" && grep -qx "tag $tag" <<<"$head"; } || fail "the tag object is for something else"
git -c gpg.program=false -c gpg.x509.program=false -c gpg.ssh.allowedSignersFile="$signers" verify-tag "refs/tags/$tag" \
  || fail "not signed with the release key"
sed -n 's/^object //p' <<<"$head"
