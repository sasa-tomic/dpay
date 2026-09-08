# shellcheck shell=bash
# "This artifact corresponds to a commit" gate, shared by the two scripts that ship one:
# deploy/build.sh (the relay image) and scripts/dfx-deploy-ic.sh (the facade wasm). Sourced, not
# executed.
#
# Both compile the WORKING TREE rather than a `git archive`, and both then claim a commit: the
# relay image bakes `git rev-parse HEAD` into GET /api/v1/version (crates/dpay-relay/build.rs),
# and a facade upgrade is recorded against a commit in docs/UPGRADES.md. Built from a dirty tree
# those claims are false — which is how prod became unidentifiable on 2026-09-08, when
# /api/v1/version reported `20133499…-dirty` and nothing could say what was running.
#
# There is deliberately NO override variable. "Ship it anyway" is the exact outcome being removed:
# an artifact that matches no commit is not something to label, it is something to refuse.

# require_clean_tree ARTIFACT — abort (exit 1) unless the working tree is clean, naming every
# offending path and the command that fixes it. `git status --porcelain` IS the test, byte for byte
# the one crates/dpay-relay/build.rs uses to choose `<sha>` over `<sha>-dirty`, so this gate and
# that marker can never disagree: staged + unstaged changes to tracked files, plus non-ignored
# untracked files (the relay embeds e2e/dist-prod, built from the tree, so an untracked source file
# really does ship). git's own ignore rules keep target/, .dev/, vendor/, third_party/ and every
# build output out of it.
require_clean_tree() {
  local artifact="$1" head dirty
  head="$(git rev-parse HEAD)" || {
    echo "REFUSED: this is not a git checkout (git rev-parse HEAD failed), so there is no commit" >&2
    echo "         to attribute $artifact to. Build from a checkout." >&2
    exit 1
  }
  dirty="$(git status --porcelain)" || {
    echo "REFUSED: \`git status --porcelain\` failed — it is the test that decides whether" >&2
    echo "         $artifact corresponds to a commit. Fix git before shipping." >&2
    exit 1
  }
  [ -n "$dirty" ] || return 0

  echo "REFUSED: the working tree is dirty, so $artifact would correspond to NO commit." >&2
  echo >&2
  printf '%s\n' "$dirty" | sed 's/^/    /' >&2
  echo >&2
  echo "  HEAD is $head, but this build compiles the tree above — so nothing that names that" >&2
  echo "  commit (GET /api/v1/version for the image, the docs/UPGRADES.md row for the facade)" >&2
  echo "  would describe what actually shipped." >&2
  echo >&2
  echo "  Commit everything (whatever is in the tree is what ships), then re-run:" >&2
  echo "      git add -A && git commit -m '<what changed>'" >&2
  echo >&2
  echo "  Just ran 'just deploy-ic'? It re-bakes the TRACKED pin deploy/facade-module-hash.txt;" >&2
  echo "  commit that together with its docs/UPGRADES.md row. Full sequence: docs/OPS.md section 3." >&2
  exit 1
}
