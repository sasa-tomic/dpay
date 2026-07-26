# shellcheck shell=bash
# Shared deploy/.env read/write for the dpay deploy scripts (tunnel-provision.sh, dfx-deploy-ic.sh).
# Sourced, not executed. One place that knows how to edit deploy/.env in place, so each script does
# not reimplement it: every other line is preserved; a key is replaced if present, appended if not.

# env_get KEY FILE  ->  prints KEY's value (text after the first '='), empty if absent. Last wins.
env_get() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1
}

# env_set KEY VALUE FILE  ->  set KEY=VALUE in FILE. Creates FILE from a sibling .env.example if it
# is missing, replaces an existing KEY= line in place, appends otherwise, and keeps FILE mode 600.
env_set() {
  local key="$1" value="$2" file="$3"
  if [ ! -f "$file" ]; then
    local example
    example="$(dirname "$file")/.env.example"
    if [ -f "$example" ]; then cp "$example" "$file"; else : >"$file"; fi
  fi
  local tmp; tmp="$(mktemp)"
  # keep every line that isn't this key; grep exit 1 (no match) is fine, any other non-zero aborts.
  grep -v "^${key}=" "$file" >"$tmp" || [ "$?" -eq 1 ]
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}
