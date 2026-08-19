//! dev-principal HEX_SEED — print the self-authenticating principal text of a 32-byte ed25519
//! seed (hex). Used by scripts/icp-replica-e2e.sh to fund the deterministic device principal P1
//! from the ledger's minting account BEFORE the Rust tests run (the tests must find P1 funded).
//! Read-only helper: derivation only, no network.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(hex_seed), None) = (args.next(), args.next()) else {
        eprintln!("usage: dev-principal <64-char hex seed>");
        std::process::exit(2);
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
