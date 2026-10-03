#!/bin/bash

# Publish each docket's downloadable databases (<docket>-slim.sqlite.zip, <docket>-full.sqlite.zip)
# as assets of one GitHub release instead of inside the Pages site.
#
# Why: CI rebuilds the whole site on every push, so zips inside it would ship (and be stored as a
# workflow artifact) again on every deploy, and the largest are over 100 MB. Release assets have
# stable URLs (https://github.com/<repo>/releases/download/<tag>/<file>), one copy per file name.
# The export is deterministic (same database + same export code = same bytes), so each zip is
# compared with the asset's SHA-256 digest and uploaded only when it changed.
#
# Build the site with DATA_DOWNLOADS_URL set to that URL prefix so meta.json and the skill link to
# the release; then run this, then delete the zips from the site before deploying.
#
# Usage: scripts/publish-data-packs.sh [site-dir] [--dry-run]
# Env: GH_TOKEN (contents: write), GITHUB_REPOSITORY (owner/repo; defaults to the gh repo),
#      DATA_RELEASE_TAG (default analysis-databases)

set -euo pipefail

SITE_DIR="dist"
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        *) SITE_DIR="$arg" ;;
    esac
done

TAG="${DATA_RELEASE_TAG:-analysis-databases}"
REPO="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

mapfile -d '' zips < <(find "$SITE_DIR" -type f -name '*.sqlite.zip' -print0 | sort -z)
if [ "${#zips[@]}" -eq 0 ]; then
    echo "No *.sqlite.zip files under $SITE_DIR; nothing to publish"
    exit 0
fi

# name -> digest ("sha256:<hex>") of the assets already in the release
declare -A remote=()
if gh api "repos/$REPO/releases/tags/$TAG" >/dev/null 2>&1; then
    while read -r name digest; do
        [ -n "$name" ] && remote["$name"]="$digest"
    done < <(gh api "repos/$REPO/releases/tags/$TAG" --jq '.assets[] | "\(.name) \(.digest // "")"')
elif [ "$DRY_RUN" = true ]; then
    echo "Release $TAG does not exist in $REPO (would create it)"
else
    echo "Creating release $TAG in $REPO"
    gh release create "$TAG" --repo "$REPO" --title "Analysis databases" --latest=false \
        --notes "Downloadable SQLite analysis databases for each docket, linked from each dashboard's Overview and the AI skill. Updated automatically by CI when a docket's export changes; file names are stable."
fi

# Asset names are flat, so two different files with one name would overwrite each other; check
# before uploading anything
declare -A sha_of=() path_of=()
for zip in "${zips[@]}"; do
    name=$(basename "$zip")
    sha=$(sha256sum "$zip" | cut -d' ' -f1)
    if [ -n "${sha_of[$name]:-}" ] && [ "${sha_of[$name]}" != "$sha" ]; then
        echo "Two different files are named $name ($zip, ${path_of[$name]}); refusing to publish" >&2
        exit 1
    fi
    sha_of["$name"]="$sha"
    path_of["$name"]="$zip"
done

uploaded=0
unchanged=0
for name in $(printf '%s\n' "${!sha_of[@]}" | sort); do
    zip="${path_of[$name]}"
    sha="${sha_of[$name]}"
    if [ "${remote[$name]:-}" = "sha256:$sha" ]; then
        unchanged=$((unchanged + 1))
        continue
    fi
    size=$(du -h "$zip" | cut -f1)
    if [ "$DRY_RUN" = true ]; then
        echo "Would upload $name ($size)${remote[$name]:+, replacing a different version}"
    else
        echo "Uploading $name ($size)${remote[$name]:+, replacing a different version}"
        gh release upload "$TAG" "$zip" --repo "$REPO" --clobber
    fi
    uploaded=$((uploaded + 1))
done

echo "Release $TAG: $uploaded uploaded, $unchanged unchanged"
