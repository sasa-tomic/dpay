import {useCallback, useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {POLL} from '../config/constants';
import {fmtAsset, base} from '../lib/format';
import type {Identity} from '../lib/types';
import type {FamilyDisplay} from '../config/catalog';
import {type CkErc20OnrampParams, ckerc20OnrampParams} from '../services/relay';
import {encodeApprove, encodeDepositErc20, principalToBytes32} from '../cketh';
import {getEthereumProvider, connectWallet, sendTransaction} from '../wallet';
import {useEscapeToClose} from '../hooks/useHotkeys';

// ckERC20 (ckUSDC) direct onramp — a wallet-connect flow. The user connects their OWN Ethereum wallet
// (MetaMask/Rabby; window.ethereum on web), dpay BUILDS the two transactions (approve the helper to
// spend USDC, then depositErc20 into the helper with the facade principal + the user's pubkey as the
// subaccount), and the wallet SIGNS + broadcasts. dpay never sees the ETH key — non-custodial. The
// ckETH minter scrapes Ethereum logs on a ~3min heartbeat and mints ckUSDC to the user's subaccount
// (~20min); dpay just polls the ckUSDC balance. The calldata is built by cketh.ts (byte-exact vs the
// real helper-contract ABI; pinned by goldens).
export function CkErc20DepositSheet({identity, relayUrl, currency, display, onClose}: {
  identity: Identity;
  relayUrl: string;
  currency: number;
  display: FamilyDisplay;
  onClose: () => void;
}) {
  // phase: 'connect' (no wallet yet) → 'enter' (wallet connected, enter amount) → 'sending' (txs
  // submitted, waiting on the user's wallet to sign) → 'watching' (txs mined, waiting for the mint)
  // → 'done' (balance grew).
  const [phase, setPhase] = useState<'connect' | 'enter' | 'sending' | 'watching' | 'done'>('connect');
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [params, setParams] = useState<CkErc20OnrampParams | null>(null);
  const [startBal, setStartBal] = useState<number | null>(null);

  useEscapeToClose(onClose);

  // Load the onramp params (helper address, ERC-20 address, facade principal) once on open.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
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
    const provider = getEthereumProvider();
    if (!provider) { setErr('No Ethereum wallet found. Install MetaMask or Rabby in this browser.'); return; }
    try {
      const acct = await connectWallet(provider);
      setAccount(acct);
      // Snapshot the starting balance so the watching poll can detect the mint (a GROWTH from here).
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await r.json().catch(() => ({} as any));
        if (typeof j.balance === 'number') setStartBal(j.balance);
        clearTimeout(t);
      } catch { /* best-effort snapshot; watching falls back to any-positive */ }
      setPhase('enter');
    } catch (e: any) {
      setErr(String(e?.message ?? e) || 'Could not connect to your wallet.');
    }
  }, [relayUrl, currency, identity.publicHex]);

  const submit = useCallback(async () => {
    if (!account || !params) return;
    const provider = getEthereumProvider();
    if (!provider) { setErr('Wallet disconnected.'); return; }
    // Parse the human amount into the smallest units (USDC = 6 decimals).
    const units = Math.round((parseFloat(amount) || 0) * Math.pow(10, display.amountDecimals));
    if (!(units > 0)) { setErr('Enter an amount greater than zero.'); return; }
    const unitBig = BigInt(units);
    const principalWord = principalToBytes32(params.facade_principal);
    // The user's ckUSDC subaccount is their 32-byte Ed25519 pubkey (the same subaccount the balance
    // poll + pay path read), so the mint lands at the account the wallet already shows.
    const subaccount = identity.publicHex;
    setErr(null);
    setPhase('sending');
    try {
      // 1. approve(helper, amount) on the USDC ERC-20 contract.
      const approveData = encodeApprove(params.helper_address, unitBig);
      await sendTransaction(provider, account, {to: params.erc20_address, data: approveData});
      // 2. depositErc20(usdc, amount, principal, subaccount) on the helper contract.
      const depositData = encodeDepositErc20(params.erc20_address, unitBig, principalWord, subaccount);
      await sendTransaction(provider, account, {to: params.helper_address, data: depositData});
      setPhase('watching');
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/reject|denied|user/i.test(msg) ? 'Transaction not signed.' : (msg || 'Transaction failed.'));
      setPhase('enter');
    }
  }, [account, params, amount, display.amountDecimals, identity.publicHex]);

  // Watching: poll the ckUSDC balance for the mint. The minter scrapes ETH logs on a ~3min heartbeat;
  // credit typically lands within ~20min. Any growth from the snapshot (or a positive balance when no
  // snapshot) means the mint landed.
  useEffect(() => {
    if (phase !== 'watching') return;
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await r.json().catch(() => ({} as any));
        if (alive && r.ok && typeof j.balance === 'number') {
          if (startBal == null ? j.balance > 0 : j.balance > startBal) setPhase('done');
        }
      } catch { /* keep watching */ } finally { clearTimeout(t); }
    };
    poll();
    const id = setInterval(poll, POLL.deposit);
    return () => { alive = false; clearInterval(id); };
  }, [phase, relayUrl, identity.publicHex, currency, startBal]);

  const fmt = (n: number) => fmtAsset(n, display.amountDecimals, display.nativeAsset);

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
        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
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
            <Pressable testID="btn-connect-wallet" accessibilityRole="button" accessibilityLabel="Connect Ethereum wallet" style={S.primaryWide} onPress={connect}>
              <Text style={S.primaryText}>Connect wallet</Text>
            </Pressable>
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
              {/* M9: one clear line — no "scrapes" jargon, no duplicate ~20min (confirmation + credit). */}
              <Text testID="ckerc20-status" style={S.paidSub}>Waiting for confirmation — your ckUSDC will appear in about 20 minutes.</Text>
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
