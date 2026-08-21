//! dev-pubkey HEX_SEED — print the hex verifying key (32-byte Ed25519 public key) of a seed.
//! Companion to dev-principal: faucet-verify's --mint leg POSTs a THROWAWAY account to the live
//! relay's faucet, whose `account` field is the hex public key (not a principal). Read-only
//! helper: derivation only, no network.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(hex_seed), None) = (args.next(), args.next()) else {
        eprintln!("usage: dev-pubkey <64-char hex seed>");
        std::process::exit(2);
    };
    let seed: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&hex_seed[i * 2..i * 2 + 2], 16).expect("hex seed byte"))
        .collect::<Vec<u8>>()
        .try_into()
        .expect("seed is 32 bytes after hex decode");
    let key = dpay_icp_e2e::dev_key(&seed);
    println!("{}", hex::encode(key.verifying_key().to_bytes()));
}
