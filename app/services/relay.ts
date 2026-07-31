import {base} from '../lib/format';

// --- ck-deposit (ckBTC-style top-up) response shapes -----------------------------------------
export type DepositInfo = {min_confirmations: number; deposit_fee: number; deposit_min_amount: number | null};
export type MintedUtxo = {block_index: string; amount: number};
export type PendingUtxo = {value: number; confirmations: number};
export type DepositRefresh = {minted_total: number; minted: MintedUtxo[]; pending: PendingUtxo[]; required_confirmations: number};

// Relay deposit client — same fetch style as the inline balance/faucet/pay calls (AbortController
// optional, errors thrown to the caller). Co-located here to match the existing pattern.
export async function depositInfo(relayUrl: string, currency: number, signal?: AbortSignal): Promise<DepositInfo> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/info?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`deposit/info ${r.status}`);
  return r.json();
}
export async function depositAddress(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/address/${accountHex}?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`deposit/address ${r.status}`);
  const j = await r.json();
  return j.address as string;
}
export async function depositRefresh(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<DepositRefresh> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/refresh/${accountHex}?currency=${currency}`, {method: 'POST', signal});
  if (!r.ok) throw new Error(`deposit/refresh ${r.status}`);
  return r.json();
}

// ckERC-20 onramp params (helper contract, ERC-20 address, facade principal) for a CkEthErc20-family
// currency. The app builds the user's two Ethereum transactions from these (cketh.ts); the user signs
// in their own wallet (non-custodial). Errors throw with the status (503 = no ckERC-20 onramp for the
// currency / relay unreachable).
export type CkErc20OnrampParams = {helper_address: string; erc20_address: string; facade_principal: string};
export async function ckerc20OnrampParams(relayUrl: string, currency: number, signal?: AbortSignal): Promise<CkErc20OnrampParams> {
  const r = await fetch(`${base(relayUrl)}/api/v1/onramp/ckerc20?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`onramp/ckerc20 ${r.status}`);
  return r.json();
}

// Withdraw a ckBTC balance to a native BTC address. The app signs the WithdrawAuth on-device (the
// sig is the non-custodial gate); the relay forwards to the facade's `withdraw`. Returns the burn
// receipt (block_index). Errors throw with the status so the sheet can surface a decline vs offline.
export type WithdrawReceipt = {from: string; destination: string; amount: number; nonce: string; currency: number; block_index: number};

export async function withdrawFunds(relayUrl: string, accountHex: string, btcAddress: string, amountSats: number, nonceHex: string, expiry: number, currency: number, sigHex: string, signal?: AbortSignal): Promise<WithdrawReceipt> {
  const r = await fetch(`${base(relayUrl)}/api/v1/withdraw`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({from: accountHex, destination: btcAddress, amount: amountSats, nonce: nonceHex, expiry, currency, sig: sigHex}),
    signal,
  });
  const j = await r.json().catch(() => ({} as any));
  if (r.ok && j?.receipt) {
    return j.receipt as WithdrawReceipt;
  }
  // A 422 carries a policy error (bad sig / expired / below min / insufficient / nonce reused); a
  // 503 is a transient ledger hiccup. Surface the body's error string so the sheet can show WHY.
  throw new Error(typeof j?.error === 'string' ? j.error : `withdraw ${r.status}`);
}
