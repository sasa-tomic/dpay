import {useEffect, useState} from 'react';
import {Pressable, Text, TextInput, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {IconChevronLeft, IconClose, IconPlus} from './icons';
import {shortAddress} from './AddressField';
import {resolveDestination} from './SendSheet';
import {isValidSolanaAddress} from '../solana/identity';
import {forgetAddress, loadAddressBook, rememberAddress, type SavedAddress} from '../services/addressBook';
import type {AssetId} from '../lib/types';

/**
 * The ADDRESS BOOK route (2026-09-14, founder: "the address book needs to be shown somewhere in
 * the UI"). The store itself (services/addressBook.ts) is older: the send forms have always
 * auto-saved settled destinations and offered them back as chips — but the only way to SEE the
 * book was to open a send form, and the only way to edit a name was to send again. This route is
 * the browse/edit surface: every saved destination across every asset, renameable and removable,
 * plus a manual add for the first send to a known payee.
 *
 * STRUCTURE copies the accounts route (AccountsTab): a route header with Back (returns to the
 * surface the route was opened from — Wallet's addressesFrom ref), then the list. It is per-asset
 * because the store is per-asset (a destination is only valid on its own rail — an IC principal
 * cannot receive SOL), so the sections ARE the honesty mechanism: you can never see an address
 * without the rail it belongs to.
 *
 * VALIDATION reuses the send path's own resolvers — `resolveDestination` for IC assets (shape +
 * core checksum, canonicalised) and `isValidSolanaAddress` for SOL — so an address this screen
 * accepts is exactly an address the send form would accept. No second opinion to drift.
 *
 * ENTRY POINTS: the Settings row (browse/edit — deliberate, unobtrusive) and the send form's
 * "Address book" link beside the saved-address chips (contextual, appears exactly when the user
 * is thinking about destinations). Both funnel here; both are documented in Wallet.tsx.
 */
export function AddressesTab({
  assets, catalog, onBack, onBookChanged,
}: {
  /** The wallet's selectable assets, in catalog order — defines the sections and the add-form picker. */
  assets: SelectableAsset[];
  /** The IC ledger catalog, indexed by ledger id — supplies the descriptor `resolveDestination` needs. */
  catalog: CurrencyDescriptor[];
  /** Route back — Wallet's closeAddresses (returns to the surface the route was opened from). */
  onBack: () => void;
  /** Fired after every successful add/rename/remove. Wallet bumps its address-book revision so
   *  history annotations (name beside a past payment) refresh even when the history array itself
   *  did not change. */
  onBookChanged: () => void;
}) {
  // One book per asset id, as loaded from storage. Never optimistically mutated: every write goes
  // through the service and is replaced by exactly what the service returned (the MRU-capped,
  // normalised list — the same discipline the send forms follow).
  const [books, setBooks] = useState<Partial<Record<AssetId, SavedAddress[]>>>({});
  const [loaded, setLoaded] = useState(false);

  // The add form. `addAsset` is pre-switchable because a book that is empty for one asset is
  // non-empty for another, and the user should not have to cancel to fix a wrong-rail paste —
  // the address stays, the rail switches (the same "paste first, route second" grammar as the
  // send form). Open by default when the whole book is empty: founder rule — an empty view shows
  // its way out, and here the way out is the form itself.
  const [addOpen, setAddOpen] = useState(false);
  const [addAsset, setAddAsset] = useState<AssetId | null>(null);
  const [addAddress, setAddAddress] = useState('');
  const [addName, setAddName] = useState('');
  // IC resolution is async (core validation); null = nothing resolved yet (empty input or in
  // flight). SOL validation is a synchronous local decode and never touches this state.
  const [icStatus, setIcStatus] = useState<string | null>(null);

  // Inline rename for one row: the address is the identity and is NOT editable (editing an
  // address is a new entry); only the label changes. rememberAddress updates in place.
  const [renaming, setRenaming] = useState<{asset: AssetId; address: string} | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => {
    let alive = true;
    // One load per asset key. The service never throws (storage failures degrade to [] with a
    // warn), so there is no error branch to render — an unreadable book IS an empty book here,
    // and the warn in the console is the record.
    Promise.all(assets.map(a => loadAddressBook(a.id))).then(lists => {
      if (!alive) return;
      const next: Partial<Record<AssetId, SavedAddress[]>> = {};
      assets.forEach((a, i) => { next[a.id] = lists[i]; });
      setBooks(next);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [assets]);

  // Resolve the add-form destination against the currently chosen asset, debounced like the send
  // form: every keystroke re-runs shape detection + (for IC) core validation, and the status line
  // under the input is the same refusal copy the send form shows. A rail switch resets the
  // resolution — an IC principal means nothing on Solana and vice versa.
  useEffect(() => {
    const asset = assets.find(a => a.id === addAsset);
    if (!asset || asset.protocol !== 'ic') { setIcStatus(null); return; }
    const text = addAddress.trim();
    if (text === '') { setIcStatus(null); return; }
    // The catalog is a FLAT list (mainnet then testnet rows), not an id-indexed array — the same
    // `.find(c => c.currency === …)` every other consumer uses. A missing descriptor (asset built
    // from a different catalog than the one passed in) refuses rather than crashes: unrecognised
    // is the honest verdict when the rail cannot even be named.
    const desc = catalog.find(c => c.currency === asset.currency) ?? null;
    let alive = true;
    const timer = setTimeout(() => {
      // selfPrincipal is null: this screen has no in-flight self-send to warn about, and a user
      // saving their OWN address (a deposit target) is legitimate — the resolver skips the
      // own-subaccount check rather than refusing (same contract SendSheet passes null for).
      // Uninvoked-template fix: this key is a `(asset) => string` message — every other caller
      // (SendSheet, SolanaWithdrawSheet) names the asset; the branch's own comment already chose
      // this string as the honest verdict when the catalog cannot even name the rail.
      if (desc === null) { if (alive) setIcStatus(M.withdraw.send.refuseUnrecognised(asset.symbol)); return; }
      resolveDestination(text, desc, null).then(res => {
        if (alive) setIcStatus(res.ok ? null : res.message);
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [addAddress, addAsset, assets, catalog]);

  const addSol = assets.find(a => a.id === addAsset)?.protocol === 'solana';
  const addAddressTrimmed = addAddress.trim();
  // Save is armed only when the resolver says yes. SOL: the local base58 decode. IC: the absence
  // of a refusal (resolveDestination already canonicalised the destination we will store).
  const addOk = addAsset !== null && addAddressTrimmed !== '' && (addSol ? isValidSolanaAddress(addAddressTrimmed) : icStatus === null);

  const startAdd = (asset: AssetId) => {
    setAddOpen(true);
    setAddAsset(asset);
  };

  const commitAdd = async () => {
    if (!addOk || addAsset === null) return;
    const asset = assets.find(a => a.id === addAsset);
    if (!asset) return;
    // IC destinations store the CANONICAL form the resolver returned (same as the send form's
    // settle path) — a pasted-but-equivalent spelling normalises once, at save time. SOL is
    // base58 case-significant and is stored verbatim (same as the withdraw sheet).
    const destination = asset.protocol === 'solana'
      ? addAddressTrimmed
      : await resolveIc(addAddressTrimmed, catalog.find(c => c.currency === asset.currency) ?? null);
    if (destination === null) return;
    void rememberAddress(addAsset, destination, addName.trim(), Date.now()).then(book => {
      setBooks(prev => ({...prev, [addAsset]: book}));
      onBookChanged();
      setAddOpen(false);
      setAddAddress('');
      setAddName('');
      setIcStatus(null);
    });
  };

  const commitRename = () => {
    if (!renaming) return;
    const {asset, address} = renaming;
    void rememberAddress(asset, address, renameText.trim(), Date.now()).then(book => {
      setBooks(prev => ({...prev, [asset]: book}));
      onBookChanged();
      setRenaming(null);
    });
  };

  const remove = (asset: AssetId, address: string) => {
    void forgetAddress(asset, address).then(book => {
      setBooks(prev => ({...prev, [asset]: book}));
      onBookChanged();
    });
  };

  const sections = assets.filter(a => (books[a.id]?.length ?? 0) > 0);
  const anySaved = sections.length > 0;

  return (
    <View style={S.accountsWrap}>
      <View style={S.routeHeaderRow}>
        <Pressable
          testID="btn-addresses-back"
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.addressBook.back}
          accessibilityState={{disabled: false}}>
          <IconChevronLeft size={26} color={C.sub2} />
        </Pressable>
        <Text style={S.routeHeaderTitle}>{M.wallet.addressBook.title}</Text>
        <View style={S.routeHeaderSpacer} />
      </View>
      <Text style={S.dim2}>{M.wallet.addressBook.intro}</Text>

      {/* The add form, or its entry button. One form for every asset (the rail is a chip row, not
          a per-section duplicate) — the same "which rail?" question the send flow asks, asked the
          same way. */}
      {addOpen ? (
        <View testID="addresses-add-form" style={S.settingsSection}>
          <Text style={S.inputLabel}>{M.wallet.addressBook.assetLabel}</Text>
          <View style={S.filterRow}>
            {assets.map(a => {
              const active = a.id === addAsset;
              return (
                <Pressable
                  key={a.id}
                  testID={`addr-add-asset-${a.testKey}`}
                  style={active ? S.filterChipActive : S.filterChip}
                  onPress={() => { setAddAsset(a.id); setIcStatus(null); }}
                  accessibilityRole="button"
                  accessibilityLabel={a.networkLabel}
                  accessibilityState={{selected: active, disabled: false}}>
                  <Text style={active ? S.filterChipTextActive : S.filterChipText}>{a.symbol}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={S.inputLabel}>{M.wallet.addressBook.addressLabel}</Text>
          <TextInput
            testID="addr-add-address-input"
            accessibilityLabel={M.wallet.addressBook.addressLabel}
            accessibilityHint={M.wallet.addressBook.addressHint}
            style={S.withdrawAddrInput}
            value={addAddress}
            onChangeText={setAddAddress}
            placeholder={M.wallet.addressBook.addressPlaceholder}
            placeholderTextColor={C.sub2}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {icStatus !== null ? <Text testID="addr-add-status" style={S.err}>{icStatus}</Text> : null}
          {addSol && addAddressTrimmed !== '' && !isValidSolanaAddress(addAddressTrimmed) ? (
            <Text testID="addr-add-status" style={S.err}>{M.withdraw.badAddress('Solana')}</Text>
          ) : null}

          <Text style={S.inputLabel}>{M.wallet.addressBook.nameLabel}</Text>
          <TextInput
            testID="addr-add-name-input"
            accessibilityLabel={M.wallet.addressBook.nameLabel}
            style={S.withdrawAddrInput}
            value={addName}
            onChangeText={setAddName}
            placeholder={M.wallet.addressBook.namePlaceholder}
            placeholderTextColor={C.sub2}
            autoCapitalize="words"
          />

          <Pressable
            testID="btn-addresses-save"
            style={[S.secondaryBtn, !addOk && S.disabledFlat]}
            disabled={!addOk}
            onPress={commitAdd}
            accessibilityRole="button"
            accessibilityLabel={M.wallet.addressBook.save}
            accessibilityState={{disabled: !addOk}}>
            <Text style={[S.secondaryBtnText, !addOk && S.disabledText]}>{M.wallet.addressBook.save}</Text>
          </Pressable>
          <Pressable
            testID="btn-addresses-cancel"
            style={S.linkBtn}
            onPress={() => { setAddOpen(false); setAddAddress(''); setAddName(''); setIcStatus(null); }}
            accessibilityRole="button"
            accessibilityLabel={M.common.cancel}
            accessibilityState={{disabled: false}}>
            <Text style={S.linkTextMuted}>{M.common.cancel}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          testID="btn-addresses-add"
          style={S.ghostBtn}
          onPress={() => startAdd(assets[0]?.id ?? null)}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.addressBook.addEntry}
          accessibilityState={{disabled: false}}>
          <IconPlus size={18} color={C.brandText} />
          <Text style={S.ghostBtnText}>{M.wallet.addressBook.addEntry}</Text>
        </Pressable>
      )}

      {/* Empty book: the sentence names BOTH ways in (they are the same store) — founder rule, an
          empty view carries its way out instead of dead-ending. Rendered only after the async
          load completes so a populated book never flashes through this state. */}
      {loaded && !anySaved && !addOpen ? (
        <Text testID="addresses-empty" style={S.dim2}>{M.wallet.addressBook.empty}</Text>
      ) : null}

      <View style={S.accountsList} testID="addresses-list">
        {sections.map(a => (
          <View key={a.id} style={S.settingsSection}>
            <Text style={S.inputLabel}>{a.networkLabel}</Text>
            {(books[a.id] ?? []).map(entry => {
              const renamingThis = renaming?.asset === a.id && renaming.address === entry.address;
              return (
                <View key={entry.address} testID={`addr-row-${a.testKey}-${entry.address.slice(0, 8)}`} style={S.savedRow}>
                  <View style={S.savedAddrCol}>
                    <Text style={S.savedAddrLabel}>{entry.label || M.withdraw.send.unnamed}</Text>
                    <Text style={S.savedAddrText}>{shortAddress(entry.address)}</Text>
                  </View>
                  {renamingThis ? (
                    <>
                      <TextInput
                        testID={`addr-rename-input-${a.testKey}`}
                        accessibilityLabel={M.wallet.addressBook.nameLabel}
                        style={S.renameInput}
                        value={renameText}
                        onChangeText={setRenameText}
                        autoCapitalize="words"
                      />
                      <Pressable
                        testID={`addr-rename-save-${a.testKey}`}
                        style={S.savedForget}
                        onPress={commitRename}
                        accessibilityRole="button"
                        accessibilityLabel={M.common.done}
                        accessibilityState={{disabled: false}}>
                        <Text style={S.linkText}>{M.common.done}</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      testID={`addr-rename-${a.testKey}-${entry.address.slice(0, 8)}`}
                      style={S.savedForget}
                      onPress={() => { setRenaming({asset: a.id, address: entry.address}); setRenameText(entry.label); }}
                      accessibilityRole="button"
                      accessibilityLabel={M.wallet.addressBook.rename}
                      accessibilityHint={M.wallet.addressBook.renameHint(entry.label || shortAddress(entry.address))}
                      accessibilityState={{disabled: false}}>
                      <Text style={S.linkTextMuted}>{M.wallet.addressBook.rename}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    testID={`addr-forget-${a.testKey}-${entry.address.slice(0, 8)}`}
                    style={S.savedForget}
                    onPress={() => remove(a.id, entry.address)}
                    accessibilityRole="button"
                    accessibilityLabel={M.withdraw.send.forgetLabel(shortAddress(entry.address))}
                    accessibilityState={{disabled: false}}>
                    <IconClose size={14} color={C.sub2} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

/** Canonicalise an IC destination for storage, or null when it does not resolve. Same resolver as
 *  the status line, awaited synchronously here only because `commitAdd` is already gated on the
 *  debounced resolution having come back clean — this re-run is the one that produces the string
 *  we persist, so the stored form and the shown status can never disagree. */
async function resolveIc(text: string, desc: CurrencyDescriptor | null): Promise<string | null> {
  if (desc === null) return null;
  const res = await resolveDestination(text, desc, null);
  return res.ok ? res.destination : null;
}
