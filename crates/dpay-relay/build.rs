//! Build-time baking for dpay-relay:
//!
//! 1. The current git commit (`DPAY_BUILD_COMMIT`) + its committer date (`DPAY_BUILD_DATE`) so
//!    the live `/api/v1/version` endpoint can report EXACTLY which source the running image was
//!    built from and when that source was committed. This is the deploy-fidelity primitive:
//!    comparing the live commit to `git rev-parse HEAD` catches a stale image shipping while
//!    `just check` is green (the bug class `verify-deploy.sh` closes for the canister); the date
//!    is its human-readable half ("when was prod last updated").
//!
//! 2. The prod web build of the REAL app (`e2e/dist-prod`, produced by `just web` /
//!    `vite build --mode web-prod`) → a generated `$OUT_DIR/web_assets.rs` static table the
//!    `/wallet` + `/assets/*` routes serve from. Everything the relay serves is compiled in —
//!    the Docker image ships the binary and nothing else. The dist is gitignored and built at
//!    `just web` / image-build time, NEVER committed; if it is missing here the build FAILS
//!    LOUD (no silent stub wallet — a stub could ship a broken /wallet while `just check` is
//!    green).
//!
//! 3. The PINNED facade canister module hash (`deploy/facade-module-hash.txt`, tracked) →
//!    `DPAY_PINNED_FACADE_HASH`, the reference half of `GET /api/v1/integrity` (GOVERNANCE row
//!    7): the route reads the LIVE hash off the IC state tree and compares. A missing or
//!    malformed pin FAILS THE BUILD LOUD (embed_web_dist precedent — an integrity surface that
//!    silently degraded to "unpinned" would be security theater). Test-helpers builds are the
//!    ONE exception: they bake the FakeLedger's deterministic hash so the offline loop sees
//!    MATCH without depending on the real, upgrade-chasing pin (see `bake_pinned_facade_hash`).
//!
//! All steps are feature-unconditional (the prod image carries them too — the `agent` feature
//! is not required), and all fall back / fail deterministically when git or the dist is absent.
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    bake_commit();
    bake_pinned_facade_hash();
    embed_web_dist();
}

/// Bake the git commit + its committer date (fallback `"unknown"` for release tarballs — the
/// build never fails on git). The date is the commit's, not the build's: it stays deterministic
/// across rebuilds of the same source, so it pairs 1:1 with the SHA above.
fn bake_commit() {
    // Rerun when the ref moves (a commit advances HEAD). A missing .git/HEAD (release tarball) is
    // harmless — cargo simply never triggers the rerun on it, and the fallback below applies.
    println!("cargo:rerun-if-changed=.git/HEAD");

    let out = Command::new("git")
        .args(["show", "-s", "--format=%H%n%cI", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let mut lines = out.lines();
    let commit_raw = lines.next().unwrap_or("").trim();
    let date_raw = lines.next().unwrap_or("").trim();
    let commit = if commit_raw.is_empty() { "unknown" } else { commit_raw };
    let date = if date_raw.is_empty() { "unknown" } else { date_raw };

    println!("cargo:rustc-env=DPAY_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=DPAY_BUILD_DATE={date}");
}

/// The hash `test-helpers` builds bake as the integrity pin — MUST equal
/// [`FakeLedger`'s](crate::ledger::fake) `FAKE_FACADE_MODULE_HASH` (all `ff`, so it can never
/// collide with a real wasm hash). Duplicated here because a build script cannot import the
/// crate it builds; `relay.rs`'s integrity tests assert the two never drift.
const TEST_HELPERS_PIN: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/// Bake the PINNED facade module hash from tracked `deploy/facade-module-hash.txt` (single
/// sha256-hex line — `scripts/dfx-deploy-ic.sh` rewrites it on every successful upgrade).
/// Prod/agent builds fail LOUD on a missing or malformed file: the pin is the whole point of
/// `/api/v1/integrity`, and a build that silently shipped without it would report `UNPINNED`
/// forever — an integrity surface that can't say MATCH is security theater. Test-helpers
/// builds (CARGO_FEATURE_TEST_HELPERS=1, incl. agent co-enabled — fakes are what they run)
/// bake the deterministic fake pin instead, so the offline integrity route reads MATCH and the
/// test matrix never depends on the real, upgrade-chasing pin.
fn bake_pinned_facade_hash() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let pin_path = manifest_dir.join("../../deploy/facade-module-hash.txt");
    // Rerun when the pin moves (a pin bump must rebuild the image that reports it).
    println!("cargo:rerun-if-changed={}", pin_path.display());

    if env::var("CARGO_FEATURE_TEST_HELPERS").is_ok_and(|v| v == "1") {
        println!("cargo:rustc-env=DPAY_PINNED_FACADE_HASH={TEST_HELPERS_PIN}");
        return;
    }

    let raw = fs::read_to_string(&pin_path).unwrap_or_else(|e| {
        panic!(
            "deploy/facade-module-hash.txt is unreadable ({e}) — it is the PINNED facade module \
             hash behind GET /api/v1/integrity (GOVERNANCE row 7). It is tracked: restore it via \
             git, or record the live hash with `dfx canister info <facade> --network ic` \
             (the 'Module hash: 0x…' line, hex only)."
        )
    });
    let pin = raw.trim();
    let well_formed = pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !well_formed {
        panic!(
            "deploy/facade-module-hash.txt must hold ONE sha256 as 64 lowercase hex chars (the \
             'Module hash: 0x…' line `dfx canister info` prints, minus the 0x) — found {:?}. \
             Fix the file; the integrity route will not bake a pin it cannot name.",
            raw.trim_end()
        );
    }
    println!("cargo:rustc-env=DPAY_PINNED_FACADE_HASH={pin}");
}

/// Map a dist filename to its HTTP content type (the closed set vite emits for this app).
fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Walk `dir` recursively → sorted map of (route path → absolute file path). BTreeMap keeps the
/// generated table byte-deterministic (same dist ⇒ same generated source ⇒ cache-friendly).
fn walk(dir: &PathBuf, prefix: &str, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(name) = entry.file_name().into_string() else { continue };
        let route = format!("{prefix}/{name}");
        if path.is_dir() {
            walk(&path, &route, out);
        } else {
            out.insert(route, path);
        }
    }
}

/// Generate `$OUT_DIR/web_assets.rs` embedding every file of `e2e/dist-prod`.
fn embed_web_dist() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest_dir.join("../../e2e/dist-prod");
    // Rerun when the dist changes (vite rebuild) — a deleted dir also counts as a change, which
    // re-triggers the loud failure below instead of silently serving a stale table.
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    walk(&dist, "", &mut files);
    if files.is_empty() {
        panic!(
            "e2e/dist-prod is missing or empty — the /wallet route embeds the prod web build of \
             the real app. Run `just web` (vite --mode web-prod) before building dpay-relay. \
             (deploy/build.sh does this automatically; every justfile recipe that builds the \
             relay depends on `web`.)"
        );
    }

    let mut rs = String::from(
        "// @generated by crates/dpay-relay/build.rs from e2e/dist-prod — do not edit.\n\
         /// One embedded file of the prod web build (see build.rs).\n\
         pub struct WebAsset {\n\
         \x20   pub route: &'static str,\n\
         \x20   pub content_type: &'static str,\n\
         \x20   /// Content-hashed filename under assets/ → served `immutable` (see wallet_page).\n\
         \x20   pub immutable: bool,\n\
         \x20   pub bytes: &'static [u8],\n\
         }\n\n\
         pub static WEB_ASSETS: &[WebAsset] = &[\n",
    );
    for (route, path) in &files {
        // wallet.html is the /wallet entry page; everything else serves at its dist-relative path
        // (assets/<hashed> under /assets/<hashed>). Only hashed assets/ files get `immutable`.
        let served = if route == "/wallet.html" { "/wallet" } else { route.as_str() };
        let immutable = route.starts_with("/assets/");
        let abs = path.canonicalize().unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()));
        assert!(abs.is_absolute(), "{} must be absolute", abs.display());
        rs.push_str(&format!(
            "    WebAsset {{ route: {served:?}, content_type: {:?}, immutable: {immutable}, bytes: include_bytes!(r\"{}\") }},\n",
            content_type(route),
            abs.display()
        ));
    }
    rs.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("web_assets.rs"), rs).expect("write web_assets.rs");
}
