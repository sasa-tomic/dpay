#!/usr/bin/env bash
# Shared-box guard for the heavy gates (flow / e2e / e2e-visual).
#
# Why: this box is SHARED (CI runner, other sessions). On 2026-09-28 a full
# `just flow` acceptance run (4 workers x 16GB heap ceilings) collided with
# the CI runner's rustc builds and locked the machine (founder had to reboot).
#
# Contract (AGENTS.md "Test tiers"):
#   1. MACHINE-WIDE EXCLUSIVE: while one heavy gate runs, any other heavy-gate
#      invocation (from ANY agent/session) refuses instead of stacking.
#   2. LOAD CEILING: refuses to start when the 1-min load average exceeds
#      DPAY_HEAVY_LOAD_MAX (default 20) — the gate would just flake anyway.
#   3. DPAY_FORCE_GATE=1 overrides both. Use deliberately, know why.
#
# Usage: scripts/heavy-gate.sh <gate-name> <command...>
#   The command is exec'd WHILE HOLDING the lock, so the whole run is covered.
set -euo pipefail

name="${1:?usage: heavy-gate.sh <gate-name> <command...>}"; shift

exec 9>/tmp/opencode/dpay-heavy-gate.lock
if ! flock -n 9; then
  echo "heavy-gate[$name]: another heavy gate is running machine-wide — refusing to stack (DPAY_FORCE_GATE=1 overrides)" >&2
  exit 1
fi

if [ "${DPAY_FORCE_GATE:-}" != "1" ]; then
  load="$(cut -d' ' -f1 /proc/loadavg)"
  max="${DPAY_HEAVY_LOAD_MAX:-20}"
  over="$(python3 -c "print(1 if float('$load') > $max else 0)")"
  if [ "$over" = "1" ]; then
    echo "heavy-gate[$name]: 1-min load $load > $max on this shared box — refusing to start (DPAY_FORCE_GATE=1 overrides)" >&2
    exit 1
  fi
fi

# fd 9 (the lock) survives exec — held until the command (and thus the run) exits.
exec "$@"
