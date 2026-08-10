import {View, Text, Pressable} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {
  type CurrencyDescriptor,
  familyDisplay,
  assetTestKey,
  displayName,
  fmtCurrencyAmount,
  isTestnetCurrency,
  testnetDisplayName,
} from '../config/catalog';
import {cmpRaw} from '../lib/amount';
import {fmtAsset} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';

// Shared currency row — the single presentational component consumed by BOTH the BalancesSheet
// (variant='card') and the ReceiveMode CurrencyPicker (variant='plain'). Closes founder issues #2
// (unify IC + SOL in one list) + #3 (two selectors must look/work the same): one component, one
// active indicator (brand dot + trailing ✓ check), one subtitle logic.
//
// testID contract (preserves the e2e net byte-for-byte):
//   • variant='card': renders <View testID={testId}>…<Pressable testID={`${testId}-select`}>…</Pressable>…</View>
//     → matches the existing `asset-<key>` (container) + `asset-<key>-select` (inner Pressable) pattern.
//   • variant='plain': renders <Pressable testID={testId}>…</Pressable> → matches `req-pick-<key>`.
//
// Active indicator (UNIFIED across both variants): the `dot` turns C.brand when active AND a `✓`
// check renders at the row's trailing edge. The card variant KEEPS its brand left-edge
// (assetCardActive) as a card-level affordance — the dot+check is the primary shared cue.
export type CurrencyRowProps = {
  testId: string;                  // base testID — 'asset-ckbtc' (card) | 'req-pick-ckbtc' (plain)
  name: string;                    // 'BTC' | 'USDC' | 'SOL' | 'DEMO'
  subtitle?: string;               // chain label / curated description
  amount?: string;                 // '0.00050000 BTC' (card); omit in plain (the picker is a selector)
  active: boolean;                 // selects dot color + check mark + (card) left-edge
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  variant: 'card' | 'plain';       // card = Balances assetCard chrome; plain = picker pickItem
  showCheck?: boolean;             // render ✓ when active (default true in BOTH → unified indicator)
  zero?: boolean;                  // dim the amount (unfunded asset → assetCardZero); card variant only
  actions?: React.ReactNode;       // DEMO faucet button slot (card variant only)
  children?: React.ReactNode;      // extra nodes below the subtitle (topUpErr line; card variant only)
};

export function CurrencyRow({testId, name, subtitle, amount, active, onPress, accessibilityLabel, accessibilityHint, variant, showCheck = true, zero, actions, children}: CurrencyRowProps) {
  const check = active && showCheck ? <Text style={S.pickCheck}>✓</Text> : null;
  const dot = <View style={[S.dot, {backgroundColor: active ? C.brand : C.line}]} />;

  if (variant === 'plain') {
    // Plain variant (the Receive picker): a bare Pressable (no card chrome) — dot + name/subtitle
    // column + trailing ✓. The amount is OMITTED (the picker is a selector, not a balance list).
    return (
      <Pressable
        testID={testId}
        style={S.pickItem}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{disabled: false}}
      >
        {dot}
        <View style={S.pickTextCol}>
          <Text style={S.pickName}>{name}</Text>
          {subtitle ? <Text style={S.pickSubtitle}>{subtitle}</Text> : null}
        </View>
        {check}
      </Pressable>
    );
  }

  // Card variant (BalancesSheet): a container View (assetCard, optional assetCardActive) with an
  // assetRow holding the select Pressable (dot + name + amount + ✓) and an optional actions sibling
  // (the DEMO faucet button). The subtitle renders full-width below the row; children (topUpErr)
  // below that. The container View keeps `asset-<key>`; the Pressable carries `asset-<key>-select`.
  return (
    <View testID={testId} style={[S.assetCard, active && S.assetCardActive]}>
      <View style={S.assetRow}>
        <Pressable
          testID={`${testId}-select`}
          style={S.assetSelect}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityState={{disabled: false}}
        >
          {dot}
          <Text style={S.assetLabel}>{name}</Text>
          {amount != null ? <Text style={[S.assetAmt, zero && S.assetCardZero]}>{amount}</Text> : null}
          {check}
        </Pressable>
        {actions ? <View style={S.assetActions}>{actions}</View> : null}
      </View>
      {subtitle ? <Text style={S.assetSub}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

// --- unified currency list builder (UI-layer concern — SOL stays OUT of the catalog) --------------
// A pure helper that produces ONE ordered list of currency rows for BOTH selectors. IC items come
// from the catalog (one per visible entry); a single synthetic SOL item is appended when
// `solAddress` is non-null (mirrors BalancesSheet's existing gate). Subtitles are extracted from the
// SAME curated logic BalancesSheet inlined (BTC→"Bitcoin", USDC/USDT→"US dollar stablecoin", testnet
// →network, DEMO→"play money for testing", SOL→"Solana · self-custody") so both selectors render
// identical labels. This is a UI concern, NOT a catalog change — SOL is a device-key rail with no
// ICRC ledger; forcing it into CurrencyDescriptor would contaminate every catalog helper.
export type CurrencyListItem =
  | {kind: 'ic'; desc: CurrencyDescriptor; key: string; name: string; subtitle: string;
     amountText: string | null; zero: boolean; active: boolean}
  | {kind: 'sol'; key: 'sol'; name: 'SOL'; subtitle: string;
     amountText: string | null; zero: boolean; active: boolean};

// The curated subtitle for an IC catalog currency. Extracted verbatim from BalancesSheet's former
// inline logic so the two selectors render identical subtitles (Issue 3 parity).
function icSubtitle(catalog: CurrencyDescriptor[], a: CurrencyDescriptor): string {
  const isPrimary = a.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(a);
  if (isPrimary) return 'play money for testing';
  if (testnet) return a.network ?? 'testnet';
  if (a.minter_family === 'CkBtcUtxo') return 'Bitcoin';
  if (a.minter_family === 'CkEthErc20' && (a.backing_symbol === 'USDC' || a.backing_symbol === 'USDT')) return 'US dollar stablecoin';
  return familyDisplay(catalog, a.currency)?.networkLabel ?? 'Unsupported asset';
}

// The display name for an IC catalog currency (DEMO / testnet-display / backing-symbol).
function icName(a: CurrencyDescriptor): string {
  const isPrimary = a.currency === 0;
  const testnet = !isPrimary && isTestnetCurrency(a);
  return isPrimary ? 'DEMO' : (testnet ? testnetDisplayName(a) : displayName(a));
}

// The stable ASCII testID key for an IC catalog currency.
function icKey(a: CurrencyDescriptor): string {
  return a.currency === 0 ? 'demo' : assetTestKey(a);
}

export function buildCurrencyList(args: {
  catalog: CurrencyDescriptor[];
  assetBalances: Record<number, string>;
  primaryBalance: string | null;
  online: boolean;
  showTestnet: boolean;
  currentCurrency: number;
  activeSol: boolean;
  solAddress: string | null;
  solBalance: string | null;
}): CurrencyListItem[] {
  const {catalog, assetBalances, primaryBalance, online, showTestnet, currentCurrency, activeSol, solAddress, solBalance} = args;
  // Mirror BalancesSheet's testnet filter: hide testnet currencies unless opted in app-wide.
  const visibleCatalog = showTestnet ? catalog : catalog.filter(a => !isTestnetCurrency(a));
  const items: CurrencyListItem[] = visibleCatalog.map(a => {
    const isPrimary = a.currency === 0;
    const assetBal = assetBalances[a.currency] ?? '0';
    // MC1 units 2-4: balance presence via `cmpRaw` (BigInt) — never `> 0` on a string.
    const funded = !isPrimary && cmpRaw(assetBal, '0') > 0;
    const balanceText = isPrimary
      ? (primaryBalance == null ? '—' : `${online ? '' : '~'}${fmtCurrencyAmount(catalog, a.currency, primaryBalance)}`)
      : fmtCurrencyAmount(catalog, a.currency, assetBal);
    return {
      kind: 'ic' as const,
      desc: a,
      key: icKey(a),
      name: icName(a),
      subtitle: icSubtitle(catalog, a),
      amountText: balanceText,
      // DEMO never dims; a non-DEMO IC asset dims when unfunded (mirrors the former `[S.assetAmt, !funded && S.assetCardZero]`).
      zero: !isPrimary && !funded,
      active: a.currency === currentCurrency,
    };
  });
  // SOL appended only when the device key is derived (mirrors BalancesSheet's existing gate).
  if (solAddress) {
    items.push({
      kind: 'sol' as const,
      key: 'sol',
      name: 'SOL',
      subtitle: 'Solana · self-custody',
      amountText: solBalance == null ? '—' : fmtAsset(solBalance, SOL_DECIMALS, SOL_UNIT),
      zero: solBalance == null || cmpRaw(solBalance, '0') === 0,
      active: activeSol,
    });
  }
  return items;
}
