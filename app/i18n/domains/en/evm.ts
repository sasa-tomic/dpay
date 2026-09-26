/**
 * i18n/domains/en/evm.ts — the EVM rail's screens: type AND English values, co-located.
 *
 * Covers EvmReceiveMode, EvmPayMode and EvmWithdrawSheet. Composed into `Messages` / `en` by
 * i18n/keys.ts + i18n/en.ts. Same conventions as the other domains: interpolation is a typed
 * function, money arrives already formatted, proper nouns (chain names, ETH) are never
 * translated.
 */

export type EvmMessages = {
  // --- Receive ▸ My address (D14) -------------------------------------------------------------
  /** One EVM key serves every chain — the note says so where IC/SOL sections name one chain. */
  sameAddressNote: (chains: string) => string;
  /** The native-gas visibility line (D19): "Gas: 0.00013 ETH". */
  gasLine: (amount: string) => string;
  /** Funding copy, ZCHF on an EVM chain (the D20 send-to-address mechanism, stated). */
  fundBody: (symbol: string, chains: string) => string;

  // --- Receive ▸ Request payment (D21/D24/D18) --------------------------------------------------
  requestOffline: string;
  requestReady: string;
  waitingForSign: string;
  /** Expiry for the 600s request window ("Valid for 9 min" / "Expires in 42s"). */
  validForMin: (m: number) => string;
  expiresIn: (s: string) => string;
  expiredMakeNew: string;
  /** The scan-back states (merchant settles the payer's claim, D24). */
  settling: string;
  claimSettled: (amount: string) => string;
  claimFailedTitle: string;
  claimNeedsResign: string;
  claimUnknown: string;
  /** Queue notices on the receive surface. */
  claimsQueued: (n: number) => string;
  claimQueuedOffline: string;
  retrySettle: string;
  /** Typed failure reasons (D23's union), one sentence each. */
  failNonce: string;
  failExpired: string;
  failRejected: (detail: string) => string;
  failGas: (native: string, chain: string, address: string) => string;

  // --- Pay ▸ Scan to pay (payer, D22/D25) -------------------------------------------------------
  scanHint: string;
  signingOffline: string;
  showToMerchant: string;
  handedToMerchant: string;
  awaitingSettlement: (who: string | null) => string;
  /** The pending-claims notice where SOL shows the analogous payment state. */
  pendingBadge: (n: number) => string;
  checkNow: string;
  settledOnChain: string;
  stillAwaiting: string;
  badCode: string;
  requestExpired: string;
  /** No ZCHF deployment on the request's chain — refuse at the door. */
  unknownChain: (chain: number) => string;
  notEnoughBalance: (symbol: string) => string;

  // --- Pay ▸ Send to address (D15) ----------------------------------------------------------------
  sendTo: (symbol: string, chain: string) => string;
  available: (amount: string) => string;
  route: (chain: string) => string;
  badAddress: string;
  /** Checksum warnings (D15.1): warn + require an explicit continue, never block. */
  badChecksum: string;
  uncheckableChecksum: string;
  selfSend: string;
  amountLabel: (symbol: string) => string;
  amountPlaceholder: string;
  feeEstimate: (amount: string) => string;
  needsGas: (symbol: string) => string;
  reviewTitle: string;
  reviewAmount: (amount: string) => string;
  reviewTo: string;
  confirm: (amount: string) => string;
  enterAmount: string;
  nothingSent: string;
  sending: (amount: string) => string;
  confirming: (chain: string) => string;
  /** "Sent · seen on Arbitrum One" — inclusion, never "finalized" (the confirm-UX policy). */
  sentSeenOn: (chain: string) => string;
  sentUnknownTitle: string;
  sentUnknownBody: (chain: string) => string;
  failedTitle: string;
  failedBody: string;
  txHash: string;
  /** The gas honesty gate's refusal screen (D15.3) — instructs, never just refuses. */
  gasGateTitle: string;
  gasGateBody: (fee: string, chain: string) => string;
  gasGateAddressLabel: (native: string) => string;
  gasGateReady: string;
  tryAgain: string;
  /** The wrong-chain guard's copy (D10/D12) — names both chains. */
  wrongChain: (expected: string, actual: string) => string;
  engineLoad: string;
};

export const evmEn: EvmMessages = {
  sameAddressNote: chains => `Same address on ${chains} — one key, every chain`,
  gasLine: amount => `Gas: ${amount}`,
  fundBody: (symbol, chains) => `Get ${symbol} from any wallet or exchange that supports it, then send it to your address below on ${chains}. No memo needed. Keep a little ETH at the same address for the network fee when you want to pay onward.`,

  requestOffline: 'Requests work offline. The payer signs from your code and you settle when you are back online.',
  requestReady: 'Amount to request',
  waitingForSign: 'Waiting for the payer to sign your code',
  validForMin: m => `Valid for ${m} min`,
  expiresIn: s => `Expires in ${s}s`,
  expiredMakeNew: 'Expired — make a new request',
  settling: 'Settling — permit, then transfer…',
  claimSettled: amount => `Received ✓ ${amount}`,
  claimFailedTitle: 'Claim failed',
  claimNeedsResign: 'The payer’s code was stale — they need to scan your code and sign again. Show the same request.',
  claimUnknown: 'Not confirmed — it may still settle. Check before you hand over.',
  claimsQueued: n => `${n} claim${n === 1 ? '' : 's'} waiting`,
  claimQueuedOffline: 'Offline — the claim settles when you are back online.',
  retrySettle: 'Settle now',
  failNonce: 'The payer’s signature was stale — show your code again so they can sign fresh.',
  failExpired: 'The request expired on-chain — make a new one.',
  failRejected: detail => `The chain rejected the claim${detail ? ` (${detail})` : ''}.`,
  failGas: (native, chain, address) => `Your ${native} on ${chain} is exhausted — receive ${native} at ${address} and retry.`,

  scanHint: "Scan the merchant's code to pay",
  signingOffline: 'Signing offline — no connection needed',
  showToMerchant: 'Show this to the merchant',
  handedToMerchant: 'Handed to merchant',
  awaitingSettlement: who => `Sent · awaiting the merchant's settlement${who ? ` to ${who}` : ''}`,
  pendingBadge: n => `${n} payment${n === 1 ? '' : 's'} handed to merchants — awaiting settlement`,
  checkNow: 'Check now',
  settledOnChain: 'Settled — it shows in your history',
  stillAwaiting: 'Not settled yet — still waiting for the merchant',
  badCode: 'This is not a payment code',
  requestExpired: 'The request expired — ask for a fresh code',
  unknownChain: chain => `This code names a chain (id ${chain}) this wallet has no asset for`,
  notEnoughBalance: symbol => `Not enough ${symbol}`,

  sendTo: (symbol, chain) => `Send ${symbol} on ${chain}`,
  available: amount => `Available ${amount}`,
  route: chain => `Goes to an EVM address on ${chain}`,
  badAddress: 'Not a valid address',
  badChecksum: 'The checksum does not match — check the address with the sender before sending.',
  uncheckableChecksum: 'All one case — no checksum to verify. Check the address with the sender.',
  selfSend: 'This is your own address',
  amountLabel: symbol => `Amount (${symbol})`,
  amountPlaceholder: '0.00',
  feeEstimate: amount => `Fee ≈ ${amount} (estimate)`,
  needsGas: symbol => `Sending also needs a little ETH for the network fee`,
  reviewTitle: 'Review',
  reviewAmount: amount => `Send ${amount}`,
  reviewTo: 'To',
  confirm: amount => `Send ${amount}`,
  enterAmount: 'Enter an amount',
  nothingSent: 'Nothing was sent — you can try again.',
  sending: amount => `Sending ${amount}`,
  confirming: chain => `Waiting for ${chain}…`,
  sentSeenOn: chain => `Sent · seen on ${chain}`,
  sentUnknownTitle: 'Sent · not confirmed',
  sentUnknownBody: chain => `The network accepted it, but ${chain} has not shown the receipt yet. It may still land — do not send again.`,
  failedTitle: 'Failed',
  failedBody: 'The network rejected the transaction. Nothing moved.',
  txHash: 'Transaction hash',
  gasGateTitle: 'Network fee missing',
  gasGateBody: (fee, chain) => `This send needs about ${fee} on ${chain} for the network fee. Your ZCHF is ready to spend the moment the gas is there.`,
  gasGateAddressLabel: native => `Receive ${native} at your address`,
  gasGateReady: 'Funded? Try again',
  tryAgain: 'Try again',
  wrongChain: (expected, actual) => `The endpoint serves ${actual}, but this asset lives on ${expected}. Nothing was sent — check Settings ▸ Advanced.`,
  engineLoad: 'The payment engine did not load. Check your connection and try again — your money is still where it was.',
};
