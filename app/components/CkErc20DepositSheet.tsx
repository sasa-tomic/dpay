import {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {QrCode} from './QrCode';
import {C} from '../config/palette';
import {S} from '../styles';
import {POLL, DEPOSIT_TIMEOUT_MS, QR_SIZE} from '../config/constants';
import {cmpRaw} from '../lib/amount';
import {parseUserAmount} from '../lib/format';
import type {Identity} from '../lib/types';
import type {FamilyDisplay} from '../config/catalog';
import {type CkErc20OnrampParams, ckerc20OnrampParams} from '../services/relay';
import {encodeApprove, encodeDepositErc20, encodeDepositEth, principalToBytes32} from '../cketh';
import {resolveOnrampProvider, connectWallet, getChainId, sendTransaction, waitForReceipt, ReceiptReverted, ReceiptTimeout, pairOnrampWallet, openWalletApp} from '../wallet';
import {loadDeposit, saveDeposit, clearDeposit} from '../services/ckerc20Persist';
import {railBalanceOf} from '../services/rail';
import {DpayCore} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconCheck} from './icons';
import {InstrLine} from './InstrLine';
import {IcrcAccountSection} from './IcrcAccountSection';
import {M} from '../i18n';

// ckERC20 (ckUSDC) / native ckETH direct onramp — a wallet-connect flow. The user connects their OWN
// Ethereum wallet (MetaMask/Rabby; window.ethereum on web), dpay BUILDS the transaction(s), and the
// wallet SIGNS + broadcasts. dpay never sees the ETH key — non-custodial. The ckETH minter scrapes
// Ethereum logs on a ~3min heartbeat and mints the chain-key asset to the USER'S OWN IC PRINCIPAL
// (ICRC-1 default subaccount — the same account every balance read + payment targets) (~20min);
// dpay just polls the ledger balance. The calldata is built by cketh.ts (byte-exact vs the real
// helper-contract ABI; pinned by goldens).
//
// Two deposit shapes share this sheet (the CkEthErc20 family + the SAME helper contract), discriminated
// by `nativeEth` (descriptor.token_contract == null):
//  - ERC-20 (USDC/USDT/DAI): TWO txs — approve(helper, amount) on the ERC-20, then depositErc20(...).
//  - native ETH: ONE payable tx — depositEth(principal) carrying the ETH `value` (Wei).
export function CkErc20DepositSheet({identity, relayUrl, currency, decimals, display, chainId, nativeEth, ledger, icSymbol, onClose}: {
  identity: Identity;
  relayUrl: string;
  currency: number;
  decimals: number;
  display: FamilyDisplay;
  chainId: number | null; // MC8 U3: the catalog's per-currency EVM chain id (ckUSDC = 1 = Ethereum mainnet)
  nativeEth: boolean; // true ⇒ native-ETH single-tx deposit (depositEth); false ⇒ ERC-20 two-tx (approve + depositErc20)
  ledger: string; // the ICRC-1 ledger principal for this currency — the WATCH target (signed icrc1_balance_of at the user principal)
  icSymbol: string; // the ICRC-1 ledger token symbol ('ckUSDC'/'ckETH') — names the asset in the "Already on the Internet Computer?" section
  onClose: () => void;
}) {
  // phase: 'connect' (no wallet yet) → 'enter' (wallet connected, enter amount) → 'sending' (txs
  // submitted, waiting on the user's wallet to sign) → 'watching' (txs mined, waiting for the mint)
  // → 'done' (balance grew).
  //
  // MC8 U5 — the WATCHING phase is RESUMABLE across app restart because the watching poll is a
  // SIGNED /api/v2 ledger query at the user's own principal (not Ethereum), so it needs NO wallet
  // session. `resumed` is true iff phase=='watching' was hydrated from AsyncStorage on mount (vs
  // reached naturally via submit). The ephemeral wallet-bound phases (connect/enter/sending) are
  // NEVER persisted — an EIP-1193 session does not survive restart, so resuming them would lie.
  const [phase, setPhase] = useState<'connect' | 'enter' | 'sending' | 'watching' | 'done'>('connect');
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // The user's own IC principal (resolved once on open; pure derivation off the identity key — the
  // SAME self principal every /api/v2 envelope targets). The deposit calldata's `principal` arg is
  // THIS principal with the subaccount omitted (ICRC-1 default) — a facade principal here would
  // mint invisible-to-the-wallet funds. null = not resolved yet (or derivation failed — submit
  // gates on it and fails honestly, never sends).
  const [selfPrincipal, setSelfPrincipal] = useState<string | null>(null);
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

  // MC8 U5 — RESUME on mount. The watching poll is a signed ledger query at the user principal (not
  // Ethereum), so a watching deposit survives an app restart WITHOUT a wallet reconnect: hydrate
  // amount/account/startBal/txHashes and set phase='watching' + resumed=true. The balance poll
  // effect re-runs and picks up where it left off. loadDeposit returns null for any
  // non-watching/malformed/pre-v2 value (hydrateWatch filters — a facade-era record polled a
  // target that will never move), so a stale/corrupt key degrades to a fresh 'connect' sheet —
  // never a crash, never a false resume.
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
          currency, amount, account, startBal, txHashes, target: 'user', phase: 'watching',
        });
      }
    } else if (phase === 'done') {
      clearDeposit(identity.publicHex, currency);
    }
  }, [phase, account, amount, startBal, txHashes, identity.publicHex, currency]);

  // Load the onramp params (helper address, ERC-20 address) once on open.
  useEffect(() => {
    let alive = true;
    const {signal, cancel} = withTimeout(DEPOSIT_TIMEOUT_MS);
    (async () => {
      try {
        const p = await ckerc20OnrampParams(relayUrl, currency, signal);
        if (alive) setParams(p);
      } catch (e) {
        // Log the real cause (HTTP status / body / network error / abort) so a 5xx, a CORS issue, or
        // a relay config gap is debuggable; the user still sees the friendly fallback message.
        console.warn('ckerc20OnrampParams failed:', e instanceof Error ? e.message : String(e));
        if (alive) setErr(M.deposit.erc20.onrampParamsErr);
      } finally { if (alive) cancel(); }
    })();
    return () => { alive = false; };
  }, [relayUrl, currency]);

  // Resolve the user's own IC principal once on open (pure derivation off the identity key — the
  // same self principal every /api/v2 envelope targets). The deposit calldata's `principal` arg is
  // THIS principal, so the mint lands at the account the wallet actually reads. A null/failed
  // resolve leaves submit gated off (honest error, never send).
  useEffect(() => {
    let alive = true;
    DpayCore.icpSelfPrincipal(identity.secretHex).then(
      (p) => { if (alive) setSelfPrincipal(p); },
      (e) => {
        console.warn('icpSelfPrincipal failed:', e instanceof Error ? e.message : String(e));
        if (alive) setErr(M.deposit.erc20.deriveErr);
      },
    );
    return () => { alive = false; };
  }, [identity.secretHex]);

  const connect = useCallback(async () => {
    setErr(null);
    // MC8 U6.3 — resolve the onramp provider SOURCE via the web-first resolver (wallet.ts). On web
    // this returns `window.ethereum` (the browser wallet / the e2e mock); on native it lazy-loads the
    // WalletConnect provider when WALLETCONNECT_PROJECT_ID is configured. The null path (no source
    // available) surfaces an honest, platform-aware message — NOT a browser-only "install MetaMask"
    // instruction that would lie to a native user.
    //
    // OPEN_ISSUES #1/#2 — thread the requested currency's chain_id so a Sepolia ckERC20 pairs against
    // Sepolia (not a mainnet-only session). `chainId` is the catalog descriptor's per-currency value;
    // default 1 preserves the pre-testnet mainnet behavior.
    const provider = await resolveOnrampProvider(chainId ?? 1);
    if (!provider) {
      setErr(Platform.OS === 'web' ? M.deposit.erc20.noWalletWeb : M.deposit.erc20.noWalletNative);
      return;
    }
    // MC8 U6 capstone — pair via WalletConnect BEFORE eth_requestAccounts. On web this is a no-op
    // (pairOnrampWallet returns false immediately — never reaches the WC dynamic import). On native
    // it subscribes to display_uri → renders the pairing QR (wcUri state), calls provider.connect()
    // (the wallet handshake), and clears the QR when the session is established. A pair failure
    // surfaces an honest error and aborts (does NOT proceed to connectWallet on a dead session).
    setWcUri(null);
    try {
      await pairOnrampWallet((uri) => setWcUri(uri), chainId ?? 1);
    } catch (e: unknown) {
      setWcUri(null);
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/reject|denied|user/i.test(msg) ? M.deposit.erc20.pairRejected : (msg || M.deposit.erc20.pairFailed));
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
          setErr(M.deposit.erc20.wrongNetwork(display.networkLabel, chainId, actual));
          return; // stay in 'connect' phase — do NOT enter 'enter'
        }
      }
      setAccount(acct);
      // Snapshot the starting ledger balance (signed icrc1_balance_of at the USER principal) so the
      // watching poll can detect the mint (a GROWTH from here).
      try {
        const bal = await railBalanceOf(identity.secretHex, ledger);
        if (bal != null) setStartBal(bal);
      } catch (e) {
        // Best-effort: a failed snapshot leaves startBal null — the watching poll's first
        // successful read then SETS the baseline (watch honesty, P2#5). Still log the cause so a
        // query failure is visible during a deposit debugging session.
        console.warn('ckERC20 startBal snapshot failed:', e instanceof Error ? e.message : String(e));
      }
      setPhase('enter');
    } catch (e: unknown) {
      setErr((e instanceof Error ? e.message : String(e)) || M.deposit.erc20.connectFailed);
    }
  }, [relayUrl, currency, ledger, identity.secretHex, identity.publicHex, chainId, display.networkLabel]);

  // Same-device pairing — open the OS wallet app with the WC pairing URI (alternative to scanning
  // the QR with a second device). The URI is non-null only while the pairing QR is shown. On web
  // openWalletApp is a no-op (returns false), but the button itself is gated to native below.
  const openInWallet = useCallback(async () => {
    if (!wcUri) return;
    const opened = await openWalletApp(wcUri);
    if (!opened) setErr(M.deposit.erc20.noWalletApp);
  }, [wcUri]);

  const submit = useCallback(async () => {
    if (!account || !params) return;
    // The deposit `principal` arg MUST be the user's own IC principal. If derivation somehow failed
    // (selfPrincipal null), fail honestly — a deposit to any other principal would mint funds the
    // wallet can never see. Never send.
    if (!selfPrincipal) { setErr(M.deposit.erc20.deriveErr); return; }
    // MC8 U6.3 — same web-first resolver as connect(). On submit the provider was non-null at connect
    // time; if it has since vanished (the EIP-1193 session dropped), this surfaces an honest error
    // rather than sending calldata into the void.
    const provider = await resolveOnrampProvider(chainId ?? 1);
    if (!provider) { setErr(M.deposit.erc20.walletDisconnected); return; }
    // Parse the human amount into the smallest units (USDC = 6 decimals). MC1 units 2-4: use the
    // exact BigInt parser — `parseFloat`/`Math.pow` are lossy above 2^53.
    const parsed = parseUserAmount(amount, decimals);
    if (!parsed.ok || parsed.raw === '0') { setErr(M.deposit.erc20.amountRequired); return; }
    const unitBig = BigInt(parsed.raw);
    // The deposit lands at the USER's own IC principal with the subaccount OMITTED (all-zeros =
    // ICRC-1 default subaccount) — the same Account{owner: user, subaccount: None} every signed
    // envelope and balance read targets. Omitting the arg is load-bearing: the facade-era code
    // passed a facade principal + pubkey subaccount, minting funds invisible to user-principal
    // reads. Both cketh.ts builders default a missing subaccount to the 32-zero-byte word (pinned
    // by the default-subaccount goldens in __tests__/cketh.test.ts).
    const principalWord = principalToBytes32(selfPrincipal);
    setErr(null);
    setPhase('sending');
    // MC8 U5 — accumulate the tx hashes as they're produced so a timeout (soft → watching) still
    // persists whichever hashes were captured before the throw. The happy path captures both (ERC-20)
    // or just one (native ETH).
    const hashes: string[] = [];
    try {
      if (nativeEth) {
        // Native ETH — ONE payable tx: depositEth(principal) with the ETH `value` (Wei). No approve
        // step (ETH is native, not an ERC-20 allowance). The amount is the tx `value`.
        const depositData = encodeDepositEth(principalWord);
        const depositHash = await sendTransaction(provider, account, {to: params.helper_address, data: depositData, value: unitBig});
        hashes.push(depositHash);
        await waitForReceipt(provider, depositHash);
      } else {
        // ERC-20 — TWO txs: approve(helper, amount) on the ERC-20 contract, then depositErc20(...).
        const erc20Address = params.erc20_address;
        if (!erc20Address) { setErr(M.deposit.erc20.missingErc20Address); setPhase('enter'); return; }
        // 1. approve(helper, amount) on the USDC ERC-20 contract.
        const approveData = encodeApprove(params.helper_address, unitBig);
        const approveHash = await sendTransaction(provider, account, {to: erc20Address, data: approveData});
        hashes.push(approveHash);
        // MC8 U4 — wait for each tx to be MINED before proceeding. eth_sendTransaction returning a hash
        // only means the wallet accepted it, NOT that it succeeded. A reverted approve must surface an
        // honest error here, not a false "watching for the mint".
        await waitForReceipt(provider, approveHash);
        // 2. depositErc20(usdc, amount, principal) on the helper contract (subaccount omitted =
        //    ICRC-1 default — the mint lands at the user's own default account).
        const depositData = encodeDepositErc20(erc20Address, unitBig, principalWord);
        const depositHash = await sendTransaction(provider, account, {to: params.helper_address, data: depositData});
        hashes.push(depositHash);
        await waitForReceipt(provider, depositHash);
      }
      setTxHashes(hashes);
      setResumed(false);
      setPhase('watching');
    } catch (e: unknown) {
      if (e instanceof ReceiptReverted) {
        // Hard fail: the tx was mined but reverted — it will NEVER credit. Stay in 'enter' so the
        // user can see the error and retry; do NOT transition to a false "watching".
        setErr(M.deposit.erc20.txReverted);
        setPhase('enter');
      } else if (e instanceof ReceiptTimeout) {
        // SOFT (Fork-2 resolution): the tx was broadcast but not mined within the timeout. Transition
        // to watching anyway — the watching poll will catch the eventual mint, or the user can retry.
        setTxHashes(hashes);
        setResumed(false);
        setErr(M.deposit.erc20.txUnconfirmed);
        setPhase('watching');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(/reject|denied|user/i.test(msg) ? M.deposit.erc20.txNotSigned : (msg || M.deposit.erc20.txFailed));
        setPhase('enter');
      }
    }
  }, [account, params, amount, decimals, selfPrincipal, nativeEth, chainId]);

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

  // Watching: poll the ledger balance for the mint — a SIGNED icrc1_balance_of at the user's own
  // principal (services/rail.ts), NOT a relay route (the old /api/v1/balance poll was
  // test-helpers-only and 404s in prod, so the mint was never detected). The minter scrapes ETH
  // logs on a ~3min heartbeat; credit typically lands within ~20min. Done requires OBSERVED GROWTH
  // from a real baseline: if the connect-time snapshot failed (null startBal), the first successful
  // read SETS the baseline instead of comparing — a pre-existing balance never false-positives done.
  useEffect(() => {
    if (phase !== 'watching') return;
    let alive = true;
    const poll = async () => {
      try {
        const bal = await railBalanceOf(identity.secretHex, ledger);
        if (alive && bal != null) {
          if (startBal == null) {
            // Watch honesty (P2#5): a missing baseline (the connect-time snapshot failed) must
            // never declare done off a balance the wallet may have had all along. The first
            // successful read SETS the baseline; the effect re-runs on the new startBal and the
            // next cadence poll compares against it.
            setStartBal(bal);
          } else if (cmpRaw(bal, startBal) > 0) {
            // MC1 units 2-4: growth via `cmpRaw` (BigInt) — never `>` on strings.
            setPhase('done');
          }
        }
      } catch (e) { console.warn('ckERC20 balance poll failed:', e instanceof Error ? e.message : String(e)); /* keep watching */ }
    };
    poll();
    const id = setInterval(poll, POLL.deposit);
    return () => { alive = false; clearInterval(id); };
  }, [phase, identity.secretHex, ledger, startBal]);

  // The body content is rendered inline in the Receive tab's "My address" sub-mode (the tab body
  // already provides the scroll surface + the overlay chrome).
  const body = (
    <>
      {/* Wrong-network warning — unmissable, above the flow. */}
      <View testID="ckerc20-deposit" style={S.instrCard}>
        <InstrLine runs={M.deposit.erc20.sendOnly(display.nativeAsset, display.networkLabel)} />
        <Text style={S.instrCustody}>{M.deposit.erc20.custody}</Text>
        {/* Gas warning. ERC-20: the onramp needs Ethereum transactions the user must hold ETH to
            pay gas for (separate from the deposited token). Native ETH: the deposit tx itself
            carries ETH, so the network fee comes out of the sent amount — send a little extra. */}
        <Text style={[S.instrCustody, {color: C.warn}]}>
          {nativeEth ? M.deposit.erc20.gasNative : M.deposit.erc20.gasErc20}
        </Text>
      </View>

      {err ? <Text testID="ckerc20-status" style={S.err}>{err}</Text> : null}

      {phase === 'connect' ? (
        // MC8 U6 capstone — while wcUri is non-null (display_uri fired, waiting for the wallet to
        // scan + approve), render the pairing QR with on-brand copy. On web wcUri is ALWAYS null
        // (pairOnrampWallet is a no-op), so this branch is unreachable in the e2e harness.
        wcUri ? (
          <View style={S.centerAll}>
            <View testID="wc-pair-qr" style={S.qrCard}><QrCode value={wcUri} size={QR_SIZE} ecl="M" /></View>
            <Text style={S.paidSub}>{M.deposit.erc20.scanToPair}</Text>
            {Platform.OS !== 'web' ? (
              <Pressable testID="btn-open-wallet" accessibilityRole="button" accessibilityHint={M.deposit.erc20.openWalletHint} style={[S.primaryWide, {marginTop: 12}]} onPress={openInWallet}>
                <Text style={S.primaryText}>{M.deposit.erc20.openWallet}</Text>
              </Pressable>
            ) : null}
            <Text style={S.dim2}>{M.deposit.erc20.walletListPair}</Text>
          </View>
        ) : (
          <View style={S.centerAll}>
            {/* Why a wallet, not an address: depositing on the ckETH ramp requires a wallet-SIGNED
                transaction (ERC-20: two txs — approve + depositErc20; native ETH: one payable tx —
                depositEth with the amount as ETH value). Unlike Bitcoin (UTXO, send-to-address),
                there is no "deposit address" here; the deposit must be initiated from the wallet
                that holds the asset (+ ETH for gas, for ERC-20). */}
            <Text style={S.dim2}>{nativeEth ? M.deposit.erc20.explainNative : M.deposit.erc20.explainErc20(display.nativeAsset)}</Text>
            <Pressable testID="btn-connect-wallet" accessibilityRole="button" accessibilityLabel={M.deposit.erc20.connectLabel} style={S.primaryWide} onPress={connect}>
              <Text style={S.primaryText}>{M.deposit.erc20.connect}</Text>
            </Pressable>
            <Text style={S.dim2}>{M.deposit.erc20.walletList}</Text>
            {/* Secondary route: plain ICRC-1 transfer for funds already on the IC (no Ethereum
                txs, no gas) — the watching poll above detects it like any mint. */}
            <IcrcAccountSection symbol={icSymbol} principal={selfPrincipal} />
          </View>
        )
      ) : phase === 'enter' || phase === 'sending' ? (
        <>
          <Text style={S.inputLabel}>{M.deposit.amountLabel(display.nativeAsset)}</Text>
          <TextInput
            testID="ckerc20-amount"
            style={S.amountInput}
            keyboardType="decimal-pad"
            placeholder={M.deposit.erc20.amountPlaceholder}
            value={amount}
            onChangeText={setAmount}
            editable={phase === 'enter'}
            onSubmitEditing={phase === 'enter' ? submit : undefined}
          />
          {account ? <Text style={S.dim2}>{M.deposit.erc20.fromAccount(`${account.slice(0, 6)}…${account.slice(-4)}`)}</Text> : null}
          <Pressable
            testID="btn-approve"
            accessibilityRole="button"
            accessibilityLabel={phase === 'sending' ? M.deposit.erc20.confirmingLabel : (nativeEth ? M.deposit.erc20.deposit : M.deposit.erc20.approveDepositLabel)}
            accessibilityState={{disabled: phase === 'sending'}}
            style={[S.primaryWide, phase === 'sending' && {opacity: 0.6}]}
            onPress={submit}
            disabled={phase === 'sending'}>
            <Text style={S.primaryText}>{phase === 'sending' ? M.deposit.erc20.confirming : (nativeEth ? M.deposit.erc20.deposit : M.deposit.erc20.approveDeposit)}</Text>
          </Pressable>
        </>
      ) : phase === 'watching' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          {/* MC8 U5 — surface the in-flight amount so a resumed watching state shows WHAT is
              pending (the user may have forgotten the exact amount across a restart). */}
          {amount ? (
            <Text style={S.paidSub}>{M.deposit.erc20.depositingAmount(amount, display.nativeAsset)}</Text>
          ) : null}
          {/* M9: one clear line — no "scrapes" jargon, no duplicate ~20min (confirmation + credit).
              MC8 U5 — the RESUMED variant is honest that the wallet isn't connected but the watch
              continues (relay-bound, not Ethereum-bound). */}
          <Text testID="ckerc20-status" style={S.paidSub}>{resumed ? M.deposit.erc20.watchingResumed : M.deposit.erc20.watchingFresh}</Text>
          {/* MC8 U5 — escape from a resumed watching state. A deposit that never mints would
              otherwise wedge the sheet in watching on every restart; this clears the key + returns
              to 'connect' so the user can start fresh. Only rendered in the resumed state (a
              fresh watch just completed submit; the user is still on the same browser session). */}
          {resumed ? (
            <Pressable
              testID="btn-ckerc20-new"
              accessibilityRole="button"
              accessibilityLabel={M.deposit.erc20.startNew}
              style={[S.primaryWide, {marginTop: 16}]}
              onPress={startNew}>
              <Text style={S.primaryText}>{M.deposit.erc20.startNew}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={S.centerAll}>
          <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
          <Text style={S.paidText}>{M.deposit.deposited}</Text>
          <Text style={S.paidSub}>{M.deposit.erc20.mintedToWallet(display.nativeAsset)}</Text>
          <Text style={S.dim2}>{M.deposit.balanceAuto}</Text>
          <Pressable testID="btn-ckerc20-deposit-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.common.done} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.common.done}</Text></Pressable>
        </View>
      )}
      {Platform.OS === 'web' ? <Text style={S.dim2}>{M.deposit.pressEsc}</Text> : null}
    </>
  );

  return <View style={S.sheetCenter}>{body}</View>;
}
