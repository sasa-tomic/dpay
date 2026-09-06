//! dev-principal — print the self-authenticating principal text of a 32-byte ed25519 seed (hex).
//! Two modes:
//!   * `--from-stdin` — the seed is read (and trimmed) from stdin. Preferred at every call site
//!     that handles a REAL key: argv is visible in `ps` for the whole build+run window, stdin
//!     is not.
//!   * `HEX_SEED` argv mode — dev convenience, and fine for the DETERMINISTIC test seeds
//!     (scripts/icp-replica-e2e.sh funds device principal P1 from the ledger's minting account
//!     BEFORE the Rust tests run, so the tests must find P1 funded).
//! Read-only helper: derivation only, no network.

use std::io::Read;

fn main() {
    let mut args = std::env::args().skip(1);
    let hex_seed = match (args.next(), args.next()) {
        (Some(flag), None) if flag == "--from-stdin" => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .expect("reading the seed from stdin");
            buf.trim().to_string()
        }
        (Some(seed), None) => seed,
        _ => {
            eprintln!("usage: dev-principal <64-char hex seed>");
            eprintln!("       printf '%s' <seed> | dev-principal --from-stdin   # real seeds: never ride argv (ps)");
            std::process::exit(2);
        }
    };
    let seed: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&hex_seed[i * 2..i * 2 + 2], 16).expect("hex seed byte"))
        .collect::<Vec<u8>>()
        .try_into()
        .expect("seed is 32 bytes after hex decode");
    let key = dpay_icp_e2e::dev_key(&seed);
    let principal = dpay_icp::Principal::self_authenticating_ed25519(&key.verifying_key().to_bytes());
    println!("{}", principal.to_text());
}
