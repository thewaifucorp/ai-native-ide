#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
minimum_kib="${IDE_MIN_FREE_KIB:-8388608}"
available_kib="$(df -Pk "$project_root" | awk 'NR == 2 { print $4 }')"

if [[ -z "$available_kib" || "$available_kib" -lt "$minimum_kib" ]]; then
  echo "Insufficient project-disk space: need ${minimum_kib} KiB free, found ${available_kib:-unknown} KiB." >&2
  exit 1
fi

echo "Space preflight passed: ${available_kib} KiB available at $project_root"

