import {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {POLL, DEPOSIT_TIMEOUT_MS, BALANCE_TIMEOUT_MS, QR_SIZE} from '../config/constants';
import {base} from '../lib/format';
import {parseDecimalToUnits, cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import type {FamilyDisplay} from '../config/catalog';
import {type CkErc20OnrampParams, ckerc20OnrampParams, readJsonOrEmpty} from '../services/relay';
import {encodeApprove, encodeDepositErc20, principalToBytes32} from '../cketh';
import {resolveOnrampProvider, connectWallet, getChainId, sendTransaction, waitForReceipt, ReceiptReverted, ReceiptTimeout, pairOnrampWallet} from '../wallet';
import {loadDeposit, saveDeposit, clearDeposit} from '../services/ckerc20Persist';
import {useEscapeToClose} from '../hooks/useHotkeys';

// ckERC20 (ckUSDC) direct onramp — a wallet-connect flow. The user connects their OWN Ethereum wallet
// (MetaMask/Rabby; window.ethereum on web), dpay BUILDS the two transactions (approve the helper to
// spend USDC, then depositErc20 into the helper with the facade principal + the user's pubkey as the
// subaccount), and the wallet SIGNS + broadcasts. dpay never sees the ETH key — non-custodial. The
// ckETH minter scrapes Ethereum logs on a ~3min heartbeat and mints ckUSDC to the user's subaccount
// (~20min); dpay just polls the ckUSDC balance. The calldata is built by cketh.ts (byte-exact vs the
// real helper-contract ABI; pinned by goldens).
export function CkErc20DepositSheet({identity, relayUrl, currency, display, chainId, onClose}: {
  identity: Identity;
  relayUrl: string;
  currency: number;
  display: FamilyDisplay;
  chainId: number | null; // MC8 U3: the catalog's per-currency EVM chain id (ckUSDC = 1 = Ethereum mainnet)
  onClose: () => void;
}) {
  // phase: 'connect' (no wallet yet) → 'enter' (wallet connected, enter amount) → 'sending' (txs
  // submitted, waiting on the user's wallet to sign) → 'watching' (txs mined, waiting for the mint)
  // → 'done' (balance grew).
  //
  // MC8 U5 — the WATCHING phase is RESUMABLE across app restart because the watching poll hits the
  // RELAY balance (not Ethereum), so it needs NO wallet session. `resumed` is true iff phase==
  // 'watching' was hydrated from AsyncStorage on mount (vs reached naturally via submit). The
  // ephemeral wallet-bound phases (connect/enter/sending) are NEVER persisted — an EIP-1193 session
  // does not survive restart, so resuming them would lie.
  const [phase, setPhase] = useState<'connect' | 'enter' | 'sending' | 'watching' | 'done'>('connect');
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // MC8 U6 capstone — the WalletConnect pairing URI. Non-null while the user should see the pairing
  // QR (between display_uri and the connect event). On web this is ALWAYS null (pairOnrampWallet is
  // a no-op that returns false without ever calling onUri), so the QR never renders in the e2e flow.
  const [wcUri, setWcUri] = useState<string | null>(null);
  // PR3/U6.5 — a ref mirror of wcUri so the unmount cleanup (empty-deps effect) can read the LATEST
  // value at teardown time. Without this, an unmount-only effect would capture the initial null and
  // never see a pairing in flight. Updated synchronously every render (no effect needed).
  const wcUriRef = useRef(wcUri);
  wcUriRef.current = wcUri;
  const [params, setParams] = useState<CkErc20OnrampParams | null>(null);
  const [startBal, setStartBal] = useState<string | null>(null);
  // Captured during submit() so the persisted watching state can carry the two ETH tx hashes
  // (informational for the resumed UI; never used to send on resume).
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [resumed, setResumed] = useState(false);

  useEscapeToClose(onClose);

  // PR3/U6.5 — on unmount (the close X, Esc, or any parent-driven teardown), if a WalletConnect
  // pairing is still in flight (wcUri is non-null: display_uri fired but the connect event never
  // did → no session established), abort it via the WC disconnect helper so the relay isn't left
  // holding a dangling pairing topic and the cached provider is cleared for a clean re-pair next
  // open. Fire-and-forget: the sheet is already tearing down, so there is no UI to surface an error
  // (the helper swallows failures internally anyway). Reached via a lazy dynamic import — the SAME
  // isolation boundary `wallet.ts` uses (wallet.ts is read-only here; the sheet never statically
  // imports walletconnect.ts). The guard (`wcUriRef.current !== null`) means a successful pair (QR
  // already cleared → null) does NOT tear down the session the user is actively depositing through.
  useEffect(() => {
    return () => {
      if (wcUriRef.current !== null) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget teardown; disconnectWalletConnect swallows internally
        import('../walletconnect')
          .then(({disconnectWalletConnect}) => disconnectWalletConnect())
          .catch(() => { /* best-effort: a teardown import failure must not crash unmount */ });
      }
    };
  }, []);

  // MC8 U5 — RESUME on mount. The watching poll is relay-bound (not Ethereum), so a watching deposit
  // survives an app restart WITHOUT a wallet reconnect: hydrate amount/account/startBal/txHashes and
  // set phase='watching' + resumed=true. The relay balance poll effect re-runs and picks up where it
  // left off. loadDeposit returns null for any non-watching/malformed value (hydrateWatch filters),
  // so a stale/corrupt key degrades to a fresh 'connect' sheet — never a crash, never a false resume.
  useEffect(() => {
    let alive = true;
    (async () => {
      const persisted = await loadDeposit(identity.publicHex, currency);
      if (!alive || !persisted) return; // null = nothing to resume (fresh or filtered-out)
      // hydrateWatch guarantees persisted.phase === 'watching' (it returns null otherwise), so this
      // is always a watching resume. Defensive discarding of other phases is handled at the service
      // layer (loadDeposit → hydrateWatch → null for non-watching), so no dead branch here.
      setAmount(persisted.amount);
      setAccount(persisted.account);
      setStartBal(persisted.startBal);
      setTxHashes(persisted.txHashes);
      setResumed(true);
      setPhase('watching');
    })();
    return () => { alive = false; };
  }, [identity.publicHex, currency]);

  // MC8 U5 — PERSIST on phase transitions. Entering 'watching' → save the resumable slice; reaching
  // 'done' (the mint landed) → clear the key. Idempotent: re-saving the same watching data on a
  // re-render is harmless. Only persisted when account + startBal are present (the watching poll's
  // resume needs); a watching reached via hydrate already has them (loaded from the same key).
  useEffect(() => {
    if (phase === 'watching') {
      if (account && startBal != null) {
        saveDeposit(identity.publicHex, currency, {
          currency, amount, account, startBal, txHashes, phase: 'watching',
        });
      }
    } else if (phase === 'done') {
      clearDeposit(identity.publicHex, currency);
    }
  }, [phase, account, amount, startBal, txHashes, identity.publicHex, currency]);

  // Load the onramp params (helper address, ERC-20 address, facade principal) once on open.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DEPOSIT_TIMEOUT_MS);
    (async () => {
      try {
        const p = await ckerc20OnrampParams(relayUrl, currency, ctrl.signal);
        if (alive) setParams(p);
      } catch { if (alive) setErr('Could not reach the relay for onramp details.'); }
      finally { if (alive) clearTimeout(t); }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [relayUrl, currency]);

  const connect = useCallback(async () => {
    setErr(null);
    // MC8 U6.3 — resolve the onramp provider SOURCE via the web-first resolver (wallet.ts). On web
    // this returns `window.ethereum` (the browser wallet / the e2e mock); on native it lazy-loads the
    // WalletConnect provider when WALLETCONNECT_PROJECT_ID is configured. The null path (no source
    // available) surfaces an honest, platform-aware message — NOT a browser-only "install MetaMask"
    // instruction that would lie to a native user.
    const provider = await resolveOnrampProvider();
    if (!provider) {
      setErr(Platform.OS === 'web'
        ? 'No Ethereum wallet found. Install MetaMask or Rabby in this browser.'
        : 'No wallet connected. Pair a wallet via WalletConnect.');
      return;
    }
    // MC8 U6 capstone — pair via WalletConnect BEFORE eth_requestAccounts. On web this is a no-op
    // (pairOnrampWallet returns false immediately — never reaches the WC dynamic import). On native
    // it subscribes to display_uri → renders the pairing QR (wcUri state), calls provider.connect()
    // (the wallet handshake), and clears the QR when the session is established. A pair failure
    // surfaces an honest error and aborts (does NOT proceed to connectWallet on a dead session).
    setWcUri(null);
    try {
      await pairOnrampWallet((uri) => setWcUri(uri));
    } catch (e: unknown) {
      setWcUri(null);
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/reject|denied|user/i.test(msg) ? 'Pairing not approved.' : (msg || 'Could not pair with your wallet.'));
      return; // stay in 'connect' — the WC session is not established.
    }
    try {
      const acct = await connectWallet(provider);
      // MC8 U3 — enforce the chain id right after connect. The catalog's per-currency chain_id is
      // the source of truth (ckUSDC = 1 = Ethereum mainnet). A wrong-network wallet is aborted BEFORE
      // the user enters an amount, so no calldata can be silently broadcast to the wrong chain. The
      // wallet cannot switch chains without re-prompting, so no re-check at submit is needed.
      if (chainId != null) {
        const actual = await getChainId(provider);
        if (actual !== chainId) {
          setErr(`Wrong network: connect to ${display.networkLabel} (chain ${chainId}). Your wallet is on chain ${actual}.`);
          return; // stay in 'connect' phase — do NOT enter 'enter'
        }
      }
      setAccount(acct);
      // Snapshot the starting balance so the watching poll can detect the mint (a GROWTH from here).
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await readJsonOrEmpty(r);
        if (typeof j.balance === 'string') setStartBal(j.balance);
        clearTimeout(t);
      } catch { /* best-effort snapshot; watching falls back to any-positive */ }
      setPhase('enter');
    } catch (e: unknown) {
      setErr((e instanceof Error ? e.message : String(e)) || 'Could not connect to your wallet.');
    }
  }, [relayUrl, currency, identity.publicHex, chainId, display.networkLabel]);

  const submit = useCallback(async () => {
    if (!account || !params) return;
    // MC8 U6.3 — same web-first resolver as connect(). On submit the provider was non-null at connect
    // time; if it has since vanished (the EIP-1193 session dropped), this surfaces an honest error
    // rather than sending calldata into the void.
    const provider = await resolveOnrampProvider();
    if (!provider) { setErr('Wallet disconnected.'); return; }
    // Parse the human amount into the smallest units (USDC = 6 decimals). MC1 units 2-4: use the
    // exact BigInt parser — `parseFloat`/`Math.pow` are lossy above 2^53.
    const parsed = parseDecimalToUnits(amount, display.amountDecimals);
    if (!parsed.ok || parsed.raw === '0') { setErr('Enter an amount greater than zero.'); return; }
    const unitBig = BigInt(parsed.raw);
    const principalWord = principalToBytes32(params.facade_principal);
    // The user's ckUSDC subaccount is their 32-byte Ed25519 pubkey (the same subaccount the balance
    // poll + pay path read), so the mint lands at the account the wallet already shows.
    const subaccount = identity.publicHex;
    setErr(null);
    setPhase('sending');
    // MC8 U5 — accumulate the tx hashes as they're produced so a timeout (soft → watching) still
    // persists whichever hashes were captured before the throw. The happy path captures both.
    const hashes: string[] = [];
    try {
      // 1. approve(helper, amount) on the USDC ERC-20 contract.
      const approveData = encodeApprove(params.helper_address, unitBig);
      const approveHash = await sendTransaction(provider, account, {to: params.erc20_address, data: approveData});
      hashes.push(approveHash);
      // MC8 U4 — wait for each tx to be MINED before proceeding. eth_sendTransaction returning a hash
      // only means the wallet accepted it, NOT that it succeeded. A reverted approve must surface an
      // honest error here, not a false "watching for the mint".
      await waitForReceipt(provider, approveHash);
      // 2. depositErc20(usdc, amount, principal, subaccount) on the helper contract.
      const depositData = encodeDepositErc20(params.erc20_address, unitBig, principalWord, subaccount);
      const depositHash = await sendTransaction(provider, account, {to: params.helper_address, data: depositData});
      hashes.push(depositHash);
      await waitForReceipt(provider, depositHash);
      setTxHashes(hashes);
      setResumed(false);
      setPhase('watching');
    } catch (e: unknown) {
      if (e instanceof ReceiptReverted) {
        // Hard fail: the tx was mined but reverted — it will NEVER credit. Stay in 'enter' so the
        // user can see the error and retry; do NOT transition to a false "watching".
        setErr('Transaction reverted on chain.');
        setPhase('enter');
      } else if (e instanceof ReceiptTimeout) {
        // SOFT (Fork-2 resolution): the tx was broadcast but not mined within the timeout. Transition
        // to watching anyway — the watching poll will catch the eventual mint, or the user can retry.
        setTxHashes(hashes);
        setResumed(false);
        setErr('Transaction sent but not yet confirmed — still watching for the mint.');
        setPhase('watching');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(/reject|denied|user/i.test(msg) ? 'Transaction not signed.' : (msg || 'Transaction failed.'));
        setPhase('enter');
      }
    }
  }, [account, params, amount, display.amountDecimals, identity.publicHex]);

  // MC8 U5 — "Start a new deposit" escape from a RESUMED watching state. A stuck watching key (a
  // deposit that never mints) would otherwise wedge the sheet in watching forever on every restart.
  // This clears the persisted key + returns to 'connect' so the user can begin fresh. The wallet
  // session is gone after a restart (EIP-1193 doesn't persist), so 'connect' is the honest reset
  // target — the user re-connects to start a new deposit.
  const startNew = useCallback(async () => {
    await clearDeposit(identity.publicHex, currency);
    setResumed(false);
    setAmount('');
    setAccount(null);
    setStartBal(null);
    setTxHashes([]);
    setErr(null);
    setPhase('connect');
  }, [identity.publicHex, currency]);

  // Watching: poll the ckUSDC balance for the mint. The minter scrapes ETH logs on a ~3min heartbeat;
  // credit typically lands within ~20min. Any growth from the snapshot (or a positive balance when no
  // snapshot) means the mint landed.
  useEffect(() => {
    if (phase !== 'watching') return;
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await readJsonOrEmpty(r);
        if (alive && r.ok && typeof j.balance === 'string') {
          // MC1 units 2-4: balance presence/growth via `cmpRaw` (BigInt) — never `>` on strings.
          const grew = startBal == null ? j.balance !== '0' : cmpRaw(j.balance, startBal) > 0;
          if (grew) setPhase('done');
        }
      } catch { /* keep watching */ } finally { clearTimeout(t); }
    };
    poll();
    const id = setInterval(poll, POLL.deposit);
    return () => { alive = false; clearInterval(id); };
  }, [phase, relayUrl, identity.publicHex, currency, startBal]);

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          {/* H1: title is the ASSET (USDC), not the network (Ethereum) — networkLabel stays only in the
              "Send only USDC on Ethereum" instruction below. */}
          <Text style={S.sheetTitle}>{`Add ${display.nativeAsset}`}</Text>
          <Pressable testID="btn-ckerc20-close" accessibilityRole="button" accessibilityLabel="Close deposit sheet" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          {/* Wrong-network warning — unmissable, above the flow. */}
          <View testID="ckerc20-deposit" style={S.instrCard}>
            <Text style={S.instrLine}>
              Send only <Text style={S.instrAsset}>{display.nativeAsset}</Text> on{' '}
              <Text style={S.instrAsset}>{display.networkLabel}</Text>. Other assets or chains sent
              this way won't credit and may be lost.
            </Text>
            <Text style={S.instrCustody}>
              dpay never holds your keys — your wallet signs, and ckUSDC mints 1:1 to your wallet on
              confirmation (~20 min).
            </Text>
            {/* M8: gas warning — the onramp needs two Ethereum transactions (approve + deposit), so the
                user must hold a little ETH for gas or both will fail. Inline style (amber) so it reads
                as a note, not body copy. */}
            <Text style={[S.instrCustody, {color: C.warn}]}>
              You'll need a small amount of ETH for Ethereum network gas fees.
            </Text>
          </View>

          {err ? <Text testID="ckerc20-status" style={S.err}>{err}</Text> : null}

          {phase === 'connect' ? (
            // MC8 U6 capstone — while wcUri is non-null (display_uri fired, waiting for the wallet to
            // scan + approve), render the pairing QR with on-brand copy. On web wcUri is ALWAYS null
            // (pairOnrampWallet is a no-op), so this branch is unreachable in the e2e harness.
            wcUri ? (
              <View style={S.centerAll}>
                <View testID="wc-pair-qr" style={S.qrCard}><QRCode value={wcUri} size={QR_SIZE} ecl="M" /></View>
                <Text style={S.paidSub}>Scan with your wallet to pair</Text>
              </View>
            ) : (
              <Pressable testID="btn-connect-wallet" accessibilityRole="button" accessibilityLabel="Connect Ethereum wallet" style={S.primaryWide} onPress={connect}>
                <Text style={S.primaryText}>Connect wallet</Text>
              </Pressable>
            )
          ) : phase === 'enter' || phase === 'sending' ? (
            <>
              <Text style={S.inputLabel}>{`Amount (${display.nativeAsset})`}</Text>
              <TextInput
                testID="ckerc20-amount"
                style={S.amountInput}
                keyboardType="decimal-pad"
                placeholder={`0.00`}
                value={amount}
                onChangeText={setAmount}
                editable={phase === 'enter'}
                onSubmitEditing={phase === 'enter' ? submit : undefined}
              />
              {account ? <Text style={S.dim2}>{`From ${account.slice(0, 6)}…${account.slice(-4)}`}</Text> : null}
              <Pressable
                testID="btn-approve"
                accessibilityRole="button"
                accessibilityLabel={phase === 'sending' ? 'Confirming in your wallet' : 'Approve and deposit'}
                accessibilityState={{disabled: phase === 'sending'}}
                style={[S.primaryWide, phase === 'sending' && {opacity: 0.6}]}
                onPress={submit}
                disabled={phase === 'sending'}>
                <Text style={S.primaryText}>{phase === 'sending' ? 'Confirm in your wallet…' : 'Approve & deposit'}</Text>
              </Pressable>
            </>
          ) : phase === 'watching' ? (
            <View style={S.centerAll}>
              <ActivityIndicator color={C.brand} />
              {/* MC8 U5 — surface the in-flight amount so a resumed watching state shows WHAT is
                  pending (the user may have forgotten the exact amount across a restart). */}
              {amount ? (
                <Text style={S.paidSub}>{`Depositing ${amount} ${display.nativeAsset}`}</Text>
              ) : null}
              {/* M9: one clear line — no "scrapes" jargon, no duplicate ~20min (confirmation + credit).
                  MC8 U5 — the RESUMED variant is honest that the wallet isn't connected but the watch
                  continues (relay-bound, not Ethereum-bound). */}
              <Text testID="ckerc20-status" style={S.paidSub}>{resumed
                ? 'Deposit pending (~20 min) — your wallet isn\u2019t connected, but we\u2019re still watching for the mint.'
                : 'Waiting for confirmation — your ckUSDC will appear in about 20 minutes.'}</Text>
              {/* MC8 U5 — escape from a resumed watching state. A deposit that never mints would
                  otherwise wedge the sheet in watching on every restart; this clears the key + returns
                  to 'connect' so the user can start fresh. Only rendered in the resumed state (a
                  fresh watch just completed submit; the user is still on the same browser session). */}
              {resumed ? (
                <Pressable
                  testID="btn-ckerc20-new"
                  accessibilityRole="button"
                  accessibilityLabel="Start a new deposit"
                  style={[S.primaryWide, {marginTop: 16}]}
                  onPress={startNew}>
                  <Text style={S.primaryText}>Start a new deposit</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text style={S.paidText}>Deposited ✓</Text>
              <Text style={S.paidSub}>ckUSDC minted to your wallet.</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
            </View>
          )}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
