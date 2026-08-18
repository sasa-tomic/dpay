import {StyleSheet} from 'react-native';
import {C, FONT} from './config/palette';

// "Traveler Paper" — the 2026-08-17 complete redesign. Warm porcelain surfaces, ink text,
// tangerine reserved for action. Depth comes from layered surfaces + soft ink-tinted shadows,
// never neon glows. Space Grotesk carries UI + numerals (the signature look); IBM Plex Mono
// carries addresses, seeds, eyebrows — the "receipt" voice.

// Soft ink shadow used by raised surfaces (cards, primary buttons). iOS shadow + Android
// elevation pair so the lift reads on both platforms.
const LIFT = {
  shadowColor: '#1B1A17',
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: {width: 0, height: 4},
  elevation: 2,
} as const;
const LIFT_SM = {
  shadowColor: '#1B1A17',
  shadowOpacity: 0.05,
  shadowRadius: 8,
  shadowOffset: {width: 0, height: 3},
  elevation: 1,
} as const;

export const S = StyleSheet.create({
  // The app column. `width:'100%'` keeps it full-bleed on phones (and the e2e 390px viewport);
  // `maxWidth:480` caps it on desktop so a 1280px laptop shows an intentional centered phone-width
  // column instead of a stretched sheet. Centered by the `screenFrame` wrapper in App.tsx.
  root: {flex: 1, backgroundColor: C.bg, width: '100%', maxWidth: 480},
  // Content scroller. `flex:1` makes the ScrollView FILL the remaining column height below the
  // header/tabs (a bare ScrollView with no style sizes to its content, so short screens like the
  // Paid phase left a dead zone below the content and flexGrow on children had no bounded parent to
  // expand into). With this filling the column, `.body` (contentContainer) flexGrow:1 then fills the
  // scroller, and the mode surface `.center` flexGrow:1 fills the gap above the asset rail.
  scroll: {flex: 1},
  // Desktop frame: fills the whole viewport with the porcelain bg and centers the capped app
  // column. At <=480px it is a no-op (the column is already full-width).
  screenFrame: {flex: 1, backgroundColor: C.bg, alignItems: 'center'},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  // Onboarding ScrollView contentContainer. `flexGrow` (NOT `flex:1`): flex clamps the content
  // height to the scroll frame, which structurally DISABLES scrolling — on a small screen the
  // seed-backup gate overflowed with the Continue button unreachable. flexGrow lets short content
  // still fill + center the frame while tall content grows past it and scrolls.
  onboard: {flexGrow: 1, padding: 24, justifyContent: 'center', alignItems: 'center'},
  wordmark: {fontSize: 27, fontWeight: '700', letterSpacing: -0.8, color: C.ink, fontFamily: FONT.sansBold},
  wordmarkPay: {color: C.brand},
  wordmarkBig: {fontSize: 36, marginTop: 14},
  onboardSub: {fontSize: 15, color: C.sub, textAlign: 'center', marginTop: 8, marginBottom: 28, paddingHorizontal: 12, lineHeight: 22, fontFamily: FONT.sans},
  // ∂ is the demo-dollar symbol — unfamiliar on first glance. The onboarding one-liner explains
  // it inline next to the demo funds note so a first-time user has the mapping before they see
  // their balance. `dpayGlyph` carries the glyph in ink; `dpayGlyphNote` is the surrounding line.
  dpayGlyph: {color: C.ink, fontWeight: '700', fontFamily: FONT.sansBold},
  dpayGlyphNote: {fontSize: 13, color: C.sub, marginTop: 4, textAlign: 'center', paddingHorizontal: 12, lineHeight: 18, fontFamily: FONT.sans},
  usernameInput: {backgroundColor: C.field, borderRadius: 16, height: 56, paddingHorizontal: 18, fontSize: 20, color: C.ink, marginBottom: 8, borderWidth: 1, borderColor: C.line2, alignSelf: 'stretch', fontFamily: FONT.sansMedium, ...LIFT_SM},
  // Restore-mode recovery-seed input (64 hex chars). Like usernameInput but monospace + multiline so
  // the long seed wraps readably; minHeight instead of fixed height so it grows with content.
  seedInput: {backgroundColor: C.field, borderRadius: 16, minHeight: 56, paddingHorizontal: 18, paddingVertical: 14, fontSize: 16, fontFamily: FONT.mono, color: C.ink, marginBottom: 8, borderWidth: 1, borderColor: C.line2, alignSelf: 'stretch'},
  // Header — borderless on porcelain (whitespace separates chrome from content; hairlines under
  // the header read as spreadsheet chrome). Balanced horizontal padding.
  header: {paddingTop: 16, paddingLeft: 16, paddingRight: 16, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'},
  headerLeft: {flexDirection: 'row', alignItems: 'flex-start', gap: 4},
  headerSettingsBtn: {width: 40, height: 40, borderRadius: 14, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line2},
  brand: {fontSize: 24},
  // ACCOUNT eyebrow above the username separates the wordmark "∂pay" from the user identity so
  // the pair no longer reads as a single currency label. Mono = the receipt voice. The `who` line
  // below stays the authoritative username text (e2e `header-who` reads it verbatim).
  whoLabel: {fontSize: 10, fontWeight: '600', color: C.sub2, marginTop: 6, letterSpacing: 1.2, textTransform: 'uppercase', fontFamily: FONT.mono},
  who: {fontSize: 13, color: C.sub, marginTop: 2, fontFamily: FONT.sansMedium},
  // NFC takeover badge — a soft ring on porcelain (no filled disc); the glyph/icon carries tone.
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 3, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '700', color: C.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.4},
  nfcSub: {fontSize: 15, color: C.sub, marginTop: 10, textAlign: 'center', paddingHorizontal: 20, fontFamily: FONT.sans},
  balBox: {alignItems: 'flex-end'},
  // The header balance pressable's outer row: the label+value column, then the A hotkey badge
  // at the far right edge (DOM order label → value → badge, mirroring the tab-bar badge pattern).
  balHeaderRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  balAmtRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  topUpErr: {fontSize: 13, color: C.bad, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: C.sub, fontFamily: FONT.sansMedium},
  balAmt: {fontSize: 28, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  // The transient Android back-to-exit hint under the header balance (inline Text, not a
  // toast — no native module, matches the caption tone but with a warn tint for visibility).
  balBackHint: {fontSize: 12, color: C.warn, marginTop: 6, fontFamily: FONT.sansMedium},
  // Tabs — primary nav: inactive = white card pills with hairlines; active = tangerine fill.
  tabs: {flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginTop: 4, marginBottom: 6},
  tab: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 999, backgroundColor: C.card, minHeight: 44, borderWidth: 1, borderColor: C.line2},
  tabActive: {backgroundColor: C.brand, borderColor: C.brand, ...LIFT},
  tabText: {color: C.sub, fontWeight: '600', fontFamily: FONT.sansMedium},
  tabTextActive: {color: C.brandInk, fontFamily: FONT.sansBold},
  // Mode toggle — a joined two-segment pill control at the top of the Pay/Receive tab bodies:
  // `[ Scan to pay | Send to address ]` (Pay) and `[ Request payment | My address ]` (Receive).
  // Inset well (panel2) + white active segment + ink text: the editorial segmented control,
  // deliberately quieter than the tangerine tabs so nav stays the loudest level.
  // `railRow` is the joined container; `railPill` is each half-width segment.
  railRow: {flexDirection: 'row', gap: 4, marginTop: 2, marginBottom: 14, backgroundColor: C.panel2, borderRadius: 999, padding: 4, alignSelf: 'stretch', borderWidth: 1, borderColor: C.line2},
  railPill: {flex: 1, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', minHeight: 40},
  railPillActive: {backgroundColor: C.card, ...LIFT_SM},
  railPillText: {color: C.sub, fontWeight: '600', fontSize: 14, fontFamily: FONT.sansMedium},
  railPillTextActive: {color: C.ink, fontFamily: FONT.sansBold},
  // Body — content flows from the top; the asset rail follows naturally.
  body: {flexGrow: 1, paddingHorizontal: 16, paddingTop: 10, justifyContent: 'flex-start'},
  // Mode surface (Pay/Receive phase views + the NFC status takeover). Grows to fill the space
  // between the tabs and the asset rail, and VERTICALLY centers its content — so a sparse phase
  // (scan/review/paid/result) no longer packs itself at the top and leaves a dead zone below.
  // `flexShrink:0` keeps tall content from being clipped: when a phase's content exceeds the free
  // space it grows the surface (and the parent ScrollView scrolls) instead of being squashed.
  center: {flexGrow: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'center'},
  label: {fontSize: 15, color: C.sub, marginBottom: 10, textAlign: 'center', fontFamily: FONT.sans},
  err: {color: C.bad, fontSize: 14, textAlign: 'center', marginTop: 10, fontFamily: FONT.sansMedium},
  dim: {opacity: 0.55},
  // Disabled state for RAISED primary buttons. `dim` layered over the shadow is indistinguishable
  // from enabled, so a disabled money button reads as tappable. `disabledFlat` kills BOTH the
  // Android elevation AND the iOS shadow (the lift dies on each platform where it lives) and drops
  // opacity further. Used ONLY on primary/primaryWide sites; non-raised surfaces keep `dim`.
  disabledFlat: {opacity: 0.4, elevation: 0, shadowOpacity: 0},
  dim2: {fontSize: 13, color: C.sub, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  // Camera viewfinder — fills the content column (`alignSelf:'stretch'` overrides the parent's
  // centering; `aspectRatio:1` keeps it square). A WARM-black frame on porcelain: the viewport
  // into the world stays dark by nature; the porcelain around it frames it like a photo print.
  camBox: {alignSelf: 'stretch', aspectRatio: 1, borderRadius: 24, overflow: 'hidden', backgroundColor: '#17150F', borderWidth: 1, borderColor: C.line, ...LIFT},
  // Wrapper for a scan phase's QrScanner + hint text. MUST be alignSelf:'stretch' (full width):
  // camBox sizes itself by stretch + aspectRatio, so an unstyled/content-width wrapper leaves camBox
  // with no resolvable width and it collapses to 0x0 (the 2026-08-14 SOL scan black-box bug —
  // camera mounted and live but invisible; gated on-device by `just campreview`).
  scanWrap: {alignSelf: 'stretch'},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 32, fontWeight: '700', color: C.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.6},
  reviewTo: {fontSize: 17, color: C.sub, marginTop: 6, textAlign: 'center', fontFamily: FONT.sansMedium},
  warnNote: {fontSize: 13, color: C.warn, textAlign: 'center', marginTop: -10, marginBottom: 18, paddingHorizontal: 8, lineHeight: 18, fontFamily: FONT.sans},
  // Icon-led warning row: IconAlert + text where a warning previously LED with a '⚠' text
  // glyph. Mirrors warnNote's sizing/margins in row form; the icon tops the first line so a
  // wrapped body doesn't drag it off-center.
  warnRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: -10, marginBottom: 18, paddingHorizontal: 8},
  warnRowText: {flex: 1, fontSize: 13, color: C.warn, lineHeight: 18, fontFamily: FONT.sans},
  // Primary action button — stretched full-width, tangerine fill, soft lift (no neon glow; the
  // porcelain design gets its energy from color, not emission). Row layout + gap so a leading
  // icon sits inline. `primaryWide` is the same chrome (kept for the Receive Request button).
  primary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.brand, borderRadius: 16, height: 56, alignSelf: 'stretch', paddingHorizontal: 24, marginTop: 14, shadowColor: C.brand2, shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  primaryWide: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C.brand, borderRadius: 16, height: 56, alignSelf: 'stretch', marginTop: 14, shadowColor: C.brand2, shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '700', fontFamily: FONT.sansBold},
  qrCard: {backgroundColor: '#ffffff', padding: 20, borderRadius: 20, borderWidth: 1, borderColor: C.line2, marginBottom: 14, ...LIFT},
  amountBig: {fontSize: 26, fontWeight: '700', color: C.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.4},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: C.ok, backgroundColor: 'rgba(14,159,110,0.10)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden', fontFamily: FONT.sansMedium},
  qrHint: {marginTop: 12, fontSize: 13, color: C.sub, textAlign: 'center', fontFamily: FONT.sans},
  // Request-QR validity countdown (the signed request expires after EXPIRY_WINDOW; a stale QR scans
  // to a confusing rejection, so the merchant is told how long it's good for).
  qrExpiry: {marginTop: 6, fontSize: 13, color: C.sub, textAlign: 'center', fontFamily: FONT.sans},
  qrExpiryWarn: {marginTop: 6, fontSize: 14, fontWeight: '600', color: C.warn, textAlign: 'center', fontFamily: FONT.sansMedium},
  qrExpired: {marginTop: 6, fontSize: 14, fontWeight: '700', color: C.warn, textAlign: 'center', fontFamily: FONT.sansBold},
  // An inline offline-status pill on the Receive-QR screen — so a merchant staring at "Waiting
  // for payment…" knows they won't see incoming payments until reconnected. Soft bad-tinted pill
  // — informational, not a hard error (the wait state is still valid; the poll reconciles).
  qrOfflinePill: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: 'rgba(229,72,77,0.07)', borderWidth: 1, borderColor: 'rgba(229,72,77,0.28)'},
  qrOfflinePillText: {fontSize: 12, fontWeight: '600', color: C.bad, fontFamily: FONT.sansMedium},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: C.ok, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center', ...LIFT},
  paidBtnText: {color: '#FFFFFF', fontWeight: '700', fontSize: 16, fontFamily: FONT.sansBold},
  notPaidBtn: {backgroundColor: C.card, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.line2},
  notPaidText: {color: C.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18, shadowColor: C.ok, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  checkAlready: {backgroundColor: C.warn, shadowColor: C.warn},
  paidText: {fontSize: 30, fontWeight: '700', color: C.ok, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  alreadyText: {color: C.warn},
  paidSub: {fontSize: 16, color: C.sub, marginTop: 6, fontFamily: FONT.sans},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: C.field, borderRadius: 18, paddingHorizontal: 18, height: 76, alignSelf: 'stretch', borderWidth: 1, borderColor: C.line2, ...LIFT_SM},
  currency: {fontSize: 34, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold},
  amountInput: {flex: 1, fontSize: 34, fontWeight: '700', color: C.ink, marginLeft: 6, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  // Tappable amount-prefix (Receive): wraps the currency glyph + chevron that signals it opens the
  // currency picker. The right border separates it from the typed amount.
  prefixBtn: {flexDirection: 'row', alignItems: 'center', paddingRight: 12, borderRightWidth: 1, borderRightColor: C.line2},
  linkBtn: {marginTop: 18, minHeight: 44, justifyContent: 'center'},
  linkText: {color: C.brand, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  linkTextMuted: {color: C.sub, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Icon+label row inside a `linkBtn` Pressable (Settings' Privacy policy carries the
  // external-link glyph). The Pressable keeps the column linkBtn chrome (44pt target); this row
  // lays a small icon against the label with a hairline gap.
  linkRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  // Ghost button tier — the affordance rule (every action = a button) for the Pay/Receive action
  // rows that were bare text links. A white bordered pill with a leading icon: clearly tappable,
  // but neutral chrome so the tangerine stays reserved for the primary CTA. `ghostBtnMuted` is
  // the quieter variant for flow-reset actions ("New request"/"New payment"/"Back") — transparent
  // bg + fainter border. Same 44pt min + marginTop rhythm as linkBtn, which it replaces there.
  ghostBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.card},
  ghostBtnText: {color: C.sub, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  ghostBtnMuted: {backgroundColor: 'transparent', borderColor: C.line2},
  smallBtn: {backgroundColor: C.brand, borderRadius: 12, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', shadowColor: C.brand2, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 3},
  smallBtnText: {color: C.brandInk, fontWeight: '700', fontFamily: FONT.sansBold},
  // Bordered secondary button (Cancel/secondary action parity with the primary Approve). Same
  // width + height + radius as `primary` so the tap targets are equivalent + the user makes a
  // deliberate choice. White fill + hairline = clearly secondary but unambiguously tappable.
  secondaryBtn: {alignSelf: 'stretch', height: 56, borderRadius: 16, marginTop: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line2, backgroundColor: C.card, minHeight: 44},
  secondaryBtnText: {color: C.sub, fontWeight: '600', fontSize: 17, fontFamily: FONT.sansMedium},
  histTitle: {fontSize: 12, fontWeight: '600', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 6, fontFamily: FONT.mono},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line2},
  histWhoCol: {flex: 1},
  histWho: {fontSize: 15, color: C.ink, fontFamily: FONT.sansMedium},
  histMemo: {fontSize: 12, color: C.sub2, marginTop: 2, fontStyle: 'italic', fontFamily: FONT.sans},
  histAmt: {fontSize: 15, fontWeight: '700', marginRight: 12, fontFamily: FONT.sansBold},
  histTime: {fontSize: 12, color: C.sub2, fontFamily: FONT.mono},
  // Leading direction glyph on each Ledger row (IconArrowDownLeft in / IconArrowUpRight out;
  // t.dir is the reliable 'out' | 'in' field on Txn). alignSelf:center overrides the row's
  // baseline alignment — an Svg has no text baseline to align to.
  histDirIcon: {marginRight: 8, alignSelf: 'center'},
  // Ledger page — the transaction list promoted to its own tab. `ledgerWrap` is the page-level
  // container; `ledgerEmpty` is the muted centered placeholder for a wallet with no transactions.
  ledgerWrap: {marginTop: 4},
  ledgerEmpty: {fontSize: 15, color: C.sub, textAlign: 'center', marginTop: 40, fontFamily: FONT.sans},
  // Asset filter chip row — only renders when >1 currency is present in history. Active chip
  // inverts to the tangerine fill so the selected filter reads as the obvious current view.
  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14},
  filterChip: {paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: C.line2, backgroundColor: C.card, minHeight: 36},
  filterChipActive: {backgroundColor: C.brand, borderColor: C.brand},
  filterChipText: {color: C.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  filterChipTextActive: {color: C.brandInk, fontFamily: FONT.sansBold},
  // Asset card. White card, hairline, soft lift; the brand left edge is ACTIVE-ONLY (neutral when
  // inactive, tangerine when the row is the selected currency) so the selected card pops.
  assetCard: {marginTop: 12, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: C.line2, borderLeftColor: C.line2, borderLeftWidth: 3, ...LIFT_SM},
  assetCardActive: {borderLeftColor: C.brand},
  assetRow: {flexDirection: 'row', alignItems: 'center'},
  // assetSelect — the glyph-led row inside a card: the 38px AssetGlyph chip against the text
  // column, vertically CENTERED (a monogram chip reads correctly centered against the two-line
  // column).
  assetSelect: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  assetSelectBlock: {flex: 1},
  // assetTitleRow — the name + trailing amount/check line at the top of a card row's text column.
  // The label's flex:1 pushes the amount to the right edge; the check trails the amount.
  assetTitleRow: {flexDirection: 'row', alignItems: 'center'},
  assetLabel: {flex: 1, fontSize: 16, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold},
  assetAmt: {fontSize: 16, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold, marginLeft: 10},
  assetSub: {fontSize: 12, color: C.sub2, marginTop: 4, fontFamily: FONT.sans},
  assetActions: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 10},
  assetActionBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.line2, minHeight: 44, backgroundColor: C.card},
  assetActionText: {color: C.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  assetCardZero: {color: C.sub2},
  // AssetGlyph monogram chips (AssetGlyph.tsx) — family-hued rounded squares carrying the native
  // symbol ($ ₿ Ξ ◎ ∂). Size comes in via inline style (width/height/radius/fontSize scale
  // together); the base classes only pin the shared chrome (center, subtle ring) so chips stay
  // crisp at any size. Ring is warm-ink (light theme).
  assetGlyph: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(27,26,23,0.07)'},
  assetGlyphLg: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(27,26,23,0.09)'},
  assetGlyphText: {fontWeight: '700', fontFamily: FONT.sansBold},
  settingsSection: {alignSelf: 'stretch', marginBottom: 28},
  relayInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 14, height: 50, paddingHorizontal: 16, fontSize: 14, color: C.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: C.line2},
  // Advanced relay section — the relay edit is demoted below consumer settings and applied
  // EXPLICITLY via the Apply button (no live retarget on each keystroke). `advancedLabel` is the
  // small uppercase eyebrow shared with the other section headers; `applyBtn` mirrors the primary
  // button chrome but is compact (48pt, 44pt min touch target); `applyBtnDisabled` mutes it when
  // the draft == the active URL.
  advancedLabel: {fontSize: 12, fontWeight: '600', color: C.sub2, alignSelf: 'flex-start', textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 0, fontFamily: FONT.mono},
  // The Advanced disclosure toggle (Settings → Server). The header is itself a Pressable
  // spanning the row (label + caret) so the whole header is the tap target. `advancedLabel`'s
  // bottom margin is zeroed above so the toggle controls its own vertical rhythm.
  advancedToggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingVertical: 10, marginBottom: 4, minHeight: 44},
  // The caret wrapper only needs a style when COLLAPSED (rotate −90° so the chevron points
  // right; expanded = the icon's natural down).
  advancedCaretClosed: {transform: [{rotate: '-90deg'}]},
  applyBtn: {backgroundColor: C.brand, borderRadius: 16, height: 48, minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 16, shadowColor: C.brand2, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 3},
  applyBtnText: {color: C.brandInk, fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold},
  applyBtnDisabled: {opacity: 0.4, shadowOpacity: 0, elevation: 0},
  resetConfirmBox: {alignSelf: 'stretch', backgroundColor: 'rgba(229,72,77,0.05)', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(229,72,77,0.25)'},
  // Reset entry-point — a bordered red-outline button "Reset wallet…" with the ellipsis
  // signaling "opens a dialog". Distinct from the muted "Privacy policy" link above it, but NOT
  // a loud filled-red button (the destructive gate stays in the confirmation dialog).
  resetEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(229,72,77,0.45)', backgroundColor: 'rgba(229,72,77,0.04)', alignItems: 'center', justifyContent: 'center'},
  resetEntryText: {color: C.bad, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Backup affordance (Settings → Backup). Mirrors `resetEntryBtn`'s shape but BRAND-tinted so it
  // reads as a safe, recommended action. `backupConfirmBox` is the neutral caution box;
  // `seedBox` is the revealed seed display: mono, padded, inset well so it reads as a discrete
  // selectable token block.
  backupEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,90,31,0.45)', backgroundColor: 'rgba(255,90,31,0.06)', alignItems: 'center', justifyContent: 'center'},
  backupEntryText: {color: C.brand, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  backupConfirmBox: {alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.line2},
  seedBox: {alignSelf: 'stretch', backgroundColor: C.panel2, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.line2, marginTop: 4},
  seedText: {color: C.ink, fontFamily: FONT.mono, fontSize: 14, lineHeight: 20},
  // Numbered BIP-39 word grid (SeedWords.tsx) — two columns, COLUMN-MAJOR (1-12 down the left,
  // 13-24 down the right, the paper-backup reading order). `seedGrid` is the stretch container;
  // each `seedGridRow` carries one (i, i+12) pair; `flex:1` on the chip keeps both columns
  // equal-width so the grid stays aligned regardless of word length. The chip View carries the
  // mnemonic-word-N testID and e2e reads its textContent with the leading index stripped — the
  // index Text must stay FIRST inside the chip. `seedChipIdx` has a fixed width + right-align so
  // the words of a column start at the same x.
  seedGrid: {alignSelf: 'stretch', gap: 6, marginTop: 4, marginBottom: 8},
  seedGridRow: {flexDirection: 'row', gap: 8},
  seedChip: {flex: 1, flexDirection: 'row', alignItems: 'baseline', backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: C.line2},
  seedChipIdx: {color: C.sub2, fontFamily: FONT.mono, fontSize: 11, marginRight: 6, width: 16, textAlign: 'right'},
  seedChipWord: {color: C.ink, fontFamily: FONT.mono, fontSize: 15},
  // Keyboard-shortcut hint badge (web only — rendered by HotkeyHint). A visible "key cap": a
  // rounded square with a real border + subtle background and a mono letter. `kbdHint` is the
  // light-on-porcelain variant; `kbdHintOnBrand` flips to a white-on-tangerine variant for badges
  // that sit on the filled brand surface (active tab).
  kbdHint: {minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center'},
  kbdHintText: {fontSize: 13, fontWeight: '600', color: C.sub, fontFamily: FONT.mono},
  kbdHintOnBrand: {borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(0,0,0,0.14)'},
  kbdHintTextOnBrand: {color: C.brandInk},
  // Deposit sheet — a full-screen porcelain overlay above the wallet.
  // elevation is REQUIRED alongside zIndex: on Android, sibling draw order follows elevation
  // FIRST (zIndex only breaks ties within the same elevation). Without it, the elevated active
  // tab (tabActive carries LIFT → elevation: 2) rendered ON TOP of this full-screen sheet —
  // the active Pay/Receive/Transactions button visibly bleeding through the Balances/Settings
  // overlays on device (web/iOS honor zIndex, so e2e never saw it). elevation: 10 matches the
  // zIndex intent; the sheet is full-screen + opaque, so the elevation shadow is clipped
  // off-viewport and invisible.
  sheetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, zIndex: 10, elevation: 10},
  sheet: {flex: 1, backgroundColor: C.bg},
  sheetHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingHorizontal: 22, paddingBottom: 14},
  sheetTitle: {fontSize: 20, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold, letterSpacing: -0.3},
  sheetClose: {width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.line2},
  sheetBody: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 22, alignItems: 'center'},
  // Same as sheetBody but vertically CENTERS short content so a sheet with few rows doesn't pack
  // at the top with a dead zone below. Used ONLY on sheets whose content is reliably shorter than
  // the viewport — the tall sheets (DepositSheet address flow, WithdrawSheet form) keep top-aligned
  // sheetBody so their long content scrolls without the RN ScrollView + justifyContent:center
  // top-cutoff gotcha.
  sheetCenter: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingTop: 22, paddingBottom: 22, alignItems: 'center'},
  // Compact currency picker (Receive prefix tap): a centered card over a dimmed backdrop (rendered
  // inside a <Modal>, so it covers the whole screen regardless of where ReceiveMode sits in the
  // tree). `pickCard` uses opaque `C.panel` — an alpha wash would composite with the warm-ink veil
  // into mud; the opaque raised surface is the "panel above backdrop" idiom.
  pickBackdrop: {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(27,26,23,0.45)', paddingHorizontal: 28},
  pickCard: {alignSelf: 'stretch', backgroundColor: C.panel, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: C.line2, ...LIFT},
  pickTitle: {fontSize: 13, fontWeight: '600', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 8, fontFamily: FONT.mono},
  // Bounded scroller for the picker rows — the catalog grows (IC + SOL rails, testnet entries),
  // and a Modal has no scroll surface, so an unbounded list would push the bottom rows off a
  // small screen with no way to reach them. maxHeight only kicks in when the rows actually
  // overflow; a short list renders identically to before.
  pickScroll: {maxHeight: 420},
  pickItem: {flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: C.line2},
  pickName: {flex: 1, fontSize: 16, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold},
  // pickCheck — the trailing active-check wrapper; the margin keeps the icon clear of the
  // amount/label it trails in either variant.
  pickCheck: {marginLeft: 8},
  // pickTextCol — the name+subtitle column right of the AssetGlyph chip, shared by BOTH
  // CurrencyRow variants. Takes flex:1 so the trailing check pushes to the row's right edge; the
  // 10px marginLeft is the chip-to-text gap in both variants.
  pickTextCol: {flex: 1, marginLeft: 10},
  // pickSubtitle — the chain-label line below the name in a plain-variant row.
  pickSubtitle: {fontSize: 12, color: C.sub2, marginTop: 3, fontFamily: FONT.sans},
  // Pay-scan NFC status row — a large colored NFC mark + a short label, leading the scanner. Green
  // when tap-to-pay is ready, red with a tappable "NFC not available" link + reason popup otherwise.
  nfcStatusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14},
  nfcStatusLabel: {fontSize: 18, fontWeight: '700', color: C.ink, fontFamily: FONT.sansBold},
  // Receive QR hint — a small NFC mark leading the "or let them tap" label when the reader is armed.
  nfcHintRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10},
  nfcHintLabel: {fontSize: 15, color: C.sub, textAlign: 'center', fontFamily: FONT.sans},
  nfcInfoLink: {flexDirection: 'row', alignItems: 'center', gap: 5},
  nfcInfoLinkText: {fontSize: 18, fontWeight: '600', color: C.bad, fontFamily: FONT.sansBold},
  nfcInfoBody: {fontSize: 15, color: C.ink, lineHeight: 21, marginBottom: 16, fontFamily: FONT.sans},
  nfcInfoClose: {alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: C.line2, backgroundColor: C.card},
  nfcInfoCloseText: {fontSize: 15, fontWeight: '600', color: C.ink, fontFamily: FONT.sansMedium},
  // Deposit instructions — a scannable card (network/asset + est. time + fee/min + non-custody line).
  instrCard: {alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.line2, marginBottom: 18, ...LIFT_SM},
  instrLine: {fontSize: 15, color: C.ink, textAlign: 'center', lineHeight: 21, marginBottom: 10, fontFamily: FONT.sans},
  instrAsset: {color: C.brand, fontWeight: '700', fontFamily: FONT.sansBold},
  instrMeta: {fontSize: 13, color: C.sub, textAlign: 'center', fontFamily: FONT.mono, paddingVertical: 2},
  instrCustody: {fontSize: 12, color: C.sub2, textAlign: 'center', marginTop: 10, lineHeight: 17, fontFamily: FONT.sans},
  sheetAddr: {fontSize: 13, color: C.ink, fontFamily: FONT.mono, textAlign: 'center', marginTop: 4, marginBottom: 8, letterSpacing: 0.2},
  depositCopy: {alignSelf: 'stretch', marginTop: 12},
  depositStatus: {marginTop: 22, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.line2, ...LIFT_SM},
  depositStatusTitle: {fontSize: 12, fontWeight: '600', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 6, fontFamily: FONT.mono},
  depositStatusMain: {fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 4, fontFamily: FONT.sansBold},
  depositStatusRow: {fontSize: 13, color: C.sub, fontFamily: FONT.mono},
  // Manual "Check now" — secondary (outline brand), debounced + spinner while in-flight.
  checkBtn: {marginTop: 16, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: C.brand, alignItems: 'center', justifyContent: 'center', height: 46, backgroundColor: C.card},
  checkBtnText: {color: C.brand, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Testnet show/hide toggle at the bottom of the Balances sheet — a subtle secondary affordance
  // (never the primary action). Muted text; full-width 44pt touch target.
  testnetToggle: {marginTop: 18, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingVertical: 8},
  testnetToggleText: {color: C.sub, fontWeight: '600', fontSize: 14, fontFamily: FONT.sansMedium},
  // Withdraw sheet form fields.
  inputLabel: {fontSize: 13, fontWeight: '600', color: C.sub, alignSelf: 'flex-start', marginTop: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1, fontFamily: FONT.sansMedium},
  withdrawAddrInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 14, height: 56, paddingHorizontal: 16, fontSize: 15, color: C.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: C.line2},
  savedAddrChip: {alignSelf: 'flex-start', backgroundColor: C.panel2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: C.line2},
  savedAddrText: {fontSize: 13, color: C.brand, fontFamily: FONT.mono},
  withdrawAmtInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 14, height: 56, paddingHorizontal: 16, fontSize: 22, fontWeight: '700', color: C.ink, borderWidth: 1, borderColor: C.line2, fontFamily: FONT.sansBold},
  reviewCard: {alignSelf: 'stretch', marginTop: 20, backgroundColor: C.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.line2, ...LIFT_SM},
  reviewLabel: {fontSize: 12, fontWeight: '600', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 8, fontFamily: FONT.mono},
  // 'Needs setup' pill on the Balances USDC (Solana) row — a warn-tinted row annotation,
  // left-aligned under the subtitle (not a centered banner).
  assetBadge: {alignSelf: 'flex-start', marginTop: 6, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(180,83,9,0.08)', borderWidth: 1, borderColor: 'rgba(180,83,9,0.35)', fontSize: 11, fontWeight: '700', color: C.warn, letterSpacing: 1.1, textTransform: 'uppercase', fontFamily: FONT.mono, overflow: 'hidden'},
});
