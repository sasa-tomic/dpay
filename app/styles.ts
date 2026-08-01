import {StyleSheet} from 'react-native';
import {C} from './config/palette';

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
  // Desktop frame: fills the whole viewport with the bg (honest black margins on wide screens) and
  // centers the capped app column. At <=480px it is a no-op (the column is already full-width).
  screenFrame: {flex: 1, backgroundColor: C.bg, alignItems: 'center'},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  onboard: {flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center'},
  wordmark: {fontSize: 26, fontWeight: '800', letterSpacing: -0.8, color: C.ink},
  wordmarkPay: {color: C.brand},
  wordmarkBig: {fontSize: 34, marginTop: 14},
  onboardSub: {fontSize: 15, color: C.sub, textAlign: 'center', marginTop: 8, marginBottom: 28, paddingHorizontal: 12, lineHeight: 22},
  usernameInput: {backgroundColor: C.field, borderRadius: 14, height: 56, paddingHorizontal: 18, fontSize: 20, color: C.ink, marginBottom: 8, borderWidth: 1, borderColor: C.line2, alignSelf: 'stretch'},
  // Header — tightened vertical rhythm (was paddingTop:20/paddingBottom:12) and balanced horizontal
  // padding (was an asymmetric 22/10). Reclaims ~9px vertical and reads less top-heavy.
  header: {paddingTop: 14, paddingLeft: 16, paddingRight: 14, paddingBottom: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: C.line},
  headerLeft: {flexDirection: 'row', alignItems: 'flex-start', gap: 4},
  headerSettingsBtn: {width: 40, height: 40, borderRadius: 20, backgroundColor: C.field, alignItems: 'center', justifyContent: 'center'},
  headerSettingsIcon: {fontSize: 20, fontWeight: '600', color: C.sub},
  brand: {fontSize: 24},
  who: {fontSize: 12, color: C.sub, marginTop: 2},
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 4, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  nfcSub: {fontSize: 15, color: C.sub, marginTop: 10, textAlign: 'center', paddingHorizontal: 20},
  balBox: {alignItems: 'flex-end'},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  demoPill: {backgroundColor: 'rgba(62,224,172,0.12)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, marginLeft: 2},
  demoPillText: {fontSize: 9, fontWeight: '800', color: C.brand, letterSpacing: 0.5},
  balAmtRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  topUpErr: {fontSize: 13, color: C.bad, marginTop: 8, textAlign: 'center'},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: C.sub},
  balAmt: {fontSize: 26, fontWeight: '800', color: C.ink},
  swapHint: {fontSize: 18, color: C.sub2, marginLeft: 6},
  tabs: {flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginTop: 6},
  tab: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 999, backgroundColor: C.field, minHeight: 44},
  tabActive: {backgroundColor: C.brand},
  tabText: {color: C.sub, fontWeight: '600'},
  tabTextActive: {color: C.brandInk},
  // Body — `justifyContent: 'flex-start'` (was 'center') so mode content flows from the top and the
  // asset rail follows naturally; the old vertical centering floated sparse content mid-screen and
  // left awkward gaps above the assets. Horizontal padding tightened 22→16 for more usable width.
  body: {flexGrow: 1, paddingHorizontal: 16, paddingTop: 10, justifyContent: 'flex-start'},
  // Mode surface (Pay/Receive phase views + the NFC status takeover). Grows to fill the space
  // between the tabs and the asset rail, and VERTICALLY centers its content — so a sparse phase
  // (scan/review/paid/result) no longer packs itself at the top and leaves a dead zone below.
  // `flexShrink:0` keeps tall content from being clipped: when a phase's content exceeds the free
  // space it grows the surface (and the parent ScrollView scrolls) instead of being squashed.
  center: {flexGrow: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'center'},
  label: {fontSize: 15, color: C.sub, marginBottom: 10, textAlign: 'center'},
  err: {color: C.bad, fontSize: 14, textAlign: 'center', marginTop: 10},
  dim: {opacity: 0.6},
  dim2: {fontSize: 13, color: C.sub, marginTop: 8, textAlign: 'center'},
  // Camera viewfinder — fills the content column (`alignSelf:'stretch'` overrides the parent's
  // centering; `aspectRatio:1` keeps it square) so the primary scan surface uses the full usable
  // width instead of a 300px box floating in a ~358px column with dead space around it.
  camBox: {alignSelf: 'stretch', aspectRatio: 1, borderRadius: 22, overflow: 'hidden', backgroundColor: '#0a0d11', borderWidth: 1, borderColor: C.line},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 30, fontWeight: '800', color: C.ink, textAlign: 'center'},
  reviewTo: {fontSize: 17, color: C.ink, marginTop: 6, textAlign: 'center'},
  warnNote: {fontSize: 13, color: C.warn, textAlign: 'center', marginTop: -10, marginBottom: 18, paddingHorizontal: 8, lineHeight: 18},
  // Primary action button — stretched full-width (was a centered minWidth:240 pill that looked
  // narrow/floaty in the ~358px content column). Onboarding Create + Pay Approve now read as
  // substantial primary actions. `primaryWide` is kept for the Receive Request button (same chrome).
  primary: {backgroundColor: C.brand, borderRadius: 14, height: 56, alignSelf: 'stretch', paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', marginTop: 14, shadowColor: C.brand, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 8},
  primaryWide: {backgroundColor: C.brand, borderRadius: 14, height: 56, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 14, shadowColor: C.brand, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 8},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '700'},
  qrCard: {backgroundColor: '#ffffff', padding: 18, borderRadius: 18, borderWidth: 1, borderColor: C.line, marginBottom: 14},
  amountBig: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: C.brand, backgroundColor: 'rgba(62,224,172,0.12)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden'},
  qrHint: {marginTop: 12, fontSize: 13, color: C.sub, textAlign: 'center'},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: C.ok, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center'},
  paidBtnText: {color: C.brandInk, fontWeight: '700', fontSize: 16},
  notPaidBtn: {backgroundColor: C.field, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center'},
  notPaidText: {color: C.sub, fontWeight: '600', fontSize: 16},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18, shadowColor: C.ok, shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8},
  checkAlready: {backgroundColor: C.warn, shadowColor: C.warn},
  checkMark: {color: C.brandInk, fontSize: 50, fontWeight: '700'},
  paidText: {fontSize: 30, fontWeight: '800', color: C.ok},
  alreadyText: {color: C.warn},
  paidSub: {fontSize: 16, color: C.sub, marginTop: 6},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: C.field, borderRadius: 14, paddingHorizontal: 18, height: 76, alignSelf: 'stretch', borderWidth: 1, borderColor: C.line2},
  currency: {fontSize: 36, fontWeight: '700', color: C.ink},
  amountInput: {flex: 1, fontSize: 36, fontWeight: '700', color: C.ink, marginLeft: 6},
  // Tappable amount-prefix (Receive): wraps the currency glyph + a ▾ caret that signals it opens the
  // currency picker. The right border separates it from the typed amount.
  prefixBtn: {flexDirection: 'row', alignItems: 'center', paddingRight: 12, borderRightWidth: 1, borderRightColor: C.line2},
  caret: {color: C.sub2, fontSize: 13, marginLeft: 3},
  linkBtn: {marginTop: 18, minHeight: 44, justifyContent: 'center'},
  linkText: {color: C.brand, fontWeight: '600', fontSize: 16},
  linkTextMuted: {color: C.sub, fontWeight: '600', fontSize: 15},
  smallBtn: {backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6},
  smallBtnText: {color: C.brandInk, fontWeight: '700'},
  histCard: {marginTop: 20, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14},
  histTitle: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6, fontFamily: 'monospace'},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line2},
  histWhoCol: {flex: 1},
  histWho: {fontSize: 15, color: C.ink},
  histMemo: {fontSize: 12, color: C.sub2, marginTop: 2, fontStyle: 'italic'},
  histAmt: {fontSize: 15, fontWeight: '700', marginRight: 12, fontFamily: 'monospace'},
  histTime: {fontSize: 12, color: C.sub2, fontFamily: 'monospace'},
  // Ledger page — the transaction list promoted to its own tab (was an inline card under Pay/Receive).
  // `ledgerWrap` is the page-level container (no top border — it is primary content now, not a footer
  // card); `ledgerEmpty` is the muted centered placeholder for a wallet with no transactions yet.
  ledgerWrap: {marginTop: 4},
  ledgerEmpty: {fontSize: 15, color: C.sub, textAlign: 'center', marginTop: 40},
  // Asset filter chip row — only renders when >1 currency is present in history. Active chip inverts to
  // the brand fill so the selected filter reads as the obvious current view.
  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14},
  filterChip: {paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: C.line2, backgroundColor: C.field, minHeight: 36},
  filterChipActive: {backgroundColor: C.brand, borderColor: C.brand},
  filterChipText: {color: C.sub, fontWeight: '600', fontSize: 13},
  filterChipTextActive: {color: C.brandInk},
  // ckBTC asset card — a DISTINCT, clearly-labeled asset (not the `$` balance). Same card chrome as
  // the deposit status block so it reads as a related-but-separate asset affordance. The brand-tinted
  // left edge + "Bitcoin" label + BTC units make it unambiguously NOT the DEMO_USD `$` header.
  assetCard: {marginTop: 12, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2, borderLeftColor: C.brand, borderLeftWidth: 3},
  assetRow: {flexDirection: 'row', alignItems: 'center'},
  assetSelect: {flex: 1, flexDirection: 'row', alignItems: 'baseline'},
  assetLabel: {flex: 1, marginLeft: 8, fontSize: 16, fontWeight: '700', color: C.ink},
  assetAmt: {fontSize: 16, fontWeight: '700', color: C.brand, fontFamily: 'monospace'},
  assetSub: {fontSize: 12, color: C.sub2, marginTop: 6},
  assetActions: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 10},
  assetActionBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.line2, minHeight: 44},
  assetActionPlus: {fontSize: 19, fontWeight: '700', color: C.brand, lineHeight: 20, marginTop: -2},
  assetActionText: {color: C.sub, fontWeight: '700', fontSize: 13},
  assetsSectionTitle: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginTop: 22, marginBottom: 2, fontFamily: 'monospace'},
  assetCardZero: {color: C.sub2},
  pickerRow: {alignSelf: 'stretch', paddingVertical: 16, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, marginTop: 10},
  pickerLabel: {fontSize: 16, fontWeight: '700', color: C.ink},
  pickerSub: {fontSize: 12, color: C.sub2, marginTop: 4},
  settingsSection: {alignSelf: 'stretch', marginBottom: 28},
  relayInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 50, paddingHorizontal: 16, fontSize: 14, color: C.ink, fontFamily: 'monospace', borderWidth: 1, borderColor: C.line2},
  // Advanced relay section — the relay edit is demoted below consumer settings and applied EXPLICITLY
  // via the Apply button (no live retarget on each keystroke). `advancedLabel` is the small uppercase
  // eyebrow shared with the other section headers; `applyBtn` mirrors the primary button chrome but is
  // compact (48pt, 44pt min touch target); `applyBtnDisabled` mutes it when the draft == the active URL.
  advancedLabel: {fontSize: 12, fontWeight: '700', color: C.sub2, alignSelf: 'flex-start', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 4, fontFamily: 'monospace'},
  applyBtn: {backgroundColor: C.brand, borderRadius: 14, height: 48, minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 16, shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6},
  applyBtnText: {color: C.brandInk, fontSize: 16, fontWeight: '700'},
  applyBtnDisabled: {opacity: 0.4, shadowOpacity: 0, elevation: 0},
  resetConfirmBox: {alignSelf: 'stretch', backgroundColor: 'rgba(248,113,113,0.06)', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: 'rgba(248,113,113,0.2)'},
  resetLink: {fontSize: 15, color: C.bad, fontWeight: '600'},
  // The PRIMARY funding affordance in the balance header: a clear "Add money" brand button that
  // opens the deposit sheet. Filled brand so it reads as primary; the DEMO_USD faucet (topUpBtn)
  // is the secondary outline pill beside it. minHeight:44 meets the 44pt touch target; the shadow
  // radius is kept tight (8) so the glow can't bleed past the header's right padding and read as
  // clipped at the viewport edge (L1).
  addMoneyBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.brand, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, minHeight: 44, shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: {width: 0, height: 6}, elevation: 6},
  addMoneyBtnText: {fontSize: 13, fontWeight: '800', color: C.brandInk},
  // Keyboard-shortcut hint badge (web only — rendered by HotkeyHint). A visible "key cap": a
  // rounded square with a real border + subtle background and a 14px monospace letter, so the
  // shortcut it teaches is clearly legible (M3 — the prior 10px borderless badge was nearly
  // invisible). `kbdHint` is the muted variant on the dark header/tabs (ink text on a faint white
  // wash -> well above 3:1 contrast); `kbdHintOnBrand` flips to a dark-on-brand variant for badges
  // that sit on the green brand background (active tab, Add-money button).
  kbdHint: {minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 6, borderWidth: 1, borderColor: C.sub2, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  kbdHintText: {fontSize: 14, fontWeight: '700', color: C.ink, fontFamily: 'monospace'},
  kbdHintOnBrand: {borderColor: 'rgba(3,23,15,0.45)', backgroundColor: 'rgba(3,23,15,0.18)'},
  kbdHintTextOnBrand: {color: C.brandInk},
  // Deposit sheet — a full-screen overlay above the wallet.
  sheetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, zIndex: 10},
  sheet: {flex: 1, backgroundColor: C.bg},
  sheetHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingHorizontal: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.line},
  sheetTitle: {fontSize: 20, fontWeight: '800', color: C.ink},
  sheetClose: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.field},
  sheetCloseX: {fontSize: 16, fontWeight: '700', color: C.sub},
  sheetBody: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 22, alignItems: 'center'},
  // Same as sheetBody but vertically CENTERS short content so a sheet with few rows (the Balances hub
  // with 3 currencies, or a deposit sheet's connect state) doesn't pack at the top with a big dead
  // zone below. Used ONLY on sheets whose content is reliably shorter than the viewport — the tall
  // sheets (DepositSheet address flow, WithdrawSheet form) keep top-aligned sheetBody so their long
  // content scrolls without the RN ScrollView + justifyContent:center top-cutoff gotcha.
  sheetCenter: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingTop: 22, paddingBottom: 22, alignItems: 'center'},
  // Compact currency picker (Receive prefix tap): a centered card over a dimmed backdrop (rendered
  // inside a <Modal>, so it covers the whole screen regardless of where ReceiveMode sits in the tree).
  pickBackdrop: {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 28},
  pickCard: {alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: C.line2},
  pickTitle: {fontSize: 13, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 8, fontFamily: 'monospace'},
  pickItem: {flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line2},
  pickGlyph: {fontSize: 22, fontWeight: '700', color: C.ink, width: 40},
  pickName: {flex: 1, fontSize: 16, fontWeight: '700', color: C.ink},
  pickCheck: {color: C.brand, fontSize: 18, fontWeight: '700'},
  // Pay-scan NFC status row — a large colored NFC mark + a short label, leading the scanner. Green
  // when tap-to-pay is ready, red with a tappable "NFC not available ⓘ" link + reason popup otherwise.
  nfcStatusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14},
  nfcStatusLabel: {fontSize: 18, fontWeight: '700', color: C.ink},
  // Receive QR hint — a small NFC mark leading the "or let them tap" label when the reader is armed.
  nfcHintRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10},
  nfcHintLabel: {fontSize: 15, color: C.sub, textAlign: 'center'},
  nfcInfoLink: {flexDirection: 'row', alignItems: 'center', gap: 5},
  nfcInfoLinkText: {fontSize: 18, fontWeight: '700', color: C.bad},
  nfcInfoGlyph: {fontSize: 15, color: C.sub2},
  nfcInfoBody: {fontSize: 15, color: C.ink, lineHeight: 21, marginBottom: 16},
  nfcInfoClose: {alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: C.line2},
  nfcInfoCloseText: {fontSize: 15, fontWeight: '700', color: C.ink},
  // Deposit instructions — a scannable card (network/asset + est. time + fee/min + non-custody line).
  instrCard: {alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2, marginBottom: 18},
  instrLine: {fontSize: 15, color: C.ink, textAlign: 'center', lineHeight: 21, marginBottom: 10},
  instrAsset: {color: C.brand, fontWeight: '700'},
  instrMeta: {fontSize: 13, color: C.sub, textAlign: 'center', fontFamily: 'monospace', paddingVertical: 2},
  instrCustody: {fontSize: 12, color: C.sub2, textAlign: 'center', marginTop: 10, lineHeight: 17},
  sheetAddr: {fontSize: 13, color: C.ink, fontFamily: 'monospace', textAlign: 'center', marginTop: 4, marginBottom: 8, letterSpacing: 0.2},
  depositCopy: {alignSelf: 'stretch', marginTop: 12},
  depositStatus: {marginTop: 22, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2},
  depositStatusTitle: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6, fontFamily: 'monospace'},
  depositStatusMain: {fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 4},
  depositStatusRow: {fontSize: 13, color: C.sub, fontFamily: 'monospace'},
  // Manual "Check now" — secondary (outline brand), debounced + spinner while in-flight.
  checkBtn: {marginTop: 16, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: C.brand, alignItems: 'center', justifyContent: 'center', height: 46},
  checkBtnText: {color: C.brand, fontWeight: '700', fontSize: 15},
  // Withdraw affordance on the ckBTC asset card — a small brand link, distinct from the deposit
  // "Add money" flow (money OUT, not IN). Sits below the balance line.
  withdrawLink: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.brand, minHeight: 44, justifyContent: 'center', alignItems: 'center'},
  withdrawLinkText: {color: C.brand, fontWeight: '700', fontSize: 13},
  // Withdraw sheet form fields.
  inputLabel: {fontSize: 13, fontWeight: '700', color: C.sub, alignSelf: 'flex-start', marginTop: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8},
  withdrawAddrInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 56, paddingHorizontal: 16, fontSize: 15, color: C.ink, fontFamily: 'monospace', borderWidth: 1, borderColor: C.line2},
  savedAddrChip: {alignSelf: 'flex-start', backgroundColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, minHeight: 44, justifyContent: 'center'},
  savedAddrText: {fontSize: 13, color: C.brand, fontFamily: 'monospace'},
  withdrawAmtInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 56, paddingHorizontal: 16, fontSize: 22, fontWeight: '700', color: C.ink, borderWidth: 1, borderColor: C.line2},
  reviewCard: {alignSelf: 'stretch', marginTop: 20, backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2},
  reviewLabel: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 8, fontFamily: 'monospace'},
});
