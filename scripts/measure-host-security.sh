#!/usr/bin/env bash
# Measures the security surface that the packaged host enforces on the renderer.
# This is a real measurement of what ships in the artifact: the renderer only
# ever reaches native features through the allowlisted capability set and a
# restrictive CSP. Any drift beyond the allowlist is a structural blocker.
set -euo pipefail

root_dir="${1:-apps/desktop/src-tauri}"
capabilities_file="$root_dir/capabilities/default.json"
config_file="$root_dir/tauri.conf.json"

for f in "$capabilities_file" "$config_file"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing host config: $f" >&2
    exit 1
  fi
done

# The renderer capability set must stay minimal. Only the core surface and the
# opener are allowed; any filesystem/shell/http/process permission granted to
# the renderer is a privilege-boundary blocker.
allowed_permissions='["core:default","opener:default"]'
actual_permissions="$(jq -c '.permissions | sort' "$capabilities_file")"
expected_permissions="$(printf '%s' "$allowed_permissions" | jq -c 'sort')"

if [[ "$actual_permissions" != "$expected_permissions" ]]; then
  echo "Renderer capability set drifted from the allowlist." >&2
  echo "  expected: $expected_permissions" >&2
  echo "  actual:   $actual_permissions" >&2
  exit 1
fi

forbidden='fs:|shell:|http:|process:|dialog:|clipboard-manager:|websocket:'
if jq -r '.permissions[]' "$capabilities_file" | grep -Eiq "$forbidden"; then
  echo "Renderer capability set grants a forbidden native permission." >&2
  exit 1
fi

# The CSP must not open eval or wildcard remote origins to the renderer.
csp="$(jq -r '.app.security.csp // ""' "$config_file")"
if [[ -z "$csp" ]]; then
  echo "Host CSP is empty; the renderer would run without a content policy." >&2
  exit 1
fi
if grep -Eiq "unsafe-eval|default-src[^;]*\*|connect-src[^;]*(https?://\*|[^;]* \* )" <<<"$csp"; then
  echo "Host CSP is too permissive: $csp" >&2
  exit 1
fi

echo "security.permissions=$actual_permissions"
echo "security.csp_present=true"
echo "security.csp_eval=false"
echo "Host security surface measured within the allowlist."
