#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
allowed_paths=(
  "$project_root/target"
  "$project_root/apps/desktop/dist"
  "$project_root/.artifacts/staging"
  "$project_root/.artifacts/downloads"
)

for path in "${allowed_paths[@]}"; do
  case "$path" in
    "$project_root"/*) ;;
    *) echo "Refusing cleanup outside project: $path" >&2; exit 1 ;;
  esac
  if [[ -d "$path" ]]; then
    rm -rf -- "$path"
    echo "Removed $path"
  fi
done

