#!/usr/bin/env bash
# Installs the packaged Linux artifact into a throwaway root and measures it
# live on a virtual display: packaging size, idle memory, host process shape,
# and clean shutdown with no orphaned children. Thresholds turn the smoke test
# into a real viability measurement rather than a liveness-only probe.
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

pkg_bytes="$(stat -c%s "$package_path")"
echo "artifact=$(basename "$package_path")"
echo "packaging.deb_bytes=$pkg_bytes"
du -h "$package_path"

# Ergonomics: a single-host desktop bundle stays lean. A bundle beyond this
# ceiling signals a second runtime creeping in.
max_pkg_bytes=$((300 * 1024 * 1024))
if (( pkg_bytes > max_pkg_bytes )); then
  echo "Bundle exceeds ergonomics ceiling ($pkg_bytes > $max_pkg_bytes bytes)" >&2
  exit 1
fi

# Only the extracted binary's own processes count as the host; webkit helpers
# and the xvfb-run wrapper have different executables and are excluded by exe.
app_pids() {
  local pid exe
  for pid in $(pgrep -f -- "$binary_path" 2>/dev/null || true); do
    exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    if [[ "$exe" == "$binary_path" ]]; then
      echo "$pid"
    fi
  done
}

sum_rss_kb() {
  local total=0 pid rss
  for pid in $(app_pids); do
    rss="$(awk '/^VmRSS:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || true)"
    [[ -n "$rss" ]] && total=$(( total + rss ))
  done
  echo "$total"
}

count_app_procs() {
  app_pids | grep -c . || true
}

xvfb-run -a "$binary_path" >"$staging_root/desktop.log" 2>&1 &
launcher_pid=$!

# Wait for the host process to present itself.
started=0
for _ in $(seq 1 10); do
  if [[ "$(count_app_procs)" -ge 1 ]]; then
    started=1
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if (( started == 0 )); then
  cat "$staging_root/desktop.log" >&2
  echo "Desktop artifact never presented a live host process." >&2
  exit 1
fi

peak_rss_kb=0
peak_procs=0
for _ in $(seq 1 6); do
  rss="$(sum_rss_kb)"
  procs="$(count_app_procs)"
  (( rss > peak_rss_kb )) && peak_rss_kb=$rss
  (( procs > peak_procs )) && peak_procs=$procs
  sleep 1
done

# The host must still be alive after the measurement window: an early exit is a
# packaging/runtime fault, exactly as the previous liveness-only probe caught.
if [[ "$(count_app_procs)" -lt 1 ]]; then
  cat "$staging_root/desktop.log" >&2
  echo "Desktop host exited before the measurement window ended." >&2
  exit 1
fi

# Tear the host down and confirm it does not orphan children.
for pid in $(app_pids); do
  kill "$pid" 2>/dev/null || true
done
kill "$launcher_pid" 2>/dev/null || true
wait "$launcher_pid" 2>/dev/null || true
sleep 1
orphans="$(count_app_procs)"

echo "consumption.peak_rss_kb=$peak_rss_kb"
echo "performance.host_processes=$peak_procs"
echo "ergonomics.orphans_after_shutdown=$orphans"

if (( peak_rss_kb == 0 )); then
  echo "Failed to sample host memory." >&2
  exit 1
fi

# Consumption ceiling for the idle host on a virtual display.
max_rss_kb=$((1200 * 1024))
if (( peak_rss_kb > max_rss_kb )); then
  echo "Host idle memory exceeded ceiling (${peak_rss_kb} KB > ${max_rss_kb} KB)" >&2
  exit 1
fi

if (( orphans != 0 )); then
  echo "Host left $orphans orphan process(es) after shutdown." >&2
  exit 1
fi

echo "Tauri Linux artifact measured live: packaging, memory, process shape, and clean shutdown within budget."
