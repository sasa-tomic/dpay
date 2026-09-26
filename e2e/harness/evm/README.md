# MockZCHF — committed bytecode blob (dev/e2e only)

A minimal self-contained ERC-20 with EIP-2612 permit: the ZCHF (Frankencoin) stand-in for the
local Anvil chain (31337) and Arbitrum Sepolia staging. 18 decimals, `name = "Frankencoin"`,
`symbol = "ZCHF"`, constructor mints 1,000,000 ZCHF to the deployer. NOT audited, dev-only,
never deployed to any public chain.

## Files

- `MockZCHF.sol` — the source (compiled artifact of record).
- `MockZCHF.t.sol` — the foundry proof: offline-permit pull-claim, expired-permit revert,
  permit-nonce single-use (the dpay offline-claim mechanics, flow 215's subject).
- `MockZCHF.hex` — the CREATION bytecode the harness deploys (`e2e/harness/evm/anvil.mjs`,
  `e2e/harness/evm/pipe-smoke.mjs`) with a raw signed type-2 tx. This is why runtime needs no
  forge/solc (the offline inner-loop rule).
- `MockZCHF.json` — the same bytecode + ABI + build metadata as one committed blob.

## Build facts (reproducibility)

| key | value |
| --- | --- |
| solc | 0.8.20 (pinned in the source pragma) |
| evm_version | shanghai |
| optimizer | enabled, 200 runs |
| toolchain | forge 1.8.3 |
| creation bytecode keccak256 | `0x3fd0301144b7de356346bd7f680667a6b953c64de530a4449b8a41b170665789` |
| creation bytecode sha256 | `f0d90bf03d85909cf007de83f0a0c97bc7cf4154b52eeed38a54054bf8d2a97e` |

Rebuild + re-verify (only when changing the source — the committed blob is what ships):

```sh
cd <scratch dir>   # needs foundry.toml: solc_version = "0.8.20", evm_version = "shanghai",
                   # optimizer = true, optimizer_runs = 200; src/ + test/ copied from here
forge test         # must stay 3/3
forge inspect MockZCHF bytecode   # creation bytecode → MockZCHF.hex
forge inspect MockZCHF abi        # → MockZCHF.json .abi
```

Then update the two hash lines above. `anvil.mjs` fails loud on a `MockZCHF.hex` that does not
match `0x[0-9a-f]+` or is empty — a mangled blob never deploys silently.

## EIP-2612 domain (what permit signatures must sign)

`DOMAIN_SEPARATOR = keccak256(abi.encode(
  keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  keccak256("Frankencoin"), keccak256("1"), block.chainid, address(this)))`

i.e. domain `{name: "Frankencoin", version: "1", chainId, verifyingContract}` — the same
`permitName`/`permitVersion` the registry pins for ZCHF. Chain-id and address bound, so signatures
never cross chains or tokens.
