//! Bake the current git commit into the relay binary at compile time so the live `/api/v1/version`
//! endpoint can report EXACTLY which source the running image was built from. This is the
//! deploy-fidelity primitive: comparing the live commit to `git rev-parse HEAD` catches a stale image
//! shipping while `just check` is green (the bug class `verify-deploy.sh` closes for the canister).
//!
//! - Feature-unconditional: the prod image carries it too (the `agent` feature is not required).
//! - Falls back to `"unknown"` if `git` is absent or this isn't a git checkout (e.g. a release
//!   tarball), so the build never fails just because git isn't reachable.
//! - Reruns when `.git/HEAD` changes (a new commit lands) so the baked commit is always current.
use std::process::Command;

fn main() {
    // Rerun when the ref moves (a commit advances HEAD). A missing .git/HEAD (release tarball) is
    // harmless — cargo simply never triggers the rerun on it, and the fallback below applies.
    println!("cargo:rerun-if-changed=.git/HEAD");

    let commit = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=DPAY_BUILD_COMMIT={commit}");
}
