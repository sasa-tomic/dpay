// The EVM-NATIVE convert destinations (2026-09-27): the CeFi convert pairs whose SETTLE
// side is a native coin on an EVM chain — first: ICP → native ETH on Ethereum mainnet,
// the trip that funds the EVM rail from ICP holdings (via the already-deployed SideShift
// partner-key relay).
//
// Why a separate table and NOT a row in BUNDLED_VENUES: the venue registry is
// drift-alarmed field-for-field against `dfx/catalog_truth.json` `venues[]` on both
// sides (app + relay), and native ETH has no catalog row BY DESIGN (the catalog's
// EvmAsset rows are ERC-20 tokens; native gas is not an asset row). The pair is
// therefore owned by the sideshift ADAPTER relay-side (`crates/dpay-relay/src/sideshift.rs`,
// `SIDESHIFT_ETH_VENUE_ID`/`ETH_NATIVE_RAIL_ID`) and bundled app-side HERE — a
// registry-shaped row that resolves through the same lookups (`venueOfId`,
// `cefiOtherSide`, `cefiFamilyOf`) without touching the drift-alarmed set. The rail-id
// string is pinned equal to the relay's twin by `app/__tests__/convertEvmCefi.test.ts`.
//
// PURE module (no imports, no react-native, no AsyncStorage, no network): safe to
// static-import anywhere and to import from the generator scripts under plain node. The
// row below is STRUCTURALLY a `VenueEntry` (config/venues.ts pins the assignability at
// its import — the one compile-time contract; the type itself is deliberately not
// imported here so this module stays dependency-free).
//
// Row shape (mirrors VenueEntry; keep field-for-field compatible):
//   venue_id, display_name, kind: 'ic_amm'|'cefi'|'solana_amm', endpoint, pair_ledgers,
//   testnet, disclosure_key, health?

/** The rail-canonical id for NATIVE ETH on Ethereum mainnet — the settle side of the
 *  adapter-owned SideShift pair. Same vocabulary family as the registry's pair ids (IC
 *  ledger principals, SPL mints): one stable string naming one settle rail. MUST equal
 *  the relay's `ETH_NATIVE_RAIL_ID` (drift-alarmed; the relay refuses an unknown settle
 *  rail at order time, so a drift fails loud there too). */
export const ETH_NATIVE_RAIL_ID = 'evm:native-eth';

/** The EVM chain this rail settles on: Ethereum mainnet. */
export const ETH_NATIVE_CHAIN_ID = 1;

/** Native ETH's display facts (18 decimals — the chain's own unit). */
export const ETH_NATIVE_SYMBOL = 'ETH';
export const ETH_NATIVE_DECIMALS = 18;

/** The adapter-owned cefi row for ICP → native ETH. Registry-shaped (a `VenueEntry` —
 *  see the header) so every cefi surface — quote, order, provider status, disclosure —
 *  serves it unchanged; NOT merged into BUNDLED_VENUES. `endpoint` is the venue's https
 *  API base, the same SideShift identity every sideshift-family row carries;
 *  `venue_id` matches the relay's attribution (`SIDESHIFT_ETH_VENUE_ID`) and the family
 *  prefix convention (`cefiFamilyOf` → 'sideshift': relay-held partner key, keyless
 *  status reads). The IC pair side is the ICP ledger principal — the same literal
 *  `ICP_LEDGER_PRINCIPAL` pins (config/constants.ts), drift-checked against
 *  `dfx/catalog_truth.json` `principals.icp_ledger` by the catalog tests. */
export const EVM_NATIVE_VENUES = [
  {
    venue_id: 'sideshift-eth',
    display_name: 'SideShift',
    kind: 'cefi',
    endpoint: 'https://sideshift.ai/api/v2',
    pair_ledgers: ['ryjl3-tyaaa-aaaaa-aaaba-cai', ETH_NATIVE_RAIL_ID],
    testnet: false,
    disclosure_key: 'sideshift',
  },
] as const;

/** The EVM-native cefi venues a deposit rail can send through, in table order (the
 *  `cefiVenuesForLedger` analog over THIS table — the bundled registry is not consulted,
 *  it cannot carry these rows). Testnet rows are kept out, like every cefi walk. */
export function evmNativeVenuesForLedger(depositLedger: string): readonly VenueRow[] {
  return EVM_NATIVE_VENUES.filter(
    v => v.kind === 'cefi' && !v.testnet && (v.pair_ledgers as readonly string[]).includes(depositLedger),
  );
}

/** The row's own structural shape (kept in lockstep with `VenueEntry`; the consumer's
 *  assignability pin is the compile-time contract). */
export type VenueRow = (typeof EVM_NATIVE_VENUES)[number];
