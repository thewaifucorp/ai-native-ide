#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:?usage: scripts/install-ci-artifact.sh <artifact-directory>}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="$project_root/.local-install"
staging_root="$project_root/.artifacts/staging/install"

if [[ ! -d "$archive_path" ]]; then
  echo "Artifact directory does not exist: $archive_path" >&2
  exit 1
fi
mkdir -p "$project_root/.artifacts/staging"
rm -rf -- "$staging_root"
cp -R "$archive_path" "$staging_root"
mkdir -p "$(dirname "$install_root")"
rm -rf -- "${install_root}.next"
mv "$staging_root" "${install_root}.next"
rm -rf -- "$install_root"
mv "${install_root}.next" "$install_root"
echo "Installed current CI artifact at $install_root"
