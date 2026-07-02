#!/usr/bin/env bash
# Changesets "publish" step: build & push the crab'd action image for the current
# version, tag the commit, and cut a GitHub release. Runs after the "Version Packages"
# PR is merged (no pending changesets). Idempotent — skips if the tag already exists.
set -euo pipefail

VERSION="$(node -p "require('./packages/action/package.json').version")"
TAG="v${VERSION}"
MAJOR="v${VERSION%%.*}"
IMAGE="ghcr.io/${GITHUB_REPOSITORY:-louisescher/crabd}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "release-image: ${TAG} already released — nothing to do."
  exit 0
fi

echo "release-image: publishing ${IMAGE}:${TAG} (+ ${MAJOR}, latest)"
docker buildx build --push \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:${MAJOR}" \
  -t "${IMAGE}:latest" \
  --cache-from type=gha \
  --cache-to type=gha,mode=max \
  .

git tag "${TAG}"
git push origin "${TAG}"
gh release create "${TAG}" --title "${TAG}" --generate-notes || true
