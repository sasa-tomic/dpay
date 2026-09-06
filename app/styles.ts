import {StyleSheet} from 'react-native';
import {C, DARK, FONT, LIGHT} from './config/palette';
import type {Palette} from './config/palette';

// "Traveler Paper" — the 2026-08-17 complete redesign, dual-theme since 2026-08-20 (Wave 4).
// Warm porcelain surfaces + ink text (LIGHT, byte-identical to the single-theme era) and the
// warm near-black night reading (DARK). Tangerine reserved for action in both. Depth comes from
// layered surfaces + soft ink-tinted shadows, never neon glows. Space Grotesk carries UI +
// numerals (the signature look); IBM Plex Mono carries addresses, seeds, eyebrows — the
// "receipt" voice.
//
// THE ONE-BLOCK RULE STILL HOLDS: this file stays ONE style vocabulary, now expressed as a
// `buildStyles(palette)` builder. `S` is a mutable holder initialized from the OS-resolved
// palette; `applyPalette` swaps every key in place. Never partition this into per-screen files.

// Soft ink shadow used by raised surfaces (cards, primary buttons). iOS shadow + Android
// elevation pair so the lift reads on both platforms. shadowColor comes from the palette
// (warm ink in light, near-black — never #000 — in dark).
const lift = (p: Palette) => ({
  shadowColor: p.shadow,
  shadowOpacity: 0.06,
  shadowRadius: 12,
  shadowOffset: {width: 0, height: 4},
  elevation: 2,
} as const);
const liftSm = (p: Palette) => ({
  shadowColor: p.shadow,
  shadowOpacity: 0.05,
  shadowRadius: 8,
  shadowOffset: {width: 0, height: 3},
  elevation: 1,
} as const);

function buildStyles(p: Palette) {
  const LIFT = lift(p);
  const LIFT_SM = liftSm(p);
  return StyleSheet.create({
  // The app column. `width:'100%'` keeps it full-bleed on phones (and the e2e 390px viewport);
  // `maxWidth:480` caps it on desktop so a 1280px laptop shows an intentional centered phone-width
  // column instead of a stretched sheet. Centered by the `screenFrame` wrapper in App.tsx.
  root: {flex: 1, backgroundColor: p.bg, width: '100%', maxWidth: 480},
  // Content scroller. `flex:1` makes the ScrollView FILL the remaining column height below the
  // header (the bottom nav bar, O4 S1, takes the foot of the column AFTER the scroller) (a bare ScrollView with no style sizes to its content, so short screens like the
  // Paid phase left a dead zone below the content and flexGrow on children had no bounded parent to
  // expand into). With this filling the column, `.body` (contentContainer) flexGrow:1 then fills the
  // scroller, and the mode surface `.center` flexGrow:1 fills the gap above the asset rail.
  scroll: {flex: 1},
  // Desktop frame: fills the whole viewport with the porcelain bg and centers the capped app
  // column. At <=480px it is a no-op (the column is already full-width).
  screenFrame: {flex: 1, backgroundColor: p.bg, alignItems: 'center'},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  // Onboarding ScrollView contentContainer. `flexGrow` (NOT `flex:1`): flex clamps the content
  // height to the scroll frame, which structurally DISABLES scrolling — on a small screen the
  // seed-backup gate overflowed with the Continue button unreachable. flexGrow lets short content
  // still fill + center the frame while tall content grows past it and scrolls.
  onboard: {flexGrow: 1, padding: 24, justifyContent: 'center', alignItems: 'center'},
  wordmark: {fontSize: 27, fontWeight: '700', letterSpacing: -0.8, color: p.ink, fontFamily: FONT.sansBold},
  wordmarkPay: {color: p.brand},
  wordmarkBig: {fontSize: 36, marginTop: 14},
  onboardSub: {fontSize: 15, color: p.sub, textAlign: 'center', marginTop: 8, marginBottom: 28, paddingHorizontal: 12, lineHeight: 22, fontFamily: FONT.sans},
  // ∂ is the demo-dollar symbol — unfamiliar on first glance. The onboarding one-liner explains
  // it inline next to the demo funds note so a first-time user has the mapping before they see
  // their balance. `dpayGlyph` carries the glyph in ink; `dpayGlyphNote` is the surrounding line.
  dpayGlyph: {color: p.ink, fontWeight: '700', fontFamily: FONT.sansBold},
  dpayGlyphNote: {fontSize: 13, color: p.sub, marginTop: 4, textAlign: 'center', paddingHorizontal: 12, lineHeight: 18, fontFamily: FONT.sans},
  usernameInput: {backgroundColor: p.field, borderRadius: 16, height: 56, paddingHorizontal: 18, fontSize: 20, color: p.ink, marginBottom: 8, borderWidth: 1, borderColor: p.line2, alignSelf: 'stretch', fontFamily: FONT.sansMedium, ...LIFT_SM},
  // Restore-mode recovery-seed input (64 hex chars). Like usernameInput but monospace + multiline so
  // the long seed wraps readably; minHeight instead of fixed height so it grows with content.
  seedInput: {backgroundColor: p.field, borderRadius: 16, minHeight: 56, paddingHorizontal: 18, paddingVertical: 14, fontSize: 16, fontFamily: FONT.mono, color: p.ink, marginBottom: 8, borderWidth: 1, borderColor: p.line2, alignSelf: 'stretch'},
  // Header — borderless on porcelain (whitespace separates chrome from content; hairlines under
  // the header read as spreadsheet chrome). Balanced horizontal padding.
  header: {paddingTop: 16, paddingLeft: 16, paddingRight: 16, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'},
  headerLeft: {flexDirection: 'row', alignItems: 'flex-start', gap: 4},
  headerSettingsBtn: {width: 40, height: 40, borderRadius: 14, backgroundColor: p.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.line2},
  brand: {fontSize: 24},
  // ACCOUNT eyebrow above the username separates the wordmark "∂pay" from the user identity so
  // the pair no longer reads as a single currency label. Mono = the receipt voice. The `who` line
  // below stays the authoritative username text (e2e `header-who` reads it verbatim).
  whoLabel: {fontSize: 10, fontWeight: '600', color: p.sub2, marginTop: 6, letterSpacing: 1.2, textTransform: 'uppercase', fontFamily: FONT.mono},
  who: {fontSize: 13, color: p.sub, marginTop: 2, fontFamily: FONT.sansMedium},
  // NFC takeover badge — a soft ring on porcelain (no filled disc); the glyph/icon carries tone.
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 3, borderColor: p.line, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.4},
  nfcSub: {fontSize: 15, color: p.sub, marginTop: 10, textAlign: 'center', paddingHorizontal: 20, fontFamily: FONT.sans},
  // ── Trip Ready J5 motion system (additive) ──────────────────────────────────────────────
  // The breathing ring around the listening badge (renders BEHIND S.nfcBadge; only scale +
  // opacity animate — both non-layout props, so parent layout never re-flows mid-breath).
  nfcBreath: {position: 'absolute', width: 108, height: 108, borderRadius: 54, borderWidth: 1.5, borderColor: p.brand},
  // The itinerary-line strip: two phone marks + the segments that light as the protocol
  // advances (linking → exchanging → awaitingApproval → settling). Sits between the badge and
  // the title; static SVG geometry, only opacities animate.
  nfcLineRow: {flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 4, height: 34},
  nfcLineTrack: {flex: 1, height: 2, borderRadius: 1, backgroundColor: p.line},
  // The pending stillness: an unhurried ellipsis pulse (the OPPOSITE of a success mark —
  // warn tone, no rotation, no scale press, deliberately slow).
  nfcEllipsis: {flexDirection: 'row', gap: 7, marginTop: 20, alignItems: 'center'},
  nfcEllipsisDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: p.warn},
  // The paid-card stamp chip — the same stampChip language, compact + calm, additive to the
  // existing Paid view (never replaces the check/paidText marks).
  paidStamp: {marginTop: 18, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, borderWidth: 1.5, borderColor: p.brand, backgroundColor: 'transparent'},
  paidStampText: {color: p.brand, fontFamily: FONT.mono, fontSize: 12, fontWeight: '600', letterSpacing: 2.4, textTransform: 'uppercase'},
  // ── The one-shot offline peak (J5) ───────────────────────────────────────────────────────
  // Full-width moment ABOVE the paid card: the campaign line as a strong editorial line and
  // the "no signal the whole time" microcopy. Settles INTO the card (~2s).
  peakWrap: {alignSelf: 'stretch', alignItems: 'center', marginBottom: 18},
  peakCampaign: {fontSize: 24, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.3, marginBottom: 12},
  peakMicro: {fontSize: 14, color: p.sub, marginTop: 12, textAlign: 'center', fontFamily: FONT.sans},
  // The settled remnant: the quiet mono line that stays on the paid card after the peak
  // settles — the durable "this was the first offline one" mark (e2e testID `first-offline-stamp`).
  peakSettled: {marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 6},
  peakSettledText: {fontSize: 11, fontWeight: '600', color: p.sub2, letterSpacing: 2.0, textTransform: 'uppercase', fontFamily: FONT.mono},
  // ── The Trip Readiness passport (J5b) ────────────────────────────────────────────────────
  // A travel-credential PAGE, not a dashboard: porcelain card + fine rule, the eyebrow row
  // ("TRIP READINESS · 3 OF 4" mono caps), and the 2×2 stamp grid. Empty positions read as
  // debossed dashes on the page (a place NOT yet stamped); filled positions are inked rings
  // (brand, 2px) with the two-line caps label INSIDE the ring — the stampChip grammar at slot
  // scale, each with its own slight rotation so the set reads hand-stamped, never a checklist.
  passportCard: {alignSelf: 'stretch', marginTop: 2, backgroundColor: p.card, borderWidth: 1, borderColor: p.line2, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 16},
  passportHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  passportRule: {height: 1, backgroundColor: p.line, marginTop: 10},
  passportGrid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 18, rowGap: 14},
  passportSlot: {width: 88, height: 88, borderRadius: 44, borderWidth: 1.5, borderColor: p.line2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  passportSlotFilled: {width: 88, height: 88, borderRadius: 44, borderWidth: 2, borderColor: p.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  passportSlotText: {color: p.sub, fontFamily: FONT.mono, fontSize: 9, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase', textAlign: 'center', lineHeight: 12},
  passportSlotTextFilled: {color: p.brand, fontFamily: FONT.mono, fontSize: 9, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase', textAlign: 'center', lineHeight: 12},
  // The ONE contextual next-step row (incomplete only): a quiet "NEXT" tag + active-voice
  // sans hint + an up-right arrow, wrapped as a full-width ghost button (UX 2026-08-23: the
  // plain-text row read as dead text — it now takes you to the step's home instead of
  // describing where to go). Brand tag = the stamp-tag language; remains quiet chrome.
  passportHint: {flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch', justifyContent: 'flex-start'},
  passportHintTag: {color: p.brand, fontFamily: FONT.mono, fontSize: 10, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase'},
  passportHintText: {flexShrink: 1, fontSize: 13, color: p.sub, fontFamily: FONT.sans, textAlign: 'left'},
  passportHintArrow: {marginLeft: 'auto', flexShrink: 0},
  // The completed card's durable mark: the stampChip grammar ("TRIP READY") + the promise
  // line. Quiet ink, no counters — the capstone moment above is the ONLY loud beat.
  passportReadyWrap: {marginTop: 16, alignItems: 'center'},
  passportReadyLine: {fontSize: 13, color: p.sub, textAlign: 'center', marginTop: 10, fontFamily: FONT.sans},
  // The capstone overlay: the full-card TRIP READY stamp press (~1s) — the stamp-ring grammar
  // (118 ring, spring + tilt) pressed across the finished page, then it lifts to reveal the
  // static completed card + Done. UX hardening 2026-08-23 (M3): the overlay INVERTS to ink —
  // the one full-bleed dark beat of the wallet (matches the RECOVERY SAVED ink beat) — with
  // the four stamp labels inking in sequence, then the tangerine TRIP READY band. Uses ink/bg
  // semantics (dark-theme-safe, never #000 — palette discipline holds).
  passportCapstoneInk: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 18, backgroundColor: p.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18},
  passportCapStamps: {alignItems: 'center', gap: 4, marginBottom: 18},
  passportCapStampText: {color: p.bg, fontFamily: FONT.mono, fontSize: 10, fontWeight: '600', letterSpacing: 1.6, textTransform: 'uppercase', textAlign: 'center', lineHeight: 13},
  passportSlotDate: {color: p.sub, fontFamily: FONT.mono, fontSize: 9, letterSpacing: 1, marginTop: 3, textTransform: 'uppercase', textAlign: 'center'},
  passportCapstoneText: {color: p.brand, fontFamily: FONT.mono, fontSize: 15, fontWeight: '600', letterSpacing: 2.2, textTransform: 'uppercase', textAlign: 'center', lineHeight: 20},
  passportCapstoneMicro: {fontSize: 13, color: p.bg, marginTop: 14, textAlign: 'center', fontFamily: FONT.sans, opacity: 0.85},
  balBox: {alignItems: 'flex-end'},
  // The header balance pressable's outer row: the label+value column, then the A hotkey badge
  // at the far right edge (DOM order label → value → badge, mirroring the tab-bar badge pattern).
  balHeaderRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  balAmtRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  topUpErr: {fontSize: 13, color: p.bad, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: p.sub, fontFamily: FONT.sansMedium},
  balAmt: {fontSize: 28, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  // The transient Android back-to-exit hint under the header balance (inline Text, not a
  // toast — no native module, matches the caption tone but with a warn tint for visibility).
  balBackHint: {fontSize: 12, color: p.warn, marginTop: 6, fontFamily: FONT.sansMedium},
  // Bottom navigation bar (O4 S1) — the persistent primary nav, replacing the old top pill row.
  // Rendered AFTER the ScrollView inside the SafeAreaView so it never scrolls away; the
  // SafeAreaView owns the bottom safe-area inset (web env() inset; native MainActivity's API-35
  // content-frame reservation). Card surface + top hairline + soft lift so it reads as chrome
  // floating over content; the full-screen sheets still cover it (their overlay runs elevation 10
  // vs the bar's 1). Three `flex:1` tabs split the full 390px row — no wrap needed.
  bottomNav: {flexDirection: 'row', alignItems: 'stretch', backgroundColor: p.card, borderTopWidth: 1, borderTopColor: p.line2, paddingHorizontal: 8, paddingVertical: 6, ...LIFT_SM},
  // TripStrip (UX hardening 2026-08-23) — the home-surface readiness line: one slim pill row
  // between the header and the tabs. 4 stamp-dots (filled = brand ring + deterministic tilt,
  // echoing the passport's slots) + a mono progress phrase. Quiet by design (panel2, hairline)
  // — it informs, never shouts; retires itself once readiness is complete + seen.
  tripStrip: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line},
  tripStripDots: {flexDirection: 'row', gap: 6, alignItems: 'center'},
  tripStripDot: {width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: p.line2},
  tripStripDotFilled: {borderColor: p.brand, backgroundColor: p.brand},
  tripStripText: {fontFamily: FONT.mono, fontSize: 11, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase', color: p.ink, flexShrink: 1},
  tripStripArrow: {marginLeft: 'auto', flexShrink: 0},
  tab: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, backgroundColor: p.card, minHeight: 44, borderWidth: 1, borderColor: p.line2},
  tabActive: {backgroundColor: p.brand, borderColor: p.brand, ...LIFT},
  tabText: {color: p.sub, fontWeight: '600', fontFamily: FONT.sansMedium},
  tabTextActive: {color: p.brandInk, fontFamily: FONT.sansBold},
  // Bottom-bar tab (O4 S1) — icon over label, `flex:1` so the three tabs split the bar equally on
  // a 390px phone; minHeight 56 clears the 44pt touch floor with comfortable thumb room. Active
  // keeps the old pill language (tangerine fill + brandInk) so primary nav stays the loudest
  // level. Labels are 11px single-line-safe: the longest locale label ("Movimientos", es) fits a
  // ~124px tab without truncation, so no numberOfLines clamp is needed.
  bottomTab: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8, minHeight: 56, borderRadius: 12},
  bottomTabActive: {backgroundColor: p.brand, ...LIFT},
  bottomTabText: {color: p.sub, fontWeight: '600', fontSize: 11, fontFamily: FONT.sansMedium},
  bottomTabTextActive: {color: p.brandInk, fontFamily: FONT.sansBold},
  // Mode toggle — a joined two-segment pill control at the top of the Pay/Receive tab bodies:
  // `[ Scan to pay | Send to address ]` (Pay) and `[ Request payment | My address ]` (Receive).
  // Inset well (panel2) + white active segment + ink text: the editorial segmented control,
  // deliberately quieter than the tangerine tabs so nav stays the loudest level.
  // `railRow` is the joined container; `railPill` is each half-width segment.
  railRow: {flexDirection: 'row', gap: 4, marginTop: 2, marginBottom: 14, backgroundColor: p.panel2, borderRadius: 999, padding: 4, alignSelf: 'stretch', borderWidth: 1, borderColor: p.line2},
  railPill: {flex: 1, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', minHeight: 40},
  railPillActive: {backgroundColor: p.card, ...LIFT_SM},
  railPillText: {color: p.sub, fontWeight: '600', fontSize: 14, fontFamily: FONT.sansMedium},
  railPillTextActive: {color: p.ink, fontFamily: FONT.sansBold},
  // Body — content flows from the top; the asset rail follows naturally.
  body: {flexGrow: 1, paddingHorizontal: 16, paddingTop: 10, justifyContent: 'flex-start'},
  // Mode surface (Pay/Receive phase views + the NFC status takeover). Grows to fill the space
  // between the tabs and the asset rail, and VERTICALLY centers its content — so a sparse phase
  // (scan/review/paid/result) no longer packs itself at the top and leaves a dead zone below.
  // `flexShrink:0` keeps tall content from being clipped: when a phase's content exceeds the free
  // space it grows the surface (and the parent ScrollView scrolls) instead of being squashed.
  center: {flexGrow: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'center'},
  label: {fontSize: 15, color: p.sub, marginBottom: 10, textAlign: 'center', fontFamily: FONT.sans},
  err: {color: p.bad, fontSize: 14, textAlign: 'center', marginTop: 10, fontFamily: FONT.sansMedium},
  dim: {opacity: 0.55},
  // Disabled state for RAISED primary buttons. `dim` layered over the shadow is indistinguishable
  // from enabled, so a disabled money button reads as tappable. `disabledFlat` kills BOTH the
  // Android elevation AND the iOS shadow (the lift dies on each platform where it lives) and drops
  // opacity further. Used ONLY on primary/primaryWide sites; non-raised surfaces keep `dim`.
  disabledFlat: {opacity: 0.4, elevation: 0, shadowOpacity: 0},
  dim2: {fontSize: 13, color: p.sub, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  // Camera viewfinder — fills the content column (`alignSelf:'stretch'` overrides the parent's
  // centering; `aspectRatio:1` keeps it square). A WARM-black frame: the viewport into the world
  // stays dark by nature; the surrounding surface frames it like a photo print. The #17150F fill
  // is DELIBERATELY theme-invariant (identical in light + dark) — the campreview pixel gate
  // (just campreview) keys on it; do NOT palette-ize.
  camBox: {alignSelf: 'stretch', aspectRatio: 1, borderRadius: 24, overflow: 'hidden', backgroundColor: '#17150F', borderWidth: 1, borderColor: p.line, ...LIFT},
  // Wrapper for a scan phase's QrScanner + hint text. MUST be alignSelf:'stretch' (full width):
  // camBox sizes itself by stretch + aspectRatio, so an unstyled/content-width wrapper leaves camBox
  // with no resolvable width and it collapses to 0x0 (the 2026-08-14 SOL scan black-box bug —
  // camera mounted and live but invisible; gated on-device by `just campreview`).
  scanWrap: {alignSelf: 'stretch'},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 32, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.6},
  reviewTo: {fontSize: 17, color: p.sub, marginTop: 6, textAlign: 'center', fontFamily: FONT.sansMedium},
  warnNote: {fontSize: 13, color: p.warn, textAlign: 'center', marginTop: -10, marginBottom: 18, paddingHorizontal: 8, lineHeight: 18, fontFamily: FONT.sans},
  // Icon-led warning row: IconAlert + text where a warning previously LED with a '⚠' text
  // glyph. Mirrors warnNote's sizing/margins in row form; the icon tops the first line so a
  // wrapped body doesn't drag it off-center.
  warnRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: -10, marginBottom: 18, paddingHorizontal: 8},
  warnRowText: {flex: 1, fontSize: 13, color: p.warn, lineHeight: 18, fontFamily: FONT.sans},
  // Primary action button — stretched full-width, tangerine fill, soft lift (no neon glow; the
  // porcelain design gets its energy from color, not emission). Row layout + gap so a leading
  // icon sits inline. `primaryWide` is the same chrome (kept for the Receive Request button).
  primary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: p.brand, borderRadius: 16, height: 56, alignSelf: 'stretch', paddingHorizontal: 24, marginTop: 14, shadowColor: p.brand2, shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  primaryWide: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: p.brand, borderRadius: 16, height: 56, alignSelf: 'stretch', marginTop: 14, shadowColor: p.brand2, shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  primaryText: {color: p.brandInk, fontSize: 18, fontWeight: '700', fontFamily: FONT.sansBold},
  qrCard: {backgroundColor: '#ffffff', padding: 20, borderRadius: 20, borderWidth: 1, borderColor: p.line2, marginBottom: 14, ...LIFT},
  amountBig: {fontSize: 30, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.5},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: p.ok, backgroundColor: 'rgba(14,159,110,0.10)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden', fontFamily: FONT.sansMedium},
  qrHint: {marginTop: 12, fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.sans},
  // Request-QR validity countdown (the signed request expires after EXPIRY_WINDOW; a stale QR scans
  // to a confusing rejection, so the merchant is told how long it's good for).
  qrExpiry: {marginTop: 6, fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.sans},
  qrExpiryWarn: {marginTop: 6, fontSize: 14, fontWeight: '600', color: p.warn, textAlign: 'center', fontFamily: FONT.sansMedium},
  qrExpired: {marginTop: 6, fontSize: 14, fontWeight: '700', color: p.warn, textAlign: 'center', fontFamily: FONT.sansBold},
  // An inline offline-status pill on the Receive-QR screen — so a merchant staring at "Waiting
  // for payment…" knows they won't see incoming payments until reconnected. Soft bad-tinted pill
  // — informational, not a hard error (the wait state is still valid; the poll reconciles).
  qrOfflinePill: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: `rgba(${p.badRGB},0.07)`, borderWidth: 1, borderColor: `rgba(${p.badRGB},0.28)`},
  qrOfflinePillText: {fontSize: 12, fontWeight: '600', color: p.bad, fontFamily: FONT.sansMedium},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: p.ok, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center', ...LIFT},
  paidBtnText: {color: '#FFFFFF', fontWeight: '700', fontSize: 16, fontFamily: FONT.sansBold},
  notPaidBtn: {backgroundColor: p.card, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: p.line2},
  notPaidText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: p.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18, shadowColor: p.ok, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: {width: 0, height: 6}, elevation: 4},
  checkAlready: {backgroundColor: p.warnDeep, shadowColor: p.warnDeep},
  paidText: {fontSize: 30, fontWeight: '700', color: p.ok, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  alreadyText: {color: p.warn},
  paidSub: {fontSize: 16, color: p.sub, marginTop: 6, fontFamily: FONT.sans},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: p.field, borderRadius: 18, paddingHorizontal: 18, height: 76, alignSelf: 'stretch', borderWidth: 1, borderColor: p.line2, ...LIFT_SM},
  currency: {fontSize: 34, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  amountInput: {flex: 1, fontSize: 34, fontWeight: '700', color: p.ink, marginLeft: 6, fontFamily: FONT.sansBold, letterSpacing: -0.5},
  // Tappable amount-prefix (Receive): wraps the currency glyph + chevron that signals it opens the
  // currency picker. The right border separates it from the typed amount.
  prefixBtn: {flexDirection: 'row', alignItems: 'center', paddingRight: 12, borderRightWidth: 1, borderRightColor: p.line2},
  linkBtn: {marginTop: 18, minHeight: 44, justifyContent: 'center'},
  linkText: {color: p.brand, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  linkTextMuted: {color: p.sub, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Icon+label row inside a `linkBtn` Pressable (Settings' Privacy policy carries the
  // external-link glyph). The Pressable keeps the column linkBtn chrome (44pt target); this row
  // lays a small icon against the label with a hairline gap.
  linkRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  // Ghost button tier — the affordance rule (every action = a button) for the Pay/Receive action
  // rows that were bare text links. A white bordered pill with a leading icon: clearly tappable,
  // but neutral chrome so the tangerine stays reserved for the primary CTA. `ghostBtnMuted` is
  // the quieter variant for flow-reset actions ("New request"/"New payment"/"Back") — transparent
  // bg + fainter border. Same 44pt min + marginTop rhythm as linkBtn, which it replaces there.
  ghostBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: p.line, backgroundColor: p.card},
  ghostBtnText: {color: p.sub, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  ghostBtnMuted: {backgroundColor: 'transparent', borderColor: p.line2},
  smallBtn: {backgroundColor: p.brand, borderRadius: 12, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', shadowColor: p.brand2, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 3},
  smallBtnText: {color: p.brandInk, fontWeight: '700', fontFamily: FONT.sansBold},
  // Bordered secondary button (Cancel/secondary action parity with the primary Approve). Same
  // width + height + radius as `primary` so the tap targets are equivalent + the user makes a
  // deliberate choice. White fill + hairline = clearly secondary but unambiguously tappable.
  secondaryBtn: {alignSelf: 'stretch', height: 56, borderRadius: 16, marginTop: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.line2, backgroundColor: p.card, minHeight: 44},
  secondaryBtnText: {color: p.sub, fontWeight: '600', fontSize: 17, fontFamily: FONT.sansMedium},
  histTitle: {fontSize: 12, fontWeight: '600', color: p.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 6, fontFamily: FONT.mono},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: p.line2},
  histWhoCol: {flex: 1},
  histWho: {fontSize: 15, color: p.ink, fontFamily: FONT.sansMedium},
  histMemo: {fontSize: 12, color: p.sub2, marginTop: 2, fontStyle: 'italic', fontFamily: FONT.sans},
  histAmt: {fontSize: 15, fontWeight: '700', marginRight: 12, fontFamily: FONT.sansBold},
  histTime: {fontSize: 12, color: p.sub2, fontFamily: FONT.mono},
  // Leading direction glyph on each Ledger row (IconArrowDownLeft in / IconArrowUpRight out;
  // t.dir is the reliable 'out' | 'in' field on Txn). alignSelf:center overrides the row's
  // baseline alignment — an Svg has no text baseline to align to.
  histDirIcon: {marginRight: 8, alignSelf: 'center'},
  // Ledger page — the transaction list promoted to its own tab. `ledgerWrap` is the page-level
  // container; `ledgerEmpty` is the muted centered placeholder for a wallet with no transactions.
  ledgerWrap: {marginTop: 4},
  ledgerEmpty: {fontSize: 15, color: p.sub, textAlign: 'center', marginTop: 40, fontFamily: FONT.sans},
  // Asset filter chip row — only renders when >1 currency is present in history. Active chip
  // inverts to the tangerine fill so the selected filter reads as the obvious current view.
  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14},
  filterChip: {paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.line2, backgroundColor: p.card, minHeight: 36},
  filterChipActive: {backgroundColor: p.brand, borderColor: p.brand},
  filterChipText: {color: p.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  filterChipTextActive: {color: p.brandInk, fontFamily: FONT.sansBold},
  // Asset card. White card, hairline, soft lift; the brand left edge is ACTIVE-ONLY (neutral when
  // inactive, tangerine when the row is the selected currency) so the selected card pops.
  assetCard: {marginTop: 12, alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: p.line2, borderLeftColor: p.line2, borderLeftWidth: 3, ...LIFT_SM},
  assetCardActive: {borderLeftColor: p.brand},
  assetRow: {flexDirection: 'row', alignItems: 'center'},
  // assetSelect — the glyph-led row inside a card: the 38px AssetGlyph chip against the text
  // column, vertically CENTERED (a monogram chip reads correctly centered against the two-line
  // column).
  assetSelect: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  assetSelectBlock: {flex: 1},
  // assetTitleRow — the name + trailing amount/check line at the top of a card row's text column.
  // The label's flex:1 pushes the amount to the right edge; the check trails the amount.
  assetTitleRow: {flexDirection: 'row', alignItems: 'center'},
  assetLabel: {flex: 1, fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  assetAmt: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, marginLeft: 10},
  assetSub: {fontSize: 12, color: p.sub2, marginTop: 4, fontFamily: FONT.sans},
  // Rail-detail panel — the chooser's inline per-rail expansion (EUR dual-rail, Stage 5). An
  // inset WELL inside the asset card (panel2 + hairline), so the detail reads as drilling into
  // the card rather than as a second card. Rows are glyph-led like assetSelect but top-aligned:
  // the detail rows carry 3-5 wrapped fact lines, and a centered glyph against that would float.
  railDetailPanel: {marginTop: 10, alignSelf: 'stretch', backgroundColor: p.panel2, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: p.line2},
  railDetailRow: {flexDirection: 'row', alignItems: 'flex-start', marginTop: 8},
  railDetailCol: {flex: 1, marginLeft: 10},
  railDetailLine: {fontSize: 12, color: p.sub2, marginTop: 2, lineHeight: 17, fontFamily: FONT.sans},
  // Chain tag pill — the settlement chain's proper noun, uppercase mono, pill-shaped. Overflow
  // hidden keeps the pill's radius honest if a future chain name runs long.
  railChainTag: {paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2, fontSize: 10, fontWeight: '700', color: p.sub2, letterSpacing: 1.0, textTransform: 'uppercase', fontFamily: FONT.mono, overflow: 'hidden', marginLeft: 8, alignSelf: 'center'},
  // Rail-health note (RailLiquidityNote warn tone) — the warnRow idiom scaled to a sub-line:
  // flex-start so the alert icon anchors the FIRST line of wrapped text, warn colour throughout.
  railHealthRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 4},
  railHealthText: {flex: 1, fontSize: 12, color: p.warn, lineHeight: 17, fontFamily: FONT.sans},
  assetActions: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 10},
  assetActionBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: p.line2, minHeight: 44, backgroundColor: p.card},
  assetActionText: {color: p.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  assetCardZero: {color: p.sub2},
  // AssetGlyph monogram chips (AssetGlyph.tsx) — family-hued rounded squares carrying the native
  // symbol ($ ₿ Ξ ◎ ∂). Size comes in via inline style (width/height/radius/fontSize scale
  // together); the base classes only pin the shared chrome (center, subtle ring) so chips stay
  // crisp at any size. Ring is warm-ink (light theme).
  assetGlyph: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.glyphBorder},
  assetGlyphLg: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.glyphBorderLg},
  assetGlyphText: {fontWeight: '700', fontFamily: FONT.sansBold},
  settingsSection: {alignSelf: 'stretch', marginBottom: 28},
  relayInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 14, height: 50, paddingHorizontal: 16, fontSize: 14, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  // Advanced relay section — the relay edit is demoted below consumer settings and applied
  // EXPLICITLY via the Apply button (no live retarget on each keystroke). `advancedLabel` is the
  // small uppercase eyebrow shared with the other section headers; `applyBtn` mirrors the primary
  // button chrome but is compact (48pt, 44pt min touch target); `applyBtnDisabled` mutes it when
  // the draft == the active URL.
  advancedLabel: {fontSize: 12, fontWeight: '600', color: p.sub2, alignSelf: 'flex-start', textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 0, fontFamily: FONT.mono},
  // The Advanced disclosure toggle (Settings → Server). The header is itself a Pressable
  // spanning the row (label + caret) so the whole header is the tap target. `advancedLabel`'s
  // bottom margin is zeroed above so the toggle controls its own vertical rhythm.
  advancedToggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingVertical: 10, marginBottom: 4, minHeight: 44},
  // The caret wrapper only needs a style when COLLAPSED (rotate −90° so the chevron points
  // right; expanded = the icon's natural down).
  advancedCaretClosed: {transform: [{rotate: '-90deg'}]},
  applyBtn: {backgroundColor: p.brand, borderRadius: 16, height: 48, minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 16, shadowColor: p.brand2, shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 3},
  applyBtnText: {color: p.brandInk, fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold},
  applyBtnDisabled: {opacity: 0.4, shadowOpacity: 0, elevation: 0},
  resetConfirmBox: {alignSelf: 'stretch', backgroundColor: `rgba(${p.badRGB},0.05)`, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: `rgba(${p.badRGB},0.25)`},
  // Reset entry-point — a bordered red-outline button "Reset wallet…" with the ellipsis
  // signaling "opens a dialog". Distinct from the muted "Privacy policy" link above it, but NOT
  // a loud filled-red button (the destructive gate stays in the confirmation dialog).
  resetEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: `rgba(${p.badRGB},0.45)`, backgroundColor: `rgba(${p.badRGB},0.04)`, alignItems: 'center', justifyContent: 'center'},
  resetEntryText: {color: p.bad, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Backup affordance (Settings → Backup). Mirrors `resetEntryBtn`'s shape but BRAND-tinted so it
  // reads as a safe, recommended action. `backupConfirmBox` is the neutral caution box;
  // `seedBox` is the revealed seed display: mono, padded, inset well so it reads as a discrete
  // selectable token block.
  backupEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,90,31,0.45)', backgroundColor: 'rgba(255,90,31,0.06)', alignItems: 'center', justifyContent: 'center'},
  backupEntryText: {color: p.brand, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  backupConfirmBox: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: p.line2},
  seedBox: {alignSelf: 'stretch', backgroundColor: p.panel2, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: p.line2, marginTop: 4},
  seedText: {color: p.ink, fontFamily: FONT.mono, fontSize: 14, lineHeight: 20},
  // Numbered BIP-39 word grid (SeedWords.tsx) — three columns, ROW-MAJOR (1-2-3 across, 4-5-6
  // across, …) chunked into 1-12 / 13-24 blocks by a hairline rule under the 4th row; the scan
  // direction IS the transcription order, and the compact metrics keep all 24 words + the
  // confirm CTA above the fold at 390×844 (UX hardening 2026-08-23, round-2 audit — was
  // column-major (i, i+12) pairs, whose fold cut made 9-12 look missing). `seedGrid` is the
  // stretch container; `flex:1` on the chip keeps the three columns equal-width. The chip View
  // carries the mnemonic-word-N testID and e2e reads its textContent with the leading index
  // stripped — the index Text must stay FIRST inside the chip. `seedChipIdx` has a fixed width +
  // right-align so the words of a column start at the same x. BIP-39 words are ≤8 chars.
  seedGrid: {alignSelf: 'stretch', gap: 5, marginTop: 4, marginBottom: 8},
  seedGridRow: {flexDirection: 'row', gap: 5},
  seedGridRule: {height: 1, backgroundColor: p.line, marginVertical: 3},
  seedChip: {flex: 1, flexDirection: 'row', alignItems: 'baseline', backgroundColor: p.card, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5, borderWidth: 1, borderColor: p.line2},
  seedChipIdx: {color: p.sub2, fontFamily: FONT.mono, fontSize: 10, marginRight: 4, width: 14, textAlign: 'right'},
  seedChipWord: {color: p.ink, fontFamily: FONT.mono, fontSize: 13},
  // Keyboard-shortcut hint badge (web only — rendered by HotkeyHint). A visible "key cap": a
  // rounded square with a real border + subtle background and a mono letter. `kbdHint` is the
  // light-on-porcelain variant; `kbdHintOnBrand` flips to a white-on-tangerine variant for badges
  // that sit on the filled brand surface (active tab).
  kbdHint: {minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: p.line, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  kbdHintText: {fontSize: 13, fontWeight: '600', color: p.sub, fontFamily: FONT.mono},
  kbdHintOnBrand: {borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(0,0,0,0.14)'},
  kbdHintTextOnBrand: {color: p.brandInk},
  // Deposit sheet — a full-screen porcelain overlay above the wallet.
  // elevation is REQUIRED alongside zIndex: on Android, sibling draw order follows elevation
  // FIRST (zIndex only breaks ties within the same elevation). Without it, the elevated active
  // tab (tabActive carries LIFT → elevation: 2) rendered ON TOP of this full-screen sheet —
  // the active Pay/Receive/Transactions button visibly bleeding through the Balances/Settings
  // overlays on device (web/iOS honor zIndex, so e2e never saw it). elevation: 10 matches the
  // zIndex intent; the sheet is full-screen + opaque, so the elevation shadow is clipped
  // off-viewport and invisible.
  sheetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.bg, zIndex: 10, elevation: 10},
  sheet: {flex: 1, backgroundColor: p.bg},
  sheetHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingHorizontal: 22, paddingBottom: 14},
  sheetTitle: {fontSize: 20, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.3},
  sheetClose: {width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.card, borderWidth: 1, borderColor: p.line2},
  sheetBody: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 22, alignItems: 'center'},
  // Same as sheetBody but vertically CENTERS short content so a sheet with few rows doesn't pack
  // at the top with a dead zone below. Used ONLY on sheets whose content is reliably shorter than
  // the viewport — the tall sheets (DepositSheet address flow, WithdrawSheet form) keep top-aligned
  // sheetBody so their long content scrolls without the RN ScrollView + justifyContent:center
  // top-cutoff gotcha.
  sheetCenter: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingTop: 22, paddingBottom: 22, alignItems: 'center'},
  // Compact currency picker (Receive prefix tap): a centered card over a dimmed backdrop (rendered
  // inside a <Modal>, so it covers the whole screen regardless of where ReceiveMode sits in the
  // tree). `pickCard` uses opaque `p.panel` — an alpha wash would composite with the warm-ink veil
  // into mud; the opaque raised surface is the "panel above backdrop" idiom.
  pickBackdrop: {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: p.veil, paddingHorizontal: 28},
  pickCard: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: p.line2, ...LIFT},
  pickTitle: {fontSize: 13, fontWeight: '600', color: p.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 8, fontFamily: FONT.mono},
  // Bounded scroller for the picker rows — the catalog grows (IC + SOL rails, testnet entries),
  // and a Modal has no scroll surface, so an unbounded list would push the bottom rows off a
  // small screen with no way to reach them. maxHeight only kicks in when the rows actually
  // overflow; a short list renders identically to before.
  pickScroll: {maxHeight: 420},
  pickItem: {flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: p.line2},
  pickName: {flex: 1, fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  // pickCheck — the trailing active-check wrapper; the margin keeps the icon clear of the
  // amount/label it trails in either variant.
  pickCheck: {marginLeft: 8},
  // pickTextCol — the name+subtitle column right of the AssetGlyph chip, shared by BOTH
  // CurrencyRow variants. Takes flex:1 so the trailing check pushes to the row's right edge; the
  // 10px marginLeft is the chip-to-text gap in both variants.
  pickTextCol: {flex: 1, marginLeft: 10},
  // pickSubtitle — the chain-label line below the name in a plain-variant row.
  pickSubtitle: {fontSize: 12, color: p.sub2, marginTop: 3, fontFamily: FONT.sans},
  // Pay-scan NFC status row — a large colored NFC mark + a short label, leading the scanner. Green
  // when tap-to-pay is ready, red with a tappable "NFC not available" link + reason popup otherwise.
  nfcStatusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14},
  nfcStatusLabel: {fontSize: 18, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  // NFC review countdown chip (approve-before-pay, 2026-08-23): advisory only — the payer's
  // clock is offline/untrusted, so it never promises validity; sign-time gates are authoritative.
  nfcCountdownChip: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', marginTop: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: p.line2, backgroundColor: p.panel2},
  nfcCountdownText: {fontFamily: FONT.mono, fontSize: 11, fontWeight: '600', letterSpacing: 1, color: p.sub, textTransform: 'uppercase'},
  // Receive QR hint — a small NFC mark leading the "or let them tap" label when the reader is armed.
  nfcHintRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10},
  nfcHintLabel: {fontSize: 15, color: p.sub, textAlign: 'center', fontFamily: FONT.sans},
  nfcInfoLink: {flexDirection: 'row', alignItems: 'center', gap: 5},
  nfcInfoLinkText: {fontSize: 18, fontWeight: '600', color: p.bad, fontFamily: FONT.sansBold},
  nfcInfoBody: {fontSize: 15, color: p.ink, lineHeight: 21, marginBottom: 16, fontFamily: FONT.sans},
  nfcInfoClose: {alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: p.line2, backgroundColor: p.card},
  nfcInfoCloseText: {fontSize: 15, fontWeight: '600', color: p.ink, fontFamily: FONT.sansMedium},
  // Deposit instructions — a scannable card (network/asset + est. time + fee/min + non-custody line).
  instrCard: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: p.line2, marginBottom: 18, ...LIFT_SM},
  instrLine: {fontSize: 15, color: p.ink, textAlign: 'center', lineHeight: 21, marginBottom: 10, fontFamily: FONT.sans},
  instrAsset: {color: p.brand, fontWeight: '700', fontFamily: FONT.sansBold},
  instrMeta: {fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.mono, paddingVertical: 2},
  instrCustody: {fontSize: 12, color: p.sub2, textAlign: 'center', marginTop: 10, lineHeight: 17, fontFamily: FONT.sans},
  sheetAddr: {fontSize: 13, color: p.ink, fontFamily: FONT.mono, textAlign: 'center', marginTop: 4, marginBottom: 8, letterSpacing: 0.2},
  depositCopy: {alignSelf: 'stretch', marginTop: 12},
  depositStatus: {marginTop: 22, alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: p.line2, ...LIFT_SM},
  depositStatusTitle: {fontSize: 12, fontWeight: '600', color: p.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 6, fontFamily: FONT.mono},
  depositStatusMain: {fontSize: 16, fontWeight: '700', color: p.ink, marginBottom: 4, fontFamily: FONT.sansBold},
  depositStatusRow: {fontSize: 13, color: p.sub, fontFamily: FONT.mono},
  // Manual "Check now" — secondary (outline brand), debounced + spinner while in-flight.
  checkBtn: {marginTop: 16, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: p.brand, alignItems: 'center', justifyContent: 'center', height: 46, backgroundColor: p.card},
  checkBtnText: {color: p.brand, fontWeight: '600', fontSize: 15, fontFamily: FONT.sansMedium},
  // Testnet show/hide toggle at the bottom of the Balances sheet — a subtle secondary affordance
  // (never the primary action). Muted text; full-width 44pt touch target.
  testnetToggle: {marginTop: 18, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingVertical: 8},
  testnetToggleText: {color: p.sub, fontWeight: '600', fontSize: 14, fontFamily: FONT.sansMedium},
  // Withdraw sheet form fields.
  inputLabel: {fontSize: 13, fontWeight: '600', color: p.sub, alignSelf: 'flex-start', marginTop: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1, fontFamily: FONT.sansMedium},
  withdrawAddrInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 14, height: 56, paddingHorizontal: 16, fontSize: 15, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  savedAddrChip: {alignSelf: 'flex-start', backgroundColor: p.panel2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: p.line2},
  savedAddrText: {fontSize: 13, color: p.brand, fontFamily: FONT.mono},
  withdrawAmtInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 14, height: 56, paddingHorizontal: 16, fontSize: 22, fontWeight: '700', color: p.ink, borderWidth: 1, borderColor: p.line2, fontFamily: FONT.sansBold},
  // --- unified send-to-address field (AddressField + SendSheet) ---------------------------------
  // The destination input is MULTILINE and wraps: an IC principal is 63 characters and an ICRC-1
  // account with a subaccount is longer still, so a single 56pt line would hide the tail — and the
  // tail is exactly what a user checks against the wallet they copied it from. minHeight keeps an
  // empty field the same size as the amount field beside it.
  addrRow: {alignSelf: 'stretch', flexDirection: 'row', alignItems: 'stretch', gap: 8},
  addrInput: {flex: 1, backgroundColor: p.field, borderRadius: 14, minHeight: 56, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, lineHeight: 20, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  addrScanBtn: {width: 56, minHeight: 56, borderRadius: 14, backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2, alignItems: 'center', justifyContent: 'center'},
  // The route disclosure line — neutral/informational, distinct from warnNote (amber) and err (red).
  routeNote: {fontSize: 13, color: p.sub, alignSelf: 'flex-start', marginTop: 8, lineHeight: 18, fontFamily: FONT.sans},
  savedList: {alignSelf: 'stretch', marginTop: 14},
  savedRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  savedAddrLabel: {fontSize: 13, fontWeight: '600', color: p.ink, fontFamily: FONT.sansMedium},
  savedForget: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  // Amount row with the inline Max button.
  amtRow: {alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8},
  maxBtn: {paddingHorizontal: 16, minHeight: 56, borderRadius: 14, backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2, alignItems: 'center', justifyContent: 'center'},
  maxBtnText: {fontSize: 14, fontWeight: '700', color: p.brand, fontFamily: FONT.sansBold},
  // Review card rows: label left, value right, so amount/fee/total align down the right edge.
  reviewRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6, gap: 12},
  reviewRowLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans},
  reviewRowValue: {fontSize: 13, color: p.ink, fontFamily: FONT.mono, flexShrink: 1, textAlign: 'right'},
  reviewCard: {alignSelf: 'stretch', marginTop: 20, backgroundColor: p.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: p.line2, ...LIFT_SM},
  reviewLabel: {fontSize: 12, fontWeight: '600', color: p.sub2, textTransform: 'uppercase', letterSpacing: 1.4, marginBottom: 8, fontFamily: FONT.mono},
  // 'Needs setup' pill on the Balances USDC (Solana) row — a warn-tinted row annotation,
  // left-aligned under the subtitle (not a centered banner).
  assetBadge: {alignSelf: 'flex-start', marginTop: 6, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999, backgroundColor: `rgba(${p.warnRGB},0.08)`, borderWidth: 1, borderColor: `rgba(${p.warnRGB},0.35)`, fontSize: 11, fontWeight: '700', color: p.warn, letterSpacing: 1.1, textTransform: 'uppercase', fontFamily: FONT.mono, overflow: 'hidden'},
  // 'Main' pill on the Balances row that IS the home currency's rail. Same pill geometry as
  // `assetBadge`, brand-tinted rather than warn-tinted: this one marks the account the wallet opens
  // with, which is a statement of fact, not a warning about setup.
  assetBadgeMain: {alignSelf: 'flex-start', marginTop: 6, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 999, backgroundColor: 'rgba(255,90,31,0.08)', borderWidth: 1, borderColor: 'rgba(255,90,31,0.35)', fontSize: 11, fontWeight: '700', color: p.brand, letterSpacing: 1.1, textTransform: 'uppercase', fontFamily: FONT.mono, overflow: 'hidden'},
  // ─── Walkthrough (Trip Ready J1, 2026-08-22) ────────────────────────────────────────────────
  // The first-run 3-scene pager + its Settings replay. Editorial travel-document layout: a
  // left-aligned eyebrow/title/body block over a "paper plate" illustration stage, then a footer
  // with progress dots + the primary Next. Tangerine stays reserved for Next, the active dot, and
  // the in-scene stamp accents (brand discipline is unchanged).
  walkRoot: {flex: 1, backgroundColor: p.bg},
  // Chrome (founder ask 2026-08-24): the education surfaces share the app's standard sheet
  // header — S.sheetHead + S.sheetTitle + the 44pt boxed S.sheetClose top-right — exactly the
  // SettingsSheet grammar, instead of a bespoke wordmark/Skip bar. The boxed affordance is
  // close in the Walkthrough replay and skip/explore on first-run + Rehearsal.
  walkBackBtn: {minHeight: 44, paddingHorizontal: 12, justifyContent: 'center'},
  walkBackText: {color: p.sub, fontSize: 15, fontWeight: '600', fontFamily: FONT.sansMedium},
  // Text block — LEFT-aligned (the editorial reading; centered stacks read as generic onboarding,
  // which the spec bans). 22dp side margins = the sheet rhythm (sheetHead/sheetCenter use 22).
  walkBody: {paddingHorizontal: 22, paddingTop: 6},
  walkEyebrow: {fontSize: 11, fontWeight: '600', color: p.sub2, letterSpacing: 1.8, textTransform: 'uppercase', fontFamily: FONT.mono},
  walkTitle: {fontSize: 29, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.7, lineHeight: 33, marginTop: 12},
  walkText: {fontSize: 16, color: p.sub, lineHeight: 23, marginTop: 12, fontFamily: FONT.sans},
  // The illustration stage — a "paper plate": raised panel + hairline, fixed aspect so every
  // scene's illustration occupies the same stage (visual continuity across the pager).
  walkStage: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 22, borderWidth: 1, borderColor: p.line2, overflow: 'hidden', marginTop: 26, aspectRatio: 1.32, ...LIFT_SM},
  // Corner marker on the plate — the travel-document detail ("01 — SIGNAL"): mono, top-right.
  walkStageTag: {position: 'absolute', top: 12, right: 16, fontSize: 10, fontWeight: '600', color: p.brand, letterSpacing: 1.4, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, transform: [{rotate: '3deg'}], opacity: 0.9},
  walkFooter: {paddingHorizontal: 22, paddingBottom: 14, paddingTop: 18},
  // Dots row: relative so the Back link can sit absolutely at the left while the dots center.
  walkNavRow: {position: 'relative', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 12, minHeight: 34},
  walkDot: {height: 6, borderRadius: 3, backgroundColor: p.line},
  walkDotOn: {backgroundColor: p.brand},
  // The campaign send-off strip (final scene): fine rules flank the mono line.
  walkCampaign: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16, marginTop: 2},
  walkCampaignRule: {flex: 1, height: 1, backgroundColor: p.line},
  walkCampaignText: {fontSize: 11, fontWeight: '600', color: p.sub, letterSpacing: 2.2, textTransform: 'uppercase', fontFamily: FONT.mono},
  // Scene 3 illustration — the request card with ONE exact asset + ghost rows that stay put.
  walkReqCard: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 16, borderWidth: 1, borderColor: p.line2, padding: 14},
  walkReqEyebrow: {fontSize: 10, fontWeight: '600', color: p.sub2, letterSpacing: 1.6, textTransform: 'uppercase', fontFamily: FONT.mono},
  walkAssetRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, marginTop: 6},
  walkAssetChip: {width: 34, height: 34, borderRadius: 11, borderWidth: 1, borderColor: p.glyphBorder, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  walkAssetChipText: {fontSize: 15, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  walkAssetName: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  walkAssetSub: {fontSize: 11, color: p.sub2, marginTop: 2, fontFamily: FONT.sans},
  walkAssetAmt: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, marginLeft: 'auto'},
  // The tangerine "reviewed" stamp badge (in-scene accent; real confirmed-success green stays
  // reserved for actual settlement states).
  walkStampBadge: {width: 26, height: 26, borderRadius: 13, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', marginLeft: 10, shadowColor: p.brand2, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: {width: 0, height: 3}, elevation: 3},

  // ─── Trip Ready J2B (2026-08-22): recovery ritual, rehearsal, first-use coaching ──────────
  // The backup screen's ownership line — the ritual sentence ABOVE the warning. Slightly larger
  // than the warning, ink (not warn-tinted): the moment reads as ownership first, risk second.
  backupRitualNote: {fontSize: 15, color: p.ink, textAlign: 'center', marginTop: -8, marginBottom: 14, paddingHorizontal: 8, lineHeight: 21, fontFamily: FONT.sansMedium},
  // The RECOVERY SAVED passport-stamp chip (the post-faucet beat): tangerine ring, mono
  // letterspaced caps, a kept -3° tilt (the stamp lands slightly crooked — passport-stamp
  // aesthetic; the tilt itself is animated, this is the resting angle).
  stampChip: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, borderWidth: 1.5, borderColor: p.brand, backgroundColor: 'transparent', transform: [{rotate: '-3deg'}]},
  stampChipText: {color: p.brand, fontFamily: FONT.mono, fontSize: 12, fontWeight: '600', letterSpacing: 2.4, textTransform: 'uppercase'},
  // The RECOVERY SAVED beat, re-skinned (UX hardening 2026-08-23): a full-bleed INK moment —
  // the one deliberate dark beat of onboarding (was: a tiny chip on ~96% blank porcelain, which
  // read as a crash flash). Dark-theme-safe: uses `ink`/`bg` semantics so it inverts to
  // porcelain-on-ink there (never #000 — the palette discipline holds).
  inkBeat: {flex: 1, backgroundColor: p.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36},
  inkStamp: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999, borderWidth: 2, borderColor: p.brand},
  inkStampText: {color: p.bg, fontFamily: FONT.mono, fontSize: 14, fontWeight: '600', letterSpacing: 3, textTransform: 'uppercase'},
  inkBeatLine: {color: p.bg, fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: 34, lineHeight: 22, fontFamily: FONT.sansMedium},
  inkBeatSub: {color: p.brand, fontSize: 13, textAlign: 'center', marginTop: 8, fontFamily: FONT.mono, letterSpacing: 0.4},
  // Rehearsal, re-paged to ONE screen (UX hardening 2026-08-23): scroll container + three
  // badge/line rows in the walkthrough's postage-mark grammar (tangerine mono tag, hairline
  // border, slight tilt) — the old auto-advance rail died with the pager.
  walkScroll: {flex: 1},
  rehStep: {marginTop: 18},
  rehBadge: {alignSelf: 'flex-start', borderWidth: 1, borderColor: p.line2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 7, transform: [{rotate: '-2deg'}]},
  rehBadgeText: {color: p.brand, fontSize: 10, fontWeight: '600', letterSpacing: 1.4, textTransform: 'uppercase', fontFamily: FONT.mono},
  rehStepTitle: {color: p.ink, fontSize: 17, fontWeight: '700', fontFamily: FONT.sansBold},
  rehStepBody: {color: p.sub, fontSize: 14.5, lineHeight: 21, marginTop: 4, fontFamily: FONT.sans},
  // CoachTip — the one-time contextual card. Small paper panel (panel, not card: it sits ON the
  // surface, quieter than the QR card), hairline + soft lift; icon chip echoes walkAssetChip so
  // the coaching voice matches the walkthrough's. NEVER fixed/overlay — inline, so it can never
  // block the primary action.
  coachCard: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 14, borderWidth: 1, borderColor: p.line2, padding: 12, marginTop: 14, ...LIFT_SM},
  coachRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  coachIcon: {width: 30, height: 30, borderRadius: 10, borderWidth: 1, borderColor: p.glyphBorder, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  coachText: {flex: 1, minWidth: 0},
  coachTitle: {fontSize: 13, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  coachBody: {fontSize: 12.5, color: p.sub, lineHeight: 17.5, marginTop: 2, fontFamily: FONT.sans},
  coachDismiss: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -4},
  });
}

// ─── Live theme machinery ────────────────────────────────────────────────────────────────────
// S is a MUTABLE holder: initialized from the OS-resolved palette at module load, then swapped
// in place by `applyPalette`. This works through every bundler interop because we only ever
// Object.assign onto the SAME exported object — we never reassign the binding:
//   • Metro/Hermes (native): `import {S}` compiles to a CJS property access on module.exports —
//     in-place mutation is exactly what every use-site reads.
//   • vite/rollup ESM (web bundle): `S` is a live binding to the same object; mutation of the
//     object is visible regardless of binding semantics.
//   • jest: same CJS interop as Metro.
// StyleSheet.create in RN 0.86 is an identity function that (in DEV only) Object.freezes each
// INNER style object but NOT the returned registry — so replacing S's KEYS via Object.assign is
// always legal. Verified by __tests__/palette.test.ts and the flow-84 dark e2e (real browser).

/** The live stylesheet. Read `S.x` at render time; treat the object as opaque + immutable
 *  outside `applyPalette`. */
export const S = buildStyles(LIGHT);

/** Synchronous OS-scheme probe at module load, so the FIRST paint already matches the OS theme
 *  (no light flash on a dark OS). RN Appearance covers both native (uiMode) and RNW
 *  (window.matchMedia). Safe under jest (mocked Appearance → null → light). */
function initialSchemeIsDark(): boolean {
  try {
    const Appearance = require('react-native').Appearance;
    if (Appearance && typeof Appearance.getColorScheme === 'function') {
      return Appearance.getColorScheme() === 'dark';
    }
  } catch {
    // react-native unavailable mid-cycle → light (matches the historical default)
  }
  return false;
}

let applied: Palette = LIGHT;
let darkNow = false;

/** Swap the live palette + rebuild S in place. Idempotent (re-applying the same palette is a
 *  no-op), so App.tsx can call it on every render cheaply. Also mutates the palette `C` (the
 *  render-time color source for inline styles) so `S.x` and `C.x` never disagree. */
export function applyPalette(p: Palette) {
  if (p === applied) return;
  applied = p;
  darkNow = p === DARK;
  Object.assign(C, p);
  Object.assign(S, buildStyles(p));
}

/** Whether the DARK palette is currently applied (used by AssetGlyph's dark family hues, which
 *  live outside the S registry). */
export function isDark(): boolean {
  return darkNow;
}

// Resolve the OS theme BEFORE first render. This runs at styles.ts module load — before App's
// first render in every entry (native index.js, web entry.tsx, jest imports) — so the initial
// S/C already carry the right theme.
applyPalette(initialSchemeIsDark() ? DARK : LIGHT);
