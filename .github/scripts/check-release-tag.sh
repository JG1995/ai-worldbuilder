#!/usr/bin/env bash
# Fails when the release tag (GITHUB_REF_NAME, such as v0.1.0) does not match the
# version in package.json, so a mismatched tag never produces a release.
set -euo pipefail

tag_version="${GITHUB_REF_NAME#v}"
package_version="$(node -p "require('./package.json').version")"

if [[ "$tag_version" != "$package_version" ]]; then
  echo "Tag ${GITHUB_REF_NAME} is version ${tag_version}, but package.json has version ${package_version}." >&2
  exit 1
fi

echo "Tag ${GITHUB_REF_NAME} matches package.json version ${package_version}."
