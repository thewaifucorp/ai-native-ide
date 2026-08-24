#!/usr/bin/env bash
set -euo pipefail

bundle_root="${1:-target/release/bundle}"
mapfile -t packages < <(find "$bundle_root" -type f -name '*.deb' -print)

if [[ "${#packages[@]}" -ne 1 ]]; then
  echo "Expected exactly one Linux .deb in $bundle_root, found ${#packages[@]}" >&2
  exit 1
fi

package_path="${packages[0]}"
staging_root="$(mktemp -d)"
trap 'rm -rf -- "$staging_root"' EXIT

dpkg-deb -x "$package_path" "$staging_root"
binary_path="$staging_root/usr/bin/ai-native-ide-desktop"

if [[ ! -x "$binary_path" ]]; then
  echo "Installed desktop binary is missing or not executable: $binary_path" >&2
  exit 1
fi

echo "artifact=$(basename "$package_path")"
du -h "$package_path"

# A healthy Tauri desktop process remains alive for the bounded probe. A clean
# timeout is therefore success; an early exit exposes a packaging/runtime fault.
set +e
timeout 8 xvfb-run -a "$binary_path" >"$staging_root/desktop.log" 2>&1
status=$?
set -e
if [[ "$status" -ne 124 ]]; then
  cat "$staging_root/desktop.log" >&2
  echo "Desktop artifact exited before the 8-second smoke window (status $status)" >&2
  exit 1
fi

echo "Tauri Linux artifact stayed live for the smoke window."
