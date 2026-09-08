//! Build-time baking for dpay-relay:
//!
//! 1. The current git commit (`DPAY_BUILD_COMMIT`) + its committer date (`DPAY_BUILD_DATE`) so
//!    the live `/api/v1/version` endpoint can report EXACTLY which source the running image was
//!    built from and when that source was committed. This is the deploy-fidelity primitive:
//!    comparing the live commit to `git rev-parse HEAD` catches a stale image shipping while
//!    `just check` is green (the bug class `verify-deploy.sh` closes for the canister); the date
//!    is its human-readable half ("when was prod last updated").
//!    A build from a DIRTY working tree bakes `<sha>-dirty`, because the image then corresponds
//!    to no commit at all: `deploy/build.sh` compiles the working tree, not `git archive`, so
//!    uncommitted code really does ship. Reporting the bare SHA there was a lie that made
//!    `/api/v1/version` — and every rule resting on it — unable to say what prod runs
//!    (`scripts/verify-relay-version.sh` treats the marker as its own outcome).
//!
//! 2. The prod web build of the REAL app (`e2e/dist-prod`, produced by `just web` /
//!    `vite build --mode web-prod`) → a generated `$OUT_DIR/web_assets.rs` static table the
//!    `/wallet` + `/assets/*` routes serve from, each compressible file paired with the `.br`
//!    body the vite build precompressed for it (see `must_be_precompressed` — the pairing is
//!    enforced in both directions, so nothing ships uncompressed by accident and no unused
//!    compressed copy is carried). Everything the relay serves is compiled in —
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
///
/// A dirty tree bakes `<sha>-dirty` — one string, so EVERY consumer of the commit (the
/// `/api/v1/version` + `/api/v1/integrity` bodies, the `/shots/*` ETag, `verify-relay-version.sh`)
/// stops matching a clean SHA the moment the build stops corresponding to one. A separate boolean
/// was the alternative and is worse: a consumer reading only the commit would keep silently
/// reporting MATCH, which is the exact failure being fixed.
///
/// Freshness of the marker: cargo re-runs this script only when a declared `rerun-if-changed`
/// input moves. `deploy/build.sh` — the only path whose `/version` answer is load-bearing —
/// regenerates `e2e/dist-prod` (a declared input, see `embed_web_dist`) on every image build, so
/// the marker is always recomputed there. In a dev tree it can lag until any declared input moves;
/// that is a stale DEV number, never a stale SHIPPED one.
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
    let commit = if commit_raw.is_empty() {
        // No git at all (release tarball): there is no commit to be dirty against either.
        "unknown".to_string()
    } else if working_tree_dirty() {
        format!("{commit_raw}-dirty")
    } else {
        commit_raw.to_string()
    };
    let date = if date_raw.is_empty() {
        "unknown"
    } else {
        date_raw
    };

    println!("cargo:rustc-env=DPAY_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=DPAY_BUILD_DATE={date}");
}

/// Does the working tree differ from HEAD? `git status --porcelain` is the whole test: it reports
/// staged + unstaged changes to tracked files AND untracked files that are not gitignored — every
/// way the compiled source can differ from the commit being reported. (Gitignored paths, which
/// includes `e2e/dist-prod`, `target/` and `.dev/`, are excluded by git itself.)
///
/// Only reached when `git show HEAD` already succeeded, so git exists and this IS a checkout. A
/// failure here is therefore a real failure and PANICS: silently assuming "clean" would re-create
/// the defect this function exists to close, on the one build where it matters most.
fn working_tree_dirty() -> bool {
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "`git status --porcelain` could not run ({e}) — it decides whether this build is \
                 reported as `<sha>` or `<sha>-dirty` on GET /api/v1/version. Without it the image \
                 could claim a commit it was not built from."
            )
        });
    if !out.status.success() {
        panic!(
            "`git status --porcelain` failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    !out.stdout.is_empty()
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
    let well_formed = pin.len() == 64
        && pin
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
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
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Is this dist file one the vite build is required to have precompressed? Mirrors `COMPRESSIBLE`
/// in `e2e/vite.config.js`; the two are checked against each other by [`embed_web_dist`], which
/// FAILS THE BUILD when a compressible file arrives without its `.br` sibling. Fonts (woff2) and
/// PNGs are absent on purpose: both are already compressed containers.
fn must_be_precompressed(path: &str) -> bool {
    matches!(
        path.rsplit('.').next().unwrap_or(""),
        "js" | "mjs" | "html" | "css" | "wasm" | "json" | "webmanifest" | "svg" | "txt"
    )
}

/// Walk `dir` recursively → sorted map of (route path → absolute file path). BTreeMap keeps the
/// generated table byte-deterministic (same dist ⇒ same generated source ⇒ cache-friendly).
fn walk(dir: &PathBuf, prefix: &str, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
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
         \x20   /// The vite build's brotli of `bytes`, for a client that sent `Accept-Encoding: br`.\n\
         \x20   /// `None` only for containers that are already compressed (woff2, png).\n\
         \x20   pub brotli: Option<&'static [u8]>,\n\
         }\n\n\
         pub static WEB_ASSETS: &[WebAsset] = &[\n",
    );
    for (route, path) in &files {
        // `.br` files are not resources of their own — they are the compressed body of the file
        // next to them, attached below.
        if route.ends_with(".br") {
            continue;
        }
        // wallet.html is the /wallet entry page; everything else serves at its dist-relative path
        // (assets/<hashed> under /assets/<hashed>). Only hashed assets/ files get `immutable`.
        let served = if route == "/wallet.html" {
            "/wallet"
        } else {
            route.as_str()
        };
        let immutable = route.starts_with("/assets/");
        let abs = path
            .canonicalize()
            .unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()));
        assert!(abs.is_absolute(), "{} must be absolute", abs.display());

        // The precompression contract, enforced at build time in BOTH directions: a compressible
        // file without a `.br` would silently ship uncompressed (the 2 MB defect X12 records), and
        // a `.br` for a file the relay never negotiates would be dead weight in the binary.
        let br = files.get(&format!("{route}.br"));
        let brotli = match (must_be_precompressed(route), br) {
            (true, Some(br_path)) => {
                let br_abs = br_path
                    .canonicalize()
                    .unwrap_or_else(|e| panic!("canonicalize {}: {e}", br_path.display()));
                format!("Some(include_bytes!(r\"{}\"))", br_abs.display())
            }
            (true, None) => panic!(
                "e2e/dist-prod{route} has no e2e/dist-prod{route}.br — the web-prod vite build must brotli every \
                 compressible output (plugin `dpayWebProdAssets` in e2e/vite.config.js). Rebuild \
                 with `just web`; do NOT ship this uncompressed."
            ),
            (false, Some(_)) => panic!(
                "e2e/dist-prod{route}.br exists but {route} is not a type the relay serves \
                 compressed (woff2/png are already compressed containers). Keep `COMPRESSIBLE` in \
                 e2e/vite.config.js and `must_be_precompressed` in this file in step."
            ),
            (false, None) => "None".to_string(),
        };
        rs.push_str(&format!(
            "    WebAsset {{ route: {served:?}, content_type: {:?}, immutable: {immutable}, bytes: include_bytes!(r\"{}\"), brotli: {brotli} }},\n",
            content_type(route),
            abs.display()
        ));
    }
    rs.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("web_assets.rs"), rs).expect("write web_assets.rs");
}
