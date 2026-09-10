# shellcheck shell=bash
# "This artifact corresponds to a commit" gate, shared by the two scripts that ship one:
# deploy/build.sh (the relay image) and scripts/dfx-deploy-ic.sh (the facade wasm). Sourced,
# not executed.
#
# Both compile the WORKING TREE rather than a `git archive`, and both then claim a commit: the
# relay image bakes `git rev-parse HEAD` into GET /api/v1/version (crates/dpay-relay/build.rs),
# and a facade upgrade is recorded against a commit in docs/UPGRADES.md. Built from a dirty
# tree those claims are false — which is how prod became unidentifiable on 2026-09-08, when
# /api/v1/version reported `20133499…-dirty` and nothing could say what was running.
#
# Until 2026-09-10 the answer was to REFUSE a dirty tree. The founder called the friction off
# that day ("we shouldn't have this friction"): whatever is in the tree is what ships, so the
# tree is now MADE a commit instead — the artifact stays attributable to exactly one commit
# (the same guarantee the refusal bought) without a mandatory manual commit standing between
# an operator and every deploy. The `-dirty` marker itself stays exactly as meaningful as it
# was: an image reporting it was built before this gate existed, and its source is unknown.

# committed_tree_for ARTIFACT — if the working tree is dirty, commit it (exactly the set
# `git status --porcelain` lists — staged + unstaged changes to tracked files, plus
# non-ignored untracked files; the same set this build compiles and embeds), then return. The
# porcelain test is byte for byte the one crates/dpay-relay/build.rs uses to choose `<sha>`
# over `<sha>-dirty`, so this gate and that marker can never disagree: after it runs, the tree
# is clean and the baked marker is the bare sha. git's own ignore rules keep target/, .dev/,
# vendor/, third_party/, deploy/.env and every build output out of it.
committed_tree_for() {
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

  if ! git add -A || ! git commit -q \
      -m "ship: auto-commit the working tree for $artifact" \
      -m "The tree was dirty at build time (HEAD was $head). Whatever is in the tree is what
ships, so it was committed here rather than refused — founder friction call 2026-09-10.
If that included the deploy-ic pin deploy/facade-module-hash.txt, record its
docs/UPGRADES.md row in a follow-up commit."; then
    echo "REFUSED: the tree is dirty and the auto-commit failed — fix git (identity? hooks?), then re-run." >&2
    exit 1
  fi
  echo "== tree was dirty — auto-committed as $(git rev-parse --short HEAD) so $artifact corresponds to a commit =="
  printf '%s\n' "$dirty" | sed 's/^/    /'
  echo "    (nothing else to do; the deploy proceeds from that commit)"
}
