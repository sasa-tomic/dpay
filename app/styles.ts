import {StyleSheet, type TextStyle} from 'react-native';
import {C, DARK, FONT, LIGHT, withAlpha} from './config/palette';
import type {Palette} from './config/palette';

// "Ballast" - the 2026-09-26 identity: cold, dense, instrument-quiet. Mist surfaces + graphite
// ink (LIGHT) and petrol-black night + ice ink (DARK); deep petrol teal reserved for action.
// Depth comes from layered surfaces; shadows exist on exactly two element types (the primary CTA
// and the bottom nav carry LIFT-family shadow, a raised sheet/pick-card may carry LIFT_SM).
// Space Grotesk carries UI, amounts are the typographic heroes (700 + tabular figures); IBM Plex
// Mono carries ONLY opaque strings: addresses, principals, hashes, seeds, calldata, relay URLs.
//
// CALIBER - the shape system (founder 2026-09-27: "rounded buttons ... shouting 'made by AI'").
// Exactly FOUR radius values, each with one job, applied app-wide:
//   0    (R_SHARP) full-bleed chrome, hairlines/rules, the nav indicator bar
//   8    (R_CTRL)  EVERY control: buttons, inputs, chips, toggle segments, icon buttons
//   12   (R_CARD)  cards, wells, the viewfinder, sheets, panels
//   half (R_DISC)  TRUE circles only: dots, discs, glyph chips
// No pills (999) except genuinely-round elements. Nested surfaces follow inner = outer - padding
// (the mode-toggle track is 8 with 4px padding, so its active segment is 4). Off-grid spacing is
// swept to the 4pt grid; three tiers do the grouping: 8 inside, 16 between, 24 sections.
//
// WHICH TEAL GOES WHERE is decided in config/palette.ts and is not a matter of taste here:
// `p.brand` is a FILLED area (the Settlement Field, button, active tab/chip, filled dot) and only
// `p.brandInk` may sit on it; `p.brandText` is every unfilled accent - text, icons, hairline
// rings, and the `p.wash` tint of itself. Picking the wrong one is a contrast failure, not a
// shade preference, and app/__tests__/contrast.test.ts measures it off this stylesheet.
//
// THE ONE-BLOCK RULE STILL HOLDS: this file stays ONE style vocabulary, now expressed as a
// `buildStyles(palette)` builder. `S` is a mutable holder initialized from the OS-resolved
// palette; `applyPalette` swaps every key in place. Never partition this into per-screen files.

// The two elevations (brief §3.3). LIFT: the primary CTA and the floating bottom nav.
// LIFT_SM: a raised sheet or pick-card over the page. Nothing else casts a shadow. iOS shadow +
// Android elevation pair so the lift reads on both platforms; shadowColor comes from the palette
// (graphite in light, near-black - never #000 - in dark).
const lift = (p: Palette) => ({
  shadowColor: p.shadow,
  shadowOpacity: 0.10,
  shadowRadius: 16,
  shadowOffset: {width: 0, height: 5},
  elevation: 3,
} as const);
const liftSm = (p: Palette) => ({
  shadowColor: p.shadow,
  shadowOpacity: 0.07,
  shadowRadius: 10,
  shadowOffset: {width: 0, height: 3},
  elevation: 1,
} as const);

// The mode surface, minus its vertical rule - shared by `center` and `centerTop` so the two differ
// in exactly one property and cannot drift apart.
//
// `alignSelf:'stretch'` is the load-bearing line. A mode surface is a flex ITEM of whatever column
// it is mounted in, and a column that centers its children (`alignItems:'center'`) sizes a
// non-stretched item to its own MAX-CONTENT - which flexbox does not clamp to the parent's width.
// A nested surface therefore grew WIDER than the column it sits in and hung off both edges: the
// cashier checkout-open form measured 533 px inside a 358 px column (x = −71.7) with the `CHF` prefix and
// the button's corner radii off-screen. Stretching states the contract the surface always had -
// it fills the content column - at every mount point instead of only where the parent happens to
// default to `stretch`.
const MODE_SURFACE = {
  flexGrow: 1,
  flexShrink: 0,
  alignSelf: 'stretch',
  alignItems: 'center',
} as const;

function buildStyles(p: Palette) {
  const LIFT = lift(p);
  const LIFT_SM = liftSm(p);
  // A non-tab ROUTE's header - back chevron · title · symmetric spacer. ONE geometry, ONE name.
  // (It briefly carried a second set of `convertHeader*` aliases so ConvertMode could keep its
  // older names while another change was in flight; ConvertMode now uses these and the aliases
  // are gone - two names for one object is exactly the drift this const exists to prevent.)
  // The wordmark's own setting, named because `wordmarkBig` is the SAME type at another size and
  // both are rendered standalone (see `wordmarkBig`).
  const WORDMARK = {fontSize: 27, fontWeight: '700', letterSpacing: -0.8, color: p.ink, fontFamily: FONT.sansBold} as const;
  const ROUTE_HEADER_ROW = {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16, minHeight: 40} as const;
  const ROUTE_HEADER_TITLE = {flex: 1, fontSize: 22, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.3} as const;
  const ROUTE_HEADER_SPACER = {width: 26} as const;
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
  // Desktop frame: fills the whole viewport with the mist bg and centers the capped app
  // column. At <=480px it is a no-op (the column is already full-width).
  screenFrame: {flex: 1, backgroundColor: p.bg, alignItems: 'center'},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  // Onboarding ScrollView contentContainer. `flexGrow` (NOT `flex:1`): flex clamps the content
  // height to the scroll frame, which structurally DISABLES scrolling - on a small screen the
  // seed-backup gate overflowed with the Continue button unreachable. flexGrow lets short content
  // still fill + center the frame while tall content grows past it and scrolls.
  onboard: {flexGrow: 1, padding: 24, justifyContent: 'center', alignItems: 'center'},
  wordmark: WORDMARK,
  wordmarkPay: {color: p.brandText},
  // The 36pt setting. It is NOT only a modifier composed onto `wordmark` - two sites apply it
  // STANDALONE as a page heading (Onboarding's "Back up your wallet", the home-currency chooser's
  // "Which currency do you think in?"). While it carried only a size and a margin, both rendered
  // in the platform default: black, weight 400, system face - measured at 1.12:1 on the dark
  // theme's page, i.e. an invisible heading, and the wrong typeface in the light one. Spreading
  // WORDMARK makes it self-sufficient at every mount point and byte-identical where it is
  // composed, so the two settings cannot drift.
  wordmarkBig: {...WORDMARK, fontSize: 36, marginTop: 14},
  onboardSub: {fontSize: 16, color: p.sub, textAlign: 'center', marginTop: 8, marginBottom: 24, paddingHorizontal: 12, lineHeight: 22, fontFamily: FONT.sans},
  // ∂ is the demo-dollar symbol - unfamiliar on first glance. The onboarding one-liner explains
  // it inline next to the demo funds note so a first-time user has the mapping before they see
  // their balance. `dpayGlyph` carries the glyph in ink; `dpayGlyphNote` is the surrounding line.
  dpayGlyph: {color: p.ink, fontWeight: '700', fontFamily: FONT.sansBold},
  dpayGlyphNote: {fontSize: 13, color: p.sub, marginTop: 4, textAlign: 'center', paddingHorizontal: 12, lineHeight: 18, fontFamily: FONT.sans},
  usernameInput: {backgroundColor: p.field, borderRadius: 8, height: 56, paddingHorizontal: 18, fontSize: 20, color: p.ink, marginBottom: 8, borderWidth: 1, borderColor: p.line2, alignSelf: 'stretch', fontFamily: FONT.sansMedium},
  // Restore-mode recovery-seed input (64 hex chars). Like usernameInput but monospace + multiline so
  // the long seed wraps readably; minHeight instead of fixed height so it grows with content.
  seedInput: {backgroundColor: p.field, borderRadius: 8, minHeight: 56, paddingHorizontal: 18, paddingVertical: 14, fontSize: 16, fontFamily: FONT.mono, color: p.ink, marginBottom: 8, borderWidth: 1, borderColor: p.line2, alignSelf: 'stretch'},
  // Header - borderless on the page (whitespace separates chrome from content; hairlines under
  // the header read as spreadsheet chrome). Balanced horizontal padding.
  // Paddings and gap are tight on purpose: two rows cost more vertical space than one, and this
  // is the header of a screen whose job is below it. Measured against the one-row version, the
  // trim gives back most of the difference without letting the rows touch.
  header: {paddingTop: 12, paddingLeft: 16, paddingRight: 16, paddingBottom: 8, gap: 8},
  // TWO ROWS, not one (founder, 2026-09-09: "move balance below ∂pay, to give it more room").
  // Side by side, the balance and the identity were competing for one 390 px line and the balance
  // always won: `balBox` could not shrink, so an 8-decimal amount like "3.99029806 VCHF" took the
  // row and the identity block collapsed to ~20 px - "∂pay" rendered one glyph per line and the
  // eyebrow wrapped to A/C/C/O/U/N/T (measured on the device, 2026-09-09). Giving each its own row
  // removes the competition entirely: nothing can squeeze anything, at any name or amount length.
  headerTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  // Header utility buttons (settings, theme): 44x44 borderless targets - the instrument-quiet
  // choice. A bordered white chip here stacked a second box language onto a header that is
  // otherwise transparent chrome; the glyph on the page carries the affordance (sub on bg is
  // gated ≥4.5) and the touch floor is the size. Radius is retired with the box.
  headerSettingsBtn: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  // `marginLeft` on top of headerTop's 8px gap separates the utility buttons from the identity -
  // at 4 px the ∂ read as a third button (the "collide" half of X18).
  brand: {fontSize: 24, marginLeft: 4},
  // The username, inline beside the wordmark. `flexShrink` lets a long name ellipsize rather than
  // push anything; the ACCOUNT eyebrow that used to sit above it is gone (founder 2026-09-09) - it
  // labelled a name with a word that told the user nothing, and existed only because the crushed
  // column made "∂pay" and the name read as one string.
  who: {fontSize: 13, color: p.sub, fontFamily: FONT.sansMedium, flexShrink: 1},
  // NFC takeover badge - a soft ring on porcelain (no filled disc); the glyph/icon carries tone.
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 3, borderColor: p.line, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.4},
  nfcSub: {fontSize: 16, color: p.sub, marginTop: 8, textAlign: 'center', paddingHorizontal: 24, lineHeight: 22, fontFamily: FONT.sans},
  // ── Trip Ready J5 motion system (additive) ──────────────────────────────────────────────
  // The breathing ring around the listening badge (renders BEHIND S.nfcBadge; only scale +
  // opacity animate - both non-layout props, so parent layout never re-flows mid-breath).
  nfcBreath: {position: 'absolute', width: 108, height: 108, borderRadius: 54, borderWidth: 1.5, borderColor: p.brandText},
  // The itinerary-line strip: two phone marks + the segments that light as the protocol
  // advances (linking → exchanging → awaitingApproval → settling). Sits between the badge and
  // the title; static SVG geometry, only opacities animate.
  nfcLineRow: {flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 4, height: 34},
  nfcLineTrack: {flex: 1, height: 2, borderRadius: 1, backgroundColor: p.line},
  // The pending stillness: an unhurried ellipsis pulse (the OPPOSITE of a success mark -
  // warn tone, no rotation, no scale press, deliberately slow).
  nfcEllipsis: {flexDirection: 'row', gap: 7, marginTop: 20, alignItems: 'center'},
  nfcEllipsisDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: p.warn},
  // ── The one-shot offline peak (J5) ───────────────────────────────────────────────────────
  // Full-width moment ABOVE the paid card: the campaign line as a strong editorial line and
  // the "no signal the whole time" microcopy. Settles INTO the card (~2s).
  peakWrap: {alignSelf: 'stretch', alignItems: 'center', marginBottom: 18},
  peakCampaign: {fontSize: 24, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.3, marginBottom: 12},
  peakMicro: {fontSize: 14, color: p.sub, marginTop: 12, textAlign: 'center', fontFamily: FONT.sans},
  // The settled remnant: the quiet mono line that stays on the paid card after the peak
  // settles - the durable "this was the first offline one" mark (e2e testID `first-offline-stamp`).
  peakSettled: {marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 6},
  peakSettledText: {fontSize: 12, fontWeight: '600', color: p.sub2, fontFamily: FONT.sans},
  // ── The Trip Readiness passport (J5b) ────────────────────────────────────────────────────
  // A readiness checklist card: white card, the section row, and the 2×2 slot grid. Empty
  // positions are quiet hairline wells (a step NOT yet done); filled positions carry a
  // brandText ring and a sentence-case label. The stamp/tilt decoration grammar is retired.
  passportCard: {alignSelf: 'stretch', marginTop: 2, backgroundColor: p.card, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 16},
  passportHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  passportRule: {height: 1, backgroundColor: p.line, marginTop: 10},
  passportGrid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 18, rowGap: 14},
  passportSlot: {width: 88, height: 88, borderRadius: 44, borderWidth: 1, borderColor: p.line2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  passportSlotFilled: {width: 88, height: 88, borderRadius: 44, borderWidth: 2, borderColor: p.brandText, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5},
  passportSlotText: {color: p.sub, fontFamily: FONT.sans, fontSize: 11, fontWeight: '600', textAlign: 'center', lineHeight: 14},
  passportSlotTextFilled: {color: p.brandText, fontFamily: FONT.sans, fontSize: 11, fontWeight: '600', textAlign: 'center', lineHeight: 14},
  // The ONE contextual next-step row (incomplete only): a quiet "NEXT" tag + active-voice
  // sans hint + an up-right arrow, wrapped as a full-width ghost button (UX 2026-08-23: the
  // plain-text row read as dead text - it now takes you to the step's home instead of
  // describing where to go). The tag is quiet brandText chrome.
  passportHint: {flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch', justifyContent: 'flex-start'},
  passportHintTag: {color: p.brandText, fontFamily: FONT.sans, fontSize: 11, fontWeight: '600'},
  passportHintText: {flexShrink: 1, fontSize: 13, color: p.sub, fontFamily: FONT.sans, textAlign: 'left'},
  passportHintArrow: {marginLeft: 'auto', flexShrink: 0},
  // The completed card's durable mark: the chip grammar ("TRIP READY") + the promise
  // line. Quiet ink, no counters - the capstone moment above is the ONLY loud beat.
  passportReadyWrap: {marginTop: 16, alignItems: 'center'},
  passportReadyLine: {fontSize: 13, color: p.sub, textAlign: 'center', marginTop: 10, fontFamily: FONT.sans},
  // The capstone overlay: the full-card completion press (~1s), then it lifts to reveal the
  // static completed card + Done. UX hardening 2026-08-23 (M3) made the overlay full-bleed;
  // the Ballast identity finishes the move: it is a Settlement Field - full-bleed `brand`,
  // `brandInk` type, no tilt, no stamp chrome.
  passportCapstoneInk: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 12, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18},
  passportCapStamps: {alignItems: 'center', gap: 4, marginBottom: 18},
  passportCapStampText: {color: p.brandInk, fontFamily: FONT.sans, fontSize: 11, fontWeight: '600', textAlign: 'center', lineHeight: 14},
  passportSlotDate: {color: p.sub2, fontFamily: FONT.sans, fontSize: 10, marginTop: 3, textAlign: 'center'},
  passportCapstoneText: {color: p.brandInk, fontFamily: FONT.sansBold, fontSize: 16, fontWeight: '700', textAlign: 'center', lineHeight: 20},
  passportCapstoneMicro: {fontSize: 13, color: p.brandInk, marginTop: 14, textAlign: 'center', fontFamily: FONT.sans, opacity: 0.85},
  // The account chip owns the header's second row outright, so it no longer competes with the
  // identity for width and the amount can be as long as the ledger makes it.
  balBox: {alignSelf: 'stretch'},
  // Eyebrow (dot + asset name + A hotkey badge) on the left, amount + switcher chevron on the
  // right - the account-selector shape, and the reason the amount has the whole right side.
  balHeaderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1},
  balAmtRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  // The practice faucet's refusal, rendered ONCE by Wallet above the mode switch. It sits outside
  // the scroll body because the `T` hotkey fires from EVERY surface and its answer has to be on
  // whichever one the user is looking at - printed inside a tab it was invisible from the other
  // three, which is a control that answers nothing (founder rule 2026-08-29). Hence the horizontal
  // padding: it has no `S.body` around it.
  topUpErr: {fontSize: 13, color: p.bad, marginBottom: 8, paddingHorizontal: 16, textAlign: 'center', fontFamily: FONT.sans},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: p.sub, fontFamily: FONT.sansMedium},
  balAmt: {fontSize: 24, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.4, fontVariant: ['tabular-nums']},
  // The transient Android back-to-exit hint under the header balance (inline Text, not a
  // toast - no native module, matches the caption tone but with a warn tint for visibility).
  balBackHint: {fontSize: 12, color: p.warn, marginTop: 6, textAlign: 'right', fontFamily: FONT.sansMedium},
  // Bottom navigation bar (O4 S1) - the persistent primary nav, replacing the old top pill row.
  // Rendered AFTER the ScrollView inside the SafeAreaView so it never scrolls away; the
  // SafeAreaView owns the bottom safe-area inset (web env() inset; native MainActivity's API-35
  // content-frame reservation). Card surface + top hairline + soft lift so it reads as chrome
  // floating over content; the full-screen sheets still cover it (their overlay runs elevation 10
  // vs the bar's 1). Four `flex:1` tabs split the full 390px row - no wrap needed.
  bottomNav: {flexDirection: 'row', alignItems: 'stretch', backgroundColor: p.card, borderTopWidth: 1, borderTopColor: p.line2, paddingHorizontal: 8, paddingVertical: 6, ...LIFT_SM},
  // TripStrip (UX hardening 2026-08-23) - the home-surface readiness line: one slim pill row
  // between the header and the tabs. 4 progress dots (filled = brand) + a sans progress
  // phrase. Quiet by design (panel2 well) - it informs, never shouts; retires itself once
  // readiness is complete + seen.
  tripStrip: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: p.panel2},
  tripStripDots: {flexDirection: 'row', gap: 6, alignItems: 'center'},
  tripStripDot: {width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: p.line2},
  tripStripDotFilled: {borderColor: p.brand, backgroundColor: p.brand},
  tripStripText: {fontFamily: FONT.sans, fontSize: 13, fontWeight: '600', color: p.ink, flexShrink: 1},
  tripStripArrow: {marginLeft: 'auto', flexShrink: 0},
  tab: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: p.card, minHeight: 44, borderWidth: 1, borderColor: p.line2},
  tabActive: {backgroundColor: p.brand, borderColor: p.brand},
  tabText: {color: p.sub, fontWeight: '600', fontFamily: FONT.sansMedium},
  tabTextActive: {color: p.brandInk, fontFamily: FONT.sansBold},
  // Bottom-bar tab (CALIBER shape system) - icon over label, `flex:1` so the tabs split the bar
  // equally on a 390px phone; minHeight 56 clears the 44pt touch floor with comfortable thumb room.
  // The active state is NO LONGER a filled pill (the rounded-everything tell): it is a 16×2 brand
  // indicator bar (R_SHARP - a rule, not a chip) over the icon + ink label + brandText icon. The
  // 2px spacer in the inactive state keeps the cell height identical in both states - no shift on
  // toggle. Labels are 11px single-line-safe: FOUR tabs share the bar since O4 slice 1 (Home +
  // Pay + Receive + Transactions, ~86px each), and the longest locale label ("Transactions",
  // en/fr ≈ 73–79px at 11px) still fits without truncation, so no numberOfLines clamp is needed.
  bottomTab: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingTop: 4, paddingBottom: 8, minHeight: 56},
  bottomTabIndicator: {width: 16, height: 2, borderRadius: 1, backgroundColor: p.brand},
  bottomTabIndicatorOff: {width: 16, height: 2, borderRadius: 1, backgroundColor: 'transparent'},
  bottomTabText: {color: p.sub, fontWeight: '600', fontSize: 11, fontFamily: FONT.sansMedium},
  bottomTabTextActive: {color: p.ink, fontFamily: FONT.sansBold},
  // ── The Home tab (O4) - the balance-first home surface ────────────────────────────────────
  // Headline: ONE currency's summed balance (never a portfolio sum), label + big number stacked,
  // LEFT-aligned on the page gutter - the whole content column shares one alignment axis
  // (typeui ui-principles §16: mixed center/left axes on one surface read as accidental). The
  // block IS the accounts affordance since 2026-09-14 (the founder's balance-tap directive); the
  // chevron beside the number carries X7's "a ⌄ beside a balance opens the account list" grammar.
  // The action row is ONE divided panel (CALIBER): a single R_CARD container, hairline cells -
  // the "four identical floating cards" kit is gone. The activity feed reuses the Ledger's
  // histRow grammar (via the shared HistoryRow) under a section header row that carries
  // "See all" on its right end (proximity: the action belongs to the section, not to the void
  // under the list).
  homeHeadline: {alignSelf: 'stretch', alignItems: 'flex-start', marginTop: 12, marginBottom: 4},
  homeEyebrowRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  homeEyebrow: {fontSize: 13, color: p.sub, marginBottom: 8, fontFamily: FONT.sansMedium},
  homeAmountRow: {flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '100%'},
  homeAmount: {fontSize: 44, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -1, flexShrink: 1, fontVariant: ['tabular-nums']},
  // The ONE Convert affordance (founder 2026-10-05): a quiet chip pinned to the screen's top
  // right, ABOVE the headline. One row, one end - the row exists for the alignment alone.
  homeTopRow: {flexDirection: 'row', justifyContent: 'flex-end'},
  homeConvertBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, minHeight: 40, borderRadius: 8, borderWidth: 1, borderColor: p.line2, backgroundColor: p.card},
  homeConvertText: {fontSize: 13, color: p.ink, fontFamily: FONT.sansMedium},
  // The action PANEL: one card, R_CARD, hairline, cells divided by hairlines (the container
  // clips, so cells carry no radius of their own - nested-radius rule). No shadows anywhere:
  // the panel is flat on the page, elevation is reserved for the CTA + nav.
  homeActionRow: {flexDirection: 'row', alignSelf: 'stretch', marginTop: 16, backgroundColor: p.card, borderRadius: 12, borderWidth: 1, borderColor: p.line2, overflow: 'hidden'},
  homeActionBtn: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, paddingHorizontal: 4, minHeight: 64},
  // Cells 2..4: one full-height hairline divider each - a border that exists the whole way
  // (the "half-existing border" tell is a divider that stops short or doubles as a shadow).
  homeActionCell: {borderLeftWidth: 1, borderLeftColor: p.line2},
  homeActionLabel: {fontSize: 12, lineHeight: 16, minHeight: 32, color: p.ink, fontFamily: FONT.sansMedium, textAlign: 'center'},
  // Section header row: the label and its action share ONE row and ONE baseline; 44px keeps the
  // See-all tap target at the touch floor. 8px binds the row to its list (tight inner) before
  // the 24px section gap below (loose outer).
  homeSectionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: 0},
  homeSeeAll: {minHeight: 44, justifyContent: 'center', alignItems: 'flex-end', paddingLeft: 16, flexShrink: 0},
  homeSeeAllText: {color: p.brandText, fontWeight: '600', fontSize: 14, fontFamily: FONT.sansMedium},
  homeActivity: {alignSelf: 'stretch', marginTop: 24},
  // The in-app update notice (2026-10-04): ONE hairline-bound row — the line left, ONE compact
  // brand-fill button right (the primary-button idiom at keycap size; LIFT stays reserved for
  // full-width CTAs). Renders NOTHING when the check is silent: no reserved space, nothing to
  // dismiss.
  updateRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, alignSelf: 'stretch', marginTop: 12, backgroundColor: p.card, borderRadius: 12, borderWidth: 1, borderColor: p.line2, paddingVertical: 8, paddingLeft: 12, paddingRight: 8},
  updateText: {flexShrink: 1, fontSize: 13, lineHeight: 18, color: p.ink, fontFamily: FONT.sans},
  updateBtn: {minHeight: 44, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: p.brand},
  updateBtnText: {color: p.brandInk, fontSize: 15, fontWeight: '700', fontFamily: FONT.sansBold},
  // ── The Accounts route (2026-09-08) - the accounts list lifted off Home ────────────────────
  // Same rows, same testIDs; a route header (back + title) instead of an inline section heading,
  // and a divider that names the practice rail in a whole sentence before its row.
  // Bottom inset doubles as the accounts route's scroll-end clearance: when the list is scrolled
  // fully down, the practice footer line sits this far above the bottom nav bar instead of
  // touching it (founder UX pass 2026-09-21).
  accountsWrap: {alignSelf: 'stretch', paddingTop: 2, paddingBottom: 24},
  // Header/list/practice are accounts-scoped trims (routeHeaderRow/accountsList margins hold for
  // the shared routes): the practice sentence WRAPS TO TWO LINES at 390pt, so the at-rest fold
  // needs the whole 2-line box + ~5pt clearance above the bottom nav - measured from the rendered
  // screen, not from a single line box. Without the ~18pt reclaimed here the nav slices the second
  // line mid-glyph at rest (visual-audit round 2, 2026-09-22).
  accountsHeader: {...ROUTE_HEADER_ROW, marginBottom: 10},
  accountsList: {alignSelf: 'stretch', marginTop: 8},
  // Currency-section chrome (groupAccountsByCurrency render): a quiet label naming the currency -
  // a section is a label, never a total. The optional rail-switch link wraps to its own line
  // below (see accountsGroupSwitch).
  accountsGroupHead: {
    alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, marginBottom: 2,
  },
  accountsGroupLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, flexShrink: 1},
  // The rail-switch link wraps UNDER its section label (flexBasis 100% + the head's wrap): the
  // full rail name ("Switch to ckUSDC · Internet Computer") plus the label never fit one phone
  // row, and shrinking the label wrapped the currency name mid-word. Stacked, the label reads
  // whole and the link keeps its 44px touch row. Sections without a switch render one line,
  // exactly as before.
  accountsGroupSwitch: {flexBasis: '100%', minHeight: 44, justifyContent: 'center', alignItems: 'flex-start'},
  // Still seats the sentence immediately above its practice row (anti-scam rule R3 keeps them
  // unseparable by a scroll).
  accountsPractice: {fontSize: 13, color: p.sub, marginTop: 6, marginBottom: 8, fontFamily: FONT.sans},
  // [Add new currency] - the full-width pill at the currency list's end (the assetActionBtn
  // chrome, stretched to the list so the affordance reads as a list action, not a row's).
  accountsAddCurrency: {alignSelf: 'stretch', marginTop: 18},
  // The Home overflow menu's rows (the [...] sheet): a full-width tap row, icon + label, with the
  // same 44px+ touch height every list control carries.
  homeMenuRow: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 12, paddingHorizontal: 4},
  homeMenuRowText: {flex: 1, fontSize: 16, fontWeight: '600', color: p.ink, fontFamily: FONT.sansMedium},
  // The menu's context line - WHICH currency the actions act on, under the "More actions" title.
  homeMenuCurrency: {fontSize: 20, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, marginBottom: 6},
  // Convert - the delegated-conversion surface (spec 2026-09-07 §5). The checklist card carries
  // every transparency line on ONE surface before signing; the state panel renders the §4 machine.
  // Left-aligned instruction copy (not centered): these are lines to read closely before money
  // moves, matching the deposit/rail disclosure grammar rather than the celebration grammar.
  convertWrap: {alignSelf: 'stretch', paddingTop: 6, paddingBottom: 20},
  // The swap screen's two currency legs (2026-09-24 redesign): each leg is one row - currency
  // name left, amount right - with its currency-unit balance line beneath, and a hairline
  // divider between sell and receive. The amount input rides the SELL row; the receive figure
  // is the venue's own calculated number, never editable.
  swapLegRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, alignSelf: 'stretch', marginTop: 14},
  swapLegName: {fontSize: 16, color: p.ink, fontFamily: FONT.sansMedium, flexShrink: 1},
  swapLegAmount: {fontSize: 24, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.4, textAlign: 'right', flexShrink: 1, fontVariant: ['tabular-nums']},
  swapLegSub: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, marginTop: 4},
  // The sell leg's inline amount field - the receive leg's amount, typeable: same size and
  // alignment so the two legs read as one shape (founder sketch), no box around it.
  swapLegInput: {flex: 1, minWidth: 0, fontSize: 24, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, textAlign: 'right', letterSpacing: -0.4, padding: 0, outlineWidth: 0, fontVariant: ['tabular-nums']},
  swapDivider: {height: 1, backgroundColor: p.line2, alignSelf: 'stretch', marginTop: 14},
  routeHeaderRow: ROUTE_HEADER_ROW,
  routeHeaderTitle: ROUTE_HEADER_TITLE,
  routeHeaderSpacer: ROUTE_HEADER_SPACER,
  convertAmountLabel: {fontSize: 13, color: p.sub, marginBottom: 8, fontFamily: FONT.sansMedium},
  convertMetaLine: {fontSize: 13, color: p.sub, marginTop: 8, fontFamily: FONT.sans},
  // F4 (2026-09-18 hub UX §e): the balance line + Max affordance share one row.
  convertBalanceRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch'},
  // Convert reads as ONE decision then its terms (2026-09-08): a lifted white headline card
  // carrying what the user actually receives + the rate + the quote's attribution, over a
  // RECESSED panel2 checklist whose every spec-§5 disclosure is still present but visibly
  // secondary. Before this, the rate and the fee lines were the same 14pt ink inside one grey
  // wall, and the received amount had no headline at all.
  convertHeadlineCard: {backgroundColor: p.card, padding: 16, borderRadius: 12, alignSelf: 'stretch', marginTop: 16},
  convertHeadlineLabel: {fontSize: 13, fontWeight: '600', color: p.sub, fontFamily: FONT.sans},
  convertHeadlineAmount: {fontSize: 32, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5, marginTop: 8, fontVariant: ['tabular-nums']},
  // STACKED (label line, then the figure on its own line): the census's one hairline-topped
  // row. The side-by-side layout squeezed the label into '… (ICP → / VCHF)' and the money into
  // '1.74… / VCHF' at 390px - both halves wrapping mid-token (measured 2026-09-28). Stacked,
  // the label and the figure each keep one whole line at every locale length.
  convertRateRow: {alignSelf: 'stretch', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: p.line2, gap: 4},
  convertRateLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans},
  convertRateValue: {fontSize: 16, color: p.ink, fontFamily: FONT.sansMedium, flexShrink: 0, textAlign: 'right'},
  convertHeadlineMeta: {fontSize: 12, color: p.sub2, fontFamily: FONT.sans, marginTop: 8},
  convertChecklistCard: {backgroundColor: p.panel2, padding: 16, borderRadius: 12, alignSelf: 'stretch', marginTop: 12},
  // The ONE Details disclosure control on the convert decision card (10x-verbosity pass
  // 2026-09-16): quiet meta-line styling - it opens the census, it is not a CTA.
  convertDetailsToggle: {flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 12, minHeight: 44, justifyContent: 'center'},
  convertDetailsToggleText: {fontSize: 13, color: p.sub, fontFamily: FONT.sans},
  convertDetailsChevronOpen: {transform: [{rotate: '180deg'}]},
  convertChecklistLine: {fontSize: 13, color: p.sub, lineHeight: 20, marginBottom: 8, fontFamily: FONT.sans},
  // The stateful leg checklist's panel-family twins (2026-10-04): done recedes, the active
  // row is the one emphasized row, pending rows stay muted. Tokens only.
  convertChecklistLineDone: {fontSize: 13, color: p.sub2, lineHeight: 20, marginBottom: 8, fontFamily: FONT.sans},
  convertChecklistLineActive: {fontSize: 13, color: p.ink, lineHeight: 20, marginBottom: 8, fontFamily: FONT.sansMedium},
  convertChecklistLinePending: {fontSize: 13, color: p.sub2, lineHeight: 20, marginBottom: 8, fontFamily: FONT.sans},
  convertChecklistWarn: {fontSize: 13, color: p.bad, lineHeight: 20, marginBottom: 8, fontFamily: FONT.sansMedium},
  // The pool principal on its own line: 27 hyphenated characters inside a paragraph wrap
  // mid-token (browsers break at '-'), so it gets the receipt voice and a line of its own.
  convertPrincipal: {fontSize: 12, color: p.ink, lineHeight: 18, marginBottom: 8, fontFamily: FONT.mono},
  // The cross-rail handoff's calldata box: a full EVM payload (~388 bytes of hex) the user
  // pastes into their OWN wallet verbatim - receipt voice, wrapped, selectable, boxed so it
  // reads as one copyable artifact rather than prose.
  convertCalldata: {fontSize: 11, color: p.ink, lineHeight: 16, fontFamily: FONT.mono, backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line2, borderRadius: 8, padding: 12, marginBottom: 8, flexWrap: 'wrap'},
  convertSlippageLabel: {fontSize: 13, fontWeight: '600', color: p.sub, fontFamily: FONT.sans, marginBottom: 8},
  // Same section-heading shape as the slippage label, plus top spacing: the balance/Max row
  // sits directly above the DESTINATION heading and collapsed against it (2026-09-20 shot).
  convertDestLabel: {fontSize: 13, fontWeight: '600', color: p.sub, fontFamily: FONT.sans, marginTop: 16, marginBottom: 8},
  // Currency-section header inside the destination picker (groupDestSections render): a quiet
  // label naming the destination currency - a section is a label, never a total. Same voice as
  // the accounts route's group headers (13/sans/sub), so both lists read one system.
  convertDestGroupLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, marginTop: 12, marginBottom: 4},
  // The minimum is a term, but it is the term that bounds the trade - one weight above its siblings.
  convertMinOutLine: {fontSize: 16, color: p.ink, lineHeight: 22, marginBottom: 8, fontFamily: FONT.sansMedium},
  convertSlippageRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap'},
  convertSlippageChip: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: p.line2, backgroundColor: p.field, minHeight: 44},
  convertSlippageChipOn: {borderColor: p.brand, backgroundColor: p.brand},
  convertSlippageChipText: {fontSize: 13, color: p.ink, fontFamily: FONT.sansMedium},
  convertSlippageChipTextOn: {color: p.brandInk},
  // The venue chooser (multi-venue readiness V5): one row per venue, registry order. Row = a
  // small lifted card (the headline card's grammar) so N venues read as N parallel offers, the
  // picked one inked by the brand border. Nothing about the row encodes rank - same shape,
  // same order, every render; rows are never sorted by what they quote. The row lays out
  // HORIZONTALLY (radio circle + the text column) - the flexDirection lives here, not at the
  // call site, so every venue row shares one geometry.
  convertVenueRow: {backgroundColor: p.card, borderWidth: 1, borderColor: p.line2, borderRadius: 8, padding: 12, marginTop: 8, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start'},
  convertVenueRowOn: {borderColor: p.brand},
  // The selection affordance (2026-09-11): an unchecked/checked radio circle - border colour
  // alone did not read as tappable or as chosen. Unchecked = a quiet outlined ring; checked =
  // brand-inked ring + solid dot. Decorative geometry only; the row's Pressable carries the
  // accessibility role/state, so nothing here needs testIDs of its own.
  convertVenueRadio: {width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: p.line2, marginTop: 1, marginRight: 10, alignItems: 'center', justifyContent: 'center'},
  convertVenueRadioOn: {borderColor: p.brand},
  convertVenueRadioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: p.brand},
  convertMechGroup: {marginTop: 4, marginLeft: 22, alignSelf: 'stretch'},
  convertVenueRowText: {flex: 1},
  convertVenueName: {fontSize: 16, color: p.ink, fontFamily: FONT.sansMedium},
  convertVenueNameOn: {fontFamily: FONT.sansBold},
  convertVenueAmount: {fontSize: 14, color: p.sub, lineHeight: 20, marginTop: 4, fontFamily: FONT.sans, fontVariant: ['tabular-nums']},
  convertBtnBusyRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  convertUnavailableTitle: {fontSize: 20, color: p.ink, fontFamily: FONT.sansBold, marginBottom: 8},
  convertUnavailableBody: {fontSize: 16, color: p.sub, lineHeight: 22, marginBottom: 8, fontFamily: FONT.sans},
  convertStateTitle: {fontSize: 20, color: p.ink, fontFamily: FONT.sansBold, marginBottom: 8, marginTop: 8},
  convertStateBody: {fontSize: 16, color: p.sub, lineHeight: 22, marginBottom: 8, fontFamily: FONT.sans},
  convertStateMeta: {fontSize: 13, color: p.sub, lineHeight: 18, marginBottom: 8, fontFamily: FONT.sans},
  convertFooting: {alignItems: 'center', marginTop: 18},
  // Mode toggle - a joined two-segment pill control at the top of the Pay/Receive tab bodies:
  // `[ Scan to pay | Send to address ]` (Pay) and `[ Request payment | My address ]` (Receive).
  // Inset well (panel2) + white active segment + ink text: the editorial segmented control,
  // deliberately quieter than the filled tabs so nav stays the loudest level.
  // `railRow` is the joined container; `railPill` is each half-width segment.
  railRow: {flexDirection: 'row', gap: 4, marginTop: 2, marginBottom: 14, backgroundColor: p.panel2, borderRadius: 8, padding: 4, alignSelf: 'stretch', borderWidth: 1, borderColor: p.line2},
  railPill: {flex: 1, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 4, alignItems: 'center', justifyContent: 'center', minHeight: 40},
  railPillActive: {backgroundColor: p.card},
  railPillText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  railPillTextActive: {color: p.ink, fontFamily: FONT.sansBold},
  // Body - content flows from the top; the asset rail follows naturally.
  body: {flexGrow: 1, paddingHorizontal: 16, paddingTop: 10, justifyContent: 'flex-start'},
  // Mode surface for a MOMENT - a phase the user reads and reacts to rather than fills in
  // (scan/review/paid/result, an NFC takeover, a dead end that explains itself). Grows to fill the
  // space between the tabs and the asset rail and VERTICALLY centers its content, so a sparse phase
  // does not pack itself at the top and leave a dead zone below. `flexShrink:0` keeps tall content
  // from being clipped: when a phase's content exceeds the free space it grows the surface (and the
  // parent ScrollView scrolls) instead of being squashed.
  center: {...MODE_SURFACE, justifyContent: 'center'},
  // Mode surface for a FORM - a phase the user works down: amount, destination, memo, submit; and
  // the address/instruction sheets read the same way. Identical to `center` except that content
  // starts at the top, because centring a form parks it in the middle of the screen with a dead
  // band above AND below it (measured on the ordinary Receive form: 121 px dead above, 119 below,
  // 388 px of content in a 628 px box) and moves every field the moment one line of copy wraps.
  centerTop: MODE_SURFACE,
  label: {fontSize: 16, color: p.sub, marginBottom: 8, textAlign: 'center', fontFamily: FONT.sans},
  // The create form's username label. `label` read as a run-on tail of the trust paragraph above
  // it (`dim2` - same centered secondary ink, no gap), so this label gets the section-label
  // grammar (13px sans over `sub2`, the `histTitle` voice) plus its own top margin: the
  // paragraph ends where it ends and the field's name starts a NEW block. `sub2` is an approved
  // page ink (contrast gate), so the swap is AA-safe in both themes.
  onboardFieldLabel: {fontSize: 13, fontWeight: '600', color: p.sub2, textAlign: 'center', marginTop: 26, marginBottom: 10, fontFamily: FONT.sans},
  err: {color: p.bad, fontSize: 14, textAlign: 'center', marginTop: 10, fontFamily: FONT.sansMedium},
  // A failed leg state INSIDE a checklist keeps the list's left alignment - S.err centers,
  // which is right for standalone form errors and wrong inside the leg list (2026-09-20).
  convertLegStateBad: {color: p.bad},
  convertLegStateDone: {color: p.sub2},
  // TRANSIENT dimming - a busy button while its spinner runs, and the header account block while
  // a payment holds it locked. NOT the disabled-button state (that is `disabledFlat` +
  // `disabledText`, which swaps the fill instead of fading it; see the note there).
  //
  // 0.8, not the old 0.55: opacity fades the ink toward the page, so the header's own eyebrow
  // measured 2.58:1 in light and 3.60:1 in dark while a payment was on screen - the one moment
  // the user most wants to re-read which account is paying. At 0.8 it reads 4.51 / 6.30 and the
  // block still visibly recedes.
  dim: {opacity: 0.8},
  // The DISABLED state of a BUTTON. It is a fill swap, never a fade, and that is a measurement
  // rather than a taste: opacity fades a fill toward the page, and it fades the LABEL toward the
  // page at the same rate - so the label is what disappears first. Measured on the real screens:
  // white-on-tangerine at 0.4 gives 2.00:1 in light, and after v5 flipped `brandInk` to the warm
  // near-black it gives 1.77:1 in dark (the v4 dark reading was 9.84 only because a WHITE label
  // happened to be the opposite polarity to the night page - the light theme was already broken
  // at 1.62:1). A disabled control is WCAG-exempt, but a button whose label cannot be read is not
  // a design: the user has to be able to see what the thing they cannot press would do.
  //
  // So the disabled button becomes an inert well - `panel2` fill, hairline, no lift - and carries
  // `disabledText`, which measures 5.19:1 (light) and 5.26:1 (dark) on it. It recedes MORE than
  // the faded version did while staying legible. `disabledText` must be applied to the label at
  // every site that applies this: the pair is what makes the state readable, and the contrast gate
  // asserts the pairing. Non-button chrome (the header during a payment) keeps `dim`.
  disabledFlat: {backgroundColor: p.panel2, borderWidth: 1, borderColor: p.line, elevation: 0, shadowOpacity: 0},
  disabledText: {color: p.sub2},
  dim2: {fontSize: 13, color: p.sub, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  // Camera viewfinder - fills the content column (`alignSelf:'stretch'` overrides the parent's
  // centering; `aspectRatio:1` keeps it square). A WARM-black frame: the viewport into the world
  // stays dark by nature and deliberately unthemed. The #17150F fill
  // is DELIBERATELY theme-invariant (identical in light + dark) - the campreview pixel gate
  // (just campreview) keys on it; do NOT palette-ize.
  camBox: {alignSelf: 'stretch', aspectRatio: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#17150F', borderWidth: 1, borderColor: p.line, ...LIFT},
  // Copy that sits ON the camera box - the pre-permission prompt and the no-camera fallback.
  //
  // X17: this text used `S.reviewTo` / `S.dim2`, whose colour is `p.sub` - a secondary ink for a
  // PAGE. On the theme-invariant warm-black fill above it measures 1.9:1 (`LIGHT.sub` on
  // `#17150F`), against the 4.5:1 WCAG AA needs. Those tokens are correct where they were designed
  // to live and wrong here, and nothing in a page-tinted token could ever have made them right.
  //
  // The fix is a token that knows what it sits on. `camBox` is deliberately theme-invariant (the
  // `just campreview` pixel gate keys on that fill), so its ink is theme-invariant too - and the
  // DARK palette's own inks ARE the on-warm-black inks by construction, so they are READ FROM
  // `DARK` rather than re-entered as literals that could drift from it. Measured against
  // `#17150F`: `DARK.ink` 15.8:1, `DARK.sub` 7.1:1 - AAA on both, in either theme.
  camText: {fontSize: 16, color: DARK.ink, marginTop: 8, textAlign: 'center', lineHeight: 22, fontFamily: FONT.sansMedium},
  camSubText: {fontSize: 13, color: DARK.sub, marginTop: 8, textAlign: 'center', fontFamily: FONT.sans},
  // Wrapper for a scan phase's QrScanner + hint text. MUST be alignSelf:'stretch' (full width):
  // camBox sizes itself by stretch + aspectRatio, so an unstyled/content-width wrapper leaves camBox
  // with no resolvable width and it collapses to 0x0 (the 2026-08-14 SOL scan black-box bug -
  // camera mounted and live but invisible; gated on-device by `just campreview`).
  scanWrap: {alignSelf: 'stretch'},
  // The IC scan-phase container (`pay-scan`): stretches to the column, then repeats the mode
  // surface's centering for its own children - the phase lays out exactly as when they sat
  // directly under S.center, but the carrier is now the phase itself, not the NFC row inside it.
  scanPhase: {alignSelf: 'stretch', alignItems: 'center'},
  // The placeholder fills the box; 24px keeps wrapped copy off the rounded edge (the armed
  // pre-permission screen is the same instrument as idle - text that touches the frame is the
  // "almost-aligned" tell the caliber exists to kill).
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  // ── The scan viewfinder brackets (CALIBER slice 1) ────────────────────────────────────────
  // Four 2px corner brackets that overlay the LIVE camera box (`QrScanner` paints them last, over
  // the absoluteFill feed, so the box reads as one instrument through permission, camera and
  // rail). Geometry, not color: sanctioned on-warm-black inks with the ONE aqua accent
  // (DARK.brandText, ≈10:1 on the theme-invariant warm-black fill - contrast-gated approval).
  viewfinderCorner: {position: 'absolute', width: 20, height: 20, borderColor: DARK.brandText},
  viewfinderCornerTL: {top: 12, left: 12, borderTopWidth: 2, borderLeftWidth: 2},
  viewfinderCornerTR: {top: 12, right: 12, borderTopWidth: 2, borderRightWidth: 2},
  viewfinderCornerBL: {bottom: 12, left: 12, borderBottomWidth: 2, borderLeftWidth: 2},
  viewfinderCornerBR: {bottom: 12, right: 12, borderBottomWidth: 2, borderRightWidth: 2},
  reviewAmount: {fontSize: 32, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums']},
  reviewTo: {fontSize: 16, color: p.sub, marginTop: 8, textAlign: 'center', fontFamily: FONT.sansMedium},
  warnNote: {fontSize: 13, color: p.warn, textAlign: 'center', marginTop: 6, marginBottom: 18, paddingHorizontal: 8, lineHeight: 18, fontFamily: FONT.sans},
  // Icon-led warning row: IconAlert + text where a warning previously LED with a '⚠' text
  // glyph. Mirrors warnNote's sizing/margins in row form; the icon tops the first line so a
  // wrapped body doesn't drag it off-center.
  warnRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6, marginBottom: 18, paddingHorizontal: 8},
  warnRowText: {flex: 1, fontSize: 13, color: p.warn, lineHeight: 18, fontFamily: FONT.sans},
  // Primary action button - stretched full-width, petrol fill, the ONE LIFT shadow (brief
  // §3.3). Row layout + gap so a leading icon sits inline. `primaryWide` is the same chrome
  // (kept for the Receive Request button).
  primary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: p.brand, borderRadius: 8, height: 56, alignSelf: 'stretch', paddingHorizontal: 24, marginTop: 14, ...LIFT},
  primaryWide: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: p.brand, borderRadius: 8, height: 56, alignSelf: 'stretch', marginTop: 14, ...LIFT},
  primaryText: {color: p.brandInk, fontSize: 18, fontWeight: '700', fontFamily: FONT.sansBold},
  qrCard: {backgroundColor: LIGHT.card, padding: 20, borderRadius: 12, marginBottom: 14},
  amountBig: {fontSize: 32, fontWeight: '700', color: p.ink, textAlign: 'center', fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums']},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: p.ok, backgroundColor: withAlpha(p.ok, p.wash), paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, overflow: 'hidden', fontFamily: FONT.sansMedium},
  qrHint: {marginTop: 12, fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.sans},
  // Request-QR validity countdown (the signed request expires after EXPIRY_WINDOW; a stale QR scans
  // to a confusing rejection, so the merchant is told how long it's good for).
  qrExpiry: {marginTop: 6, fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.sans},
  qrExpiryWarn: {marginTop: 6, fontSize: 14, fontWeight: '600', color: p.warn, textAlign: 'center', fontFamily: FONT.sansMedium},
  qrExpired: {marginTop: 6, fontSize: 14, fontWeight: '700', color: p.warn, textAlign: 'center', fontFamily: FONT.sansBold},
  // An inline offline-status pill on the Receive-QR screen - so a merchant staring at "Waiting
  // for payment…" knows they won't see incoming payments until reconnected. Soft bad-tinted pill
  // - informational, not a hard error (the wait state is still valid; the poll reconciles).
  qrOfflinePill: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: withAlpha(p.bad, p.wash), borderWidth: 1, borderColor: withAlpha(p.bad, 0.28)},
  qrOfflinePillText: {fontSize: 12, fontWeight: '600', color: p.bad, fontFamily: FONT.sansMedium},
  // Wraps when a locale's label pair outgrows the row (de/es "handed to merchant" + Cancel ran
  // ~14-51px past the right edge at 390px): the Cancel button flows to a second line instead of
  // off-screen. en/fr never reach the wrap at current widths, so they render pixel-identical.
  confirmRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: p.ok, borderRadius: 8, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center'},
  paidBtnText: {color: p.brandInk, fontWeight: '700', fontSize: 16, fontFamily: FONT.sansBold},
  notPaidBtn: {backgroundColor: p.card, borderRadius: 8, paddingVertical: 13, paddingHorizontal: 24, minHeight: 44, justifyContent: 'center', alignItems: 'center'},
  notPaidText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: p.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18},
  checkAlready: {backgroundColor: p.warn, shadowColor: p.warn},
  paidText: {fontSize: 32, fontWeight: '700', color: p.ok, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums']},
  alreadyText: {color: p.warn},
  paidSub: {fontSize: 16, color: p.sub, marginTop: 6, fontFamily: FONT.sans},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: p.field, borderRadius: 8, paddingHorizontal: 16, minHeight: 56, alignSelf: 'stretch', borderWidth: 1, borderColor: p.line2},
  currency: {fontSize: 32, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums']},
  // `minWidth: 0` is a NO-OP on Yoga (RN's default) and a FIX on react-native-web: a CSS flex item
  // defaults to `min-width: auto`, so an `<input>`'s intrinsic ~20-character width (414px at 34pt)
  // wins over `flex: 1` and pushes the whole app column 41px wider than the viewport. Invisible
  // until the field is focused - then the browser scrolls the column sideways and the money screen
  // renders with its left edge cut off (measured on Convert, 2026-09-08; every amount row shares
  // this style, so every one of them had it).
  amountInput: {flex: 1, minWidth: 0, fontSize: 32, fontWeight: '700', color: p.ink, marginLeft: 6, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums']},
  // The amount inputs' size steps (2026-10-02 founder defect: a long amount overflowed the
  // fixed-height convert field - horizontal overflow plus a vertically clipped glyph box).
  // Android's TextInput has no reliable adjustFontSizeToFit, so `amountFontFor` below picks
  // among these three tokens by the TYPED LENGTH. Same family as amountInput (weight, face,
  // tabular figures, color) - only the size steps down.
  amountFontLg: {fontSize: 32, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums'], flex: 1, minWidth: 0, marginLeft: 6},
  amountFontMd: {fontSize: 24, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums'], flex: 1, minWidth: 0, marginLeft: 6},
  amountFontSm: {fontSize: 18, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.5, fontVariant: ['tabular-nums'], flex: 1, minWidth: 0, marginLeft: 6},
  // Long opaque strings (EVM addresses, tx hashes) - no display-sized font can hold 42+ hex
  // chars on one line, so these render at body size in the mono face instead. Same overflow
  // guard as amountInput (flex:1 + minWidth:0; measured clipping at 34px, 2026-09-20).
  monoInput: {flex: 1, minWidth: 0, fontSize: 15, color: p.ink, marginLeft: 6, fontFamily: FONT.mono, paddingVertical: 10},
  // Tappable amount-prefix (Receive): wraps the currency glyph + chevron that signals it opens the
  // currency picker. The right border separates it from the typed amount.
  prefixBtn: {flexDirection: 'row', alignItems: 'center', paddingRight: 12, borderRightWidth: 1, borderRightColor: p.line2},
  linkBtn: {marginTop: 18, minHeight: 44, justifyContent: 'center'},
  linkText: {color: p.brandText, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  linkTextMuted: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  // Icon+label row inside a `linkBtn` Pressable (Settings' Privacy policy carries the
  // external-link glyph). The Pressable keeps the column linkBtn chrome (44pt target); this row
  // lays a small icon against the label with a hairline gap.
  linkRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  // Ghost button tier - the affordance rule (every action = a button) for the Pay/Receive action
  // rows that were bare text links. A white pill with a leading icon: clearly tappable, but
  // neutral chrome so the brand fill stays reserved for the primary CTA. `ghostBtnMuted` is the
  // quieter variant for flow-reset actions ("New request"/"New payment"/"Back") - transparent
  // bg. Same 44pt min + marginTop rhythm as linkBtn, which it replaces there.
  ghostBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 18, minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, backgroundColor: p.card},
  ghostBtnText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  ghostBtnMuted: {backgroundColor: 'transparent'},
  // SendTerminal's stacked secondary actions (Check status / View receipt): full-width so every
  // action on the terminal shares ONE column and one height - the primary copy button above and
  // the Done ghost below are the anchors, these two never render at mixed widths.
  termBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, alignSelf: 'stretch', marginTop: 10, minHeight: 44, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8, backgroundColor: p.card},
  termBtnText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  smallBtn: {backgroundColor: p.brand, borderRadius: 8, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center'},
  smallBtnText: {color: p.brandInk, fontWeight: '700', fontFamily: FONT.sansBold},
  // Secondary button (Cancel/secondary action parity with the primary). Card fill + 16 radius,
  // 52 tall beside a 56 input/CTA per the shape system; clearly secondary but unambiguously
  // tappable.
  secondaryBtn: {alignSelf: 'stretch', height: 52, borderRadius: 8, marginTop: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.card, minHeight: 44},
  secondaryBtnText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  histTitle: {fontSize: 13, fontWeight: '600', color: p.sub2, marginBottom: 8, fontFamily: FONT.sans},
  // ── The transaction RECEIPT (X6, components/HistoryRow.tsx#TxnReceipt) ───────────────────────
  // The merchant-reconciliation and dispute surface, rendered in the centered-card idiom the
  // pay-link refusal already uses (S.pickBackdrop + S.pickCard). The headline is the EXACT amount;
  // beneath it every field is a label over its own full-width value line, because the values here
  // are a 63-character IC principal, a 32-byte hex reference and a base58 signature - a
  // right-aligned value column (S.reviewRow) wraps all three into a ragged block that cannot be
  // compared character by character, which is the one thing a payee does with them.
  receiptAmount: {fontSize: 24, fontWeight: '700', fontFamily: FONT.sansBold, letterSpacing: -0.4, marginTop: 4, fontVariant: ['tabular-nums']},
  receiptAsset: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, marginTop: 2, marginBottom: 6},
  receiptField: {alignSelf: 'stretch', marginTop: 12},
  receiptLabel: {fontSize: 13, fontWeight: '600', color: p.sub2, fontFamily: FONT.sans, marginBottom: 4},
  receiptValue: {fontSize: 13, color: p.ink, lineHeight: 18, fontFamily: FONT.mono},
  // The non-opaque value voice: same scale, sans — the receipt's mono is for strings a payee
  // checks character by character (principals, hashes), never for times, fees or amounts.
  receiptValueSans: {fontSize: 13, color: p.ink, lineHeight: 18, fontFamily: FONT.sans, fontVariant: ['tabular-nums']},
  // An honest ABSENCE (or a failed-transaction status) reads as prose, never as a value: the
  // receipt must not let "the ledger recorded no account" look like something copied off a chain.
  receiptNote: {fontSize: 13, color: p.sub, lineHeight: 18, fontFamily: FONT.sans},
  receiptSource: {fontSize: 12, color: p.sub2, lineHeight: 17, fontFamily: FONT.sans, marginTop: 16},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.line2},
  histWhoCol: {flex: 1},
  histWho: {fontSize: 16, color: p.ink, fontFamily: FONT.sansMedium},
  // The row's SECOND line - the timestamp, and the memo beside it when there is one. Both live in
  // the flexible left column, which is what pins the amount: see `histAmt`.
  histSubRow: {flexDirection: 'row', alignItems: 'baseline', marginTop: 4},
  histMemo: {fontSize: 12, color: p.sub2, fontStyle: 'italic', fontFamily: FONT.sans, marginLeft: 6, flexShrink: 1},
  // The fee annotation beside the memo (founder rule 2026-09-14: fees ride the log row ONLY as
  // this line - "0.0001 VCHF fees" - never inside the headline amount). Not italic: it is a
  // money figure, not display prose.
  histFee: {fontSize: 12, color: p.sub2, fontFamily: FONT.sans, marginLeft: 6, flexShrink: 1, fontVariant: ['tabular-nums']},
  // The amount is the LAST item on the row, and that is a correctness rule rather than a taste one.
  // The timestamp is the only element here whose width changes on its own - `fmtTime`'s clock crosses
  // 1↔2 hour digits every day at ten o'clock, one monospace character, 7.2 px. While the time sat to
  // the RIGHT of the amount, that character pushed the amount 7.2 px sideways every time the hour
  // rolled over (measured), which misaligns a column of money for the user and, for the pixel-diff
  // gate (flows 40/84), was a ~0.15%-per-row drift the ledger baseline could fail on with no code
  // change behind it. With the time in the flexible column the amount's right edge is the row's, so
  // amounts line up down the list and nothing the clock does can move them.
  histAmt: {fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold, fontVariant: ['tabular-nums']},
  histTime: {fontSize: 12, color: p.sub2, fontFamily: FONT.sans},
  // Leading direction glyph on each Ledger row (IconArrowDownLeft in / IconArrowUpRight out;
  // t.dir is the reliable 'out' | 'in' field on Txn). alignSelf:center overrides the row's
  // baseline alignment - an Svg has no text baseline to align to.
  histDirIcon: {marginRight: 8, alignSelf: 'center'},
  // The pending-row marker (2026-09-15 offline outbox): the warn-tinted clock BESIDE the amount.
  // alignSelf:center for the same no-text-baseline reason as the direction glyph; the amount's
  // right edge stays pinned by the row, so the pixel-diff ledger baseline is unmoved.
  histPendingMark: {marginRight: 6, alignSelf: 'center'},
  // Ledger page - the transaction list promoted to its own tab. `ledgerWrap` is the page-level
  // container; `ledgerEmpty` is the muted centered placeholder for a wallet with no transactions.
  ledgerWrap: {marginTop: 4},
  ledgerEmpty: {fontSize: 16, color: p.sub, textAlign: 'center', marginTop: 40, fontFamily: FONT.sans},
  // Asset filter chip row - only renders when >1 currency is present in history. Active chip
  // fills with brand so the selected filter reads as the obvious current view.
  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12},
  filterChip: {paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, backgroundColor: p.card, minHeight: 44},
  filterChipActive: {backgroundColor: p.brand, borderColor: p.brand},
  filterChipText: {color: p.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  filterChipTextActive: {color: p.brandInk, fontFamily: FONT.sansBold},
  // Asset card. White card, borderless (surface step separates it from the page); selection is
  // a 1px `brandText` ring (brief §IV: no left stripe), so the selected card pops. DENSE
  // (founder 2026-10-05): the currency list is a balance sheet, not a card wall - 8px vertical
  // padding, 6px between rows, and the row lands at ~52dp (tap target stays >= 40dp).
  assetCard: {marginTop: 6, alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: 'transparent', borderLeftColor: 'transparent', borderLeftWidth: 1},
  assetCardActive: {borderColor: p.brandText, borderLeftColor: p.brandText},
  assetRow: {flexDirection: 'row', alignItems: 'center'},
  // assetSelect - the glyph-led row inside a card: the 26px AssetGlyph chip against the text
  // column, vertically CENTERED (a monogram chip reads correctly centered against the one-line
  // column).
  assetSelect: {flex: 1, flexDirection: 'row', alignItems: 'center'},
  assetSelectBlock: {flex: 1},
  // assetTitleRow - the name + trailing amount/check line at the top of a card row's text column.
  // The label's flex:1 pushes the amount to the right edge; the check trails the amount.
  assetTitleRow: {flexDirection: 'row', alignItems: 'center'},
  assetLabel: {flex: 1, fontSize: 15, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  // flexShrink 0: the amount is the money column - it wraps never (the name column flexes
  // instead); measured '1.9998\nICP' on the Accounts ICP row, 2026-09-28.
  assetAmt: {fontSize: 15, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, marginLeft: 6, flexShrink: 0, fontVariant: ['tabular-nums']},
  assetSub: {fontSize: 11, color: p.sub2, marginTop: 2, fontFamily: FONT.sans},
  // Rail-detail panel - the chooser's inline per-rail expansion (EUR dual-rail, Stage 5). An
  // inset WELL inside the asset card (panel2 + line border, per brief §IV), so the detail reads
  // as drilling into the card rather than as a second card. Rows are glyph-led like assetSelect but top-aligned:
  // the detail rows carry 3-5 wrapped fact lines, and a centered glyph against that would float.
  railDetailPanel: {marginTop: 10, alignSelf: 'stretch', backgroundColor: p.panel2, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: p.line2},
  railDetailRow: {flexDirection: 'row', alignItems: 'flex-start', marginTop: 8},
  railDetailCol: {flex: 1, marginLeft: 10},
  railDetailLine: {fontSize: 12, color: p.sub2, marginTop: 2, lineHeight: 17, fontFamily: FONT.sans},
  // Chain tag pill - the settlement chain's proper noun, sentence-case sans, pill-shaped.
  // Overflow hidden keeps the pill's radius honest if a future chain name runs long.
  railChainTag: {paddingVertical: 2, paddingHorizontal: 8, borderRadius: 4, backgroundColor: p.panel2, fontSize: 12, fontWeight: '600', color: p.sub2, fontFamily: FONT.sans, overflow: 'hidden', marginLeft: 8, alignSelf: 'center'},
  // Rail-health note (RailLiquidityNote warn tone) - the warnRow idiom scaled to a sub-line:
  // flex-start so the alert icon anchors the FIRST line of wrapped text, warn colour throughout.
  railHealthRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 4},
  railHealthText: {flex: 1, fontSize: 12, color: p.warn, lineHeight: 17, fontFamily: FONT.sans},
  // The NETWORK-level outage banner (X9) - the same warn-row idiom as railHealthRow, but it sits
  // BETWEEN cards rather than inside one, so it carries the list's own horizontal rhythm and a
  // little air above the row it introduces.
  railOutageRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 16, marginBottom: 2, paddingHorizontal: 2},
  // The row's action slot. A COLUMN, not a row: the selected row can carry a pill (DEMO's
  // faucet; the per-row Convert pills are GONE - founder 2026-10-05 - and this slot is the
  // practice row's alone). Stacking is deterministic at any pill count.
  assetActions: {flexDirection: 'column', alignItems: 'flex-end', gap: 8, marginLeft: 8},
  assetActionBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, minHeight: 44, backgroundColor: p.card},
  assetActionText: {color: p.sub, fontWeight: '600', fontSize: 13, fontFamily: FONT.sansMedium},
  assetCardZero: {color: p.sub2},
  // AssetGlyph monogram chips (AssetGlyph.tsx) - family-hued rounded squares carrying the native
  // symbol ($ ₿ ◊ • ∂). Size comes in via inline style (width/height/radius/fontSize scale
  // together); the base classes only pin the shared chrome (center, subtle ring) so chips stay
  // crisp at any size. Ring is warm-ink (light theme).
  assetGlyph: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.glyphBorder},
  assetGlyphLg: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.glyphBorderLg},
  assetGlyphText: {fontWeight: '700', fontFamily: FONT.sansBold},
  settingsSection: {alignSelf: 'stretch', marginBottom: 28},
  relayInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 8, minHeight: 56, paddingHorizontal: 16, fontSize: 15, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  // Advanced relay section - the relay edit is demoted below consumer settings and applied
  // EXPLICITLY via the Apply button (no live retarget on each keystroke). `advancedLabel` is the
  // sentence-case section label shared with the other section headers; `applyBtn` is the
  // sheet's primary CTA chrome.
  advancedLabel: {fontSize: 13, fontWeight: '600', color: p.sub2, alignSelf: 'flex-start', marginBottom: 0, fontFamily: FONT.sans},
  // The Advanced disclosure toggle (Settings → Server). The header is itself a Pressable
  // spanning the row (label + caret) so the whole header is the tap target. `advancedLabel`'s
  // bottom margin is zeroed above so the toggle controls its own vertical rhythm.
  advancedToggle: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingVertical: 10, marginBottom: 4, minHeight: 44},
  // The caret wrapper only needs a style when COLLAPSED (rotate −90° so the chevron points
  // right; expanded = the icon's natural down).
  advancedCaretClosed: {transform: [{rotate: '-90deg'}]},
  applyBtn: {backgroundColor: p.brand, borderRadius: 8, height: 56, minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 16, ...LIFT},
  applyBtnText: {color: p.brandInk, fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold},
  // `applyBtnDisabled` is GONE - it was a byte-copy of `disabledFlat` under a second name, and a
  // second name for one state is a second place for it to drift. Settings' Apply now uses the pair
  // every other disabled button uses.
  resetConfirmBox: {alignSelf: 'stretch', backgroundColor: withAlpha(p.bad, p.wash), borderRadius: 12, padding: 16, borderWidth: 1, borderColor: withAlpha(p.bad, 0.25)},
  // Reset entry-point - a bordered red-outline button "Reset wallet…" with the ellipsis
  // signaling "opens a dialog". Distinct from the muted "Privacy policy" link above it, but NOT
  // a loud filled-red button (the destructive gate stays in the confirmation dialog).
  resetEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(p.bad, 0.45), backgroundColor: withAlpha(p.bad, p.wash), alignItems: 'center', justifyContent: 'center'},
  resetEntryText: {color: p.bad, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  // Backup affordance (Settings → Backup). Mirrors `resetEntryBtn`'s shape but BRAND-tinted so it
  // reads as a safe, recommended action. `backupConfirmBox` is the neutral caution box;
  // `seedBox` is the revealed seed display: mono, padded, inset well so it reads as a discrete
  // selectable token block.
  backupEntryBtn: {alignSelf: 'stretch', marginTop: 14, minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(p.brandText, 0.45), backgroundColor: withAlpha(p.brandText, p.wash), alignItems: 'center', justifyContent: 'center'},
  backupEntryText: {color: p.brandText, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  backupConfirmBox: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: p.line2},
  seedBox: {alignSelf: 'stretch', backgroundColor: p.panel2, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: p.line2, marginTop: 4},
  seedText: {color: p.ink, fontFamily: FONT.mono, fontSize: 14, lineHeight: 20},
  // Numbered BIP-39 word grid (SeedWords.tsx) - three columns, ROW-MAJOR (1-2-3 across, 4-5-6
  // across, …) chunked into 1-12 / 13-24 blocks by a hairline rule under the 4th row; the scan
  // direction IS the transcription order, and the compact metrics keep all 24 words + the
  // confirm CTA above the fold at 390×844 (UX hardening 2026-08-23, round-2 audit - was
  // column-major (i, i+12) pairs, whose fold cut made 9-12 look missing). `seedGrid` is the
  // stretch container; `flex:1` on the chip keeps the three columns equal-width. The chip View
  // carries the mnemonic-word-N testID and e2e reads its textContent with the leading index
  // stripped - the index Text must stay FIRST inside the chip. `seedChipIdx` has a fixed width +
  // right-align so the words of a column start at the same x. BIP-39 words are ≤8 chars.
  seedGrid: {alignSelf: 'stretch', gap: 5, marginTop: 4, marginBottom: 8},
  seedGridRow: {flexDirection: 'row', gap: 5},
  seedGridRule: {height: 1, backgroundColor: p.line, marginVertical: 3},
  seedChip: {flex: 1, flexDirection: 'row', alignItems: 'baseline', backgroundColor: p.card, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5, borderWidth: 1, borderColor: p.line2},
  seedChipIdx: {color: p.sub2, fontFamily: FONT.sans, fontSize: 10, marginRight: 4, width: 14, textAlign: 'right'},
  seedChipWord: {color: p.ink, fontFamily: FONT.mono, fontSize: 13},
  // Keyboard-shortcut hint badge (web only - rendered by HotkeyHint). A visible "key cap": a
  // rounded square with a real border + subtle background and a mono letter. `kbdHint` is the
  // light-on-porcelain variant; `kbdHintOnBrand` flips to a white-on-tangerine variant for badges
  // that sit on the filled brand surface (active tab).
  kbdHint: {minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1, borderColor: p.line, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  kbdHintText: {fontSize: 13, fontWeight: '600', color: p.sub, fontFamily: FONT.mono},
  kbdHintOnBrand: {borderColor: withAlpha(p.brandInk, 0.45), backgroundColor: withAlpha(p.ink, 0.14)},
  kbdHintTextOnBrand: {color: p.brandInk},
  // Deposit sheet - a full-screen page overlay above the wallet.
  // elevation is REQUIRED alongside zIndex: on Android, sibling draw order follows elevation
  // FIRST (zIndex only breaks ties within the same elevation). Without it, the elevated active
  // tab (a lift-carrying style) rendered ON TOP of this full-screen sheet -
  // the active Pay/Receive/Transactions button visibly bleeding through the Balances/Settings
  // overlays on device (web/iOS honor zIndex, so e2e never saw it). elevation: 10 matches the
  // zIndex intent; the sheet is full-screen + opaque, so the elevation shadow is clipped
  // off-viewport and invisible.
  sheetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.bg, zIndex: 10, elevation: 10},
  sheet: {flex: 1, backgroundColor: p.bg},
  sheetHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingHorizontal: 20, paddingBottom: 12},
  sheetTitle: {fontSize: 20, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.3},
  sheetClose: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  // A sheet's content column. `alignSelf:'stretch'` for the same reason MODE_SURFACE carries it:
  // every sheet is now rendered INLINE inside a mode surface that centers its children, so an
  // unstretched sheet body is sized to its own content and stops matching the column it sits in.
  // Measured at 390px before this line (all four `alignSelf:auto`): the IC Send-to-address form
  // 424.7px at x=−17.4 (the scan button and the primary button's right radius off-screen), SOL
  // "My address" 396px at x=−3, the SOL send form 4px NARROWER than the column, and only the IC
  // deposit sheet coincidentally correct. Stretching pins all four to the column's 358px.
  sheetBody: {flexGrow: 1, alignSelf: 'stretch', paddingHorizontal: 20, paddingTop: 20, alignItems: 'center'},
  // Same as sheetBody but vertically CENTERS short content so a sheet with few rows doesn't pack
  // at the top with a dead zone below. Used ONLY on sheets whose content is reliably shorter than
  // the viewport - the tall sheets (DepositSheet address flow, WithdrawSheet form) keep top-aligned
  // sheetBody so their long content scrolls without the RN ScrollView + justifyContent:center
  // top-cutoff gotcha.
  // `alignSelf:'stretch'` for the SAME reason `sheetBody` carries it, and that is the whole
  // argument: these two are one surface with one difference - where the content sits vertically.
  // Letting them differ in a SECOND property is precisely the drift that produced the measured
  // overflows the stretch was introduced to kill (the IC send form at 424.7 px in a 358 px column,
  // the cashier checkout-open at 533 px). This one already measured x 16 / w 358 with zero overflow, and
  // it MEASURES THE SAME WITH THE LINE ADDED - checked on both call sites in the running app: the
  // ckERC20 deposit sheet (x 16 / w 358 / right 374 in a 390 px column, nothing off-viewport) and
  // the Settings scroller, where this is a ScrollView contentContainer and `align-self` was already
  // the parent's default. So the line changes nothing on screen; it states the contract the surface
  // always had, at every mount point, instead of only where the parent happens to default to
  // stretch.
  sheetCenter: {flexGrow: 1, alignSelf: 'stretch', justifyContent: 'center', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20, alignItems: 'center'},
  // Compact currency picker (Receive prefix tap): a centered card over a dimmed backdrop (rendered
  // inside a <Modal>, so it covers the whole screen regardless of where ReceiveMode sits in the
  // tree). `pickCard` uses opaque `p.panel` - an alpha wash would composite with the ink veil
  // into mud; the opaque raised surface is the "panel above backdrop" idiom.
  pickBackdrop: {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: p.veil, paddingHorizontal: 24},
  pickCard: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 12, padding: 16, ...LIFT_SM},
  pickTitle: {fontSize: 13, fontWeight: '600', color: p.sub2, marginBottom: 8, fontFamily: FONT.sans},
  // Bounded scroller for the picker rows - the catalog grows (IC + SOL rails, testnet entries),
  // and a Modal has no scroll surface, so an unbounded list would push the bottom rows off a
  // small screen with no way to reach them. maxHeight only kicks in when the rows actually
  // overflow; a short list renders identically to before.
  pickScroll: {maxHeight: 420},
  pickItem: {flexDirection: 'row', alignItems: 'center', paddingVertical: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: p.line2},
  pickName: {flex: 1, fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  // pickCheck - the trailing active-check wrapper; the margin keeps the icon clear of the
  // amount/label it trails in either variant.
  pickCheck: {marginLeft: 8},
  // pickTextCol - the name+subtitle column right of the AssetGlyph chip, shared by BOTH
  // CurrencyRow variants. Takes flex:1 so the trailing check pushes to the row's right edge; the
  // 10px marginLeft is the chip-to-text gap in both variants. alignSelf stretch gives the column
  // a DEFINITE width: the centered row's shrink-to-fit sizing ignored the flex-basis-0 name Text
  // and starved it to the sub-line's width ("Schweizer" broke mid-word, 2026-10-01 emulator pass).
  pickTextCol: {flex: 1, marginLeft: 8, alignSelf: 'stretch'},
  // pickSubtitle - the chain-label line below the name in a plain-variant row.
  pickSubtitle: {fontSize: 12, color: p.sub2, marginTop: 3, fontFamily: FONT.sans},
  // Pay-scan NFC status row - a large colored NFC mark + a short label, leading the scanner. Green
  // when tap-to-pay is ready, red with a tappable "NFC not available" link + reason popup otherwise.
  nfcStatusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 14},
  nfcStatusLabel: {fontSize: 20, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.3},
  // Receive QR hint - a small NFC mark leading the "or let them tap" label when the reader is armed.
  nfcHintRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10},
  nfcHintLabel: {fontSize: 16, color: p.sub, textAlign: 'center', lineHeight: 22, fontFamily: FONT.sans},
  nfcInfoLink: {flexDirection: 'row', alignItems: 'center', gap: 5},
  nfcInfoLinkText: {fontSize: 16, fontWeight: '600', color: p.bad, fontFamily: FONT.sansBold},
  nfcInfoBody: {fontSize: 16, color: p.ink, lineHeight: 22, marginBottom: 16, fontFamily: FONT.sans},
  nfcInfoClose: {alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: p.card, borderWidth: 1, borderColor: p.line2},
  nfcInfoCloseText: {fontSize: 16, fontWeight: '600', color: p.ink, fontFamily: FONT.sansMedium},
  // Deposit instructions - a scannable card (network/asset + est. time + fee/min + non-custody line).
  instrCard: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 12, padding: 16, marginBottom: 18},
  // The inline one-tap ATA setup card on an AccountsTab currency row (2026-09-30): stretches
  // under the row content; the card itself carries its own surfaces.
  setupCardWrap: {alignSelf: 'stretch', marginTop: 14},
  // The wallet-level setup banner (2026-09-30 redesign): ONE compact card above the currency
  // list - the single setup affordance. Same card grammar as instrCard (radius 12, padding 16),
  // one-line summary row + full-width primary button; the expanded state adds the per-asset
  // detail lines. The refuse state reuses the banner card with the honest dead-end content.
  ataBanner: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 12, padding: 16, marginBottom: 14},
  ataBannerRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  ataBannerTitle: {flexShrink: 1, fontSize: 15, fontWeight: '600', color: p.ink, lineHeight: 20, fontFamily: FONT.sans},
  ataBannerCost: {fontSize: 12, color: p.sub2, marginTop: 4, lineHeight: 17, fontFamily: FONT.sans},
  ataBannerLine: {fontSize: 16, color: p.ink, lineHeight: 22, marginTop: 8, fontFamily: FONT.sans},
  ataBannerNote: {fontSize: 12, color: p.sub2, lineHeight: 17, marginTop: 10, fontFamily: FONT.sans},
  ataAddrRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10},
  ataAddrText: {flexShrink: 1, fontSize: 12, color: p.ink, fontFamily: FONT.mono, letterSpacing: 0.2},
  instrLine: {fontSize: 16, color: p.ink, textAlign: 'center', lineHeight: 22, marginBottom: 8, fontFamily: FONT.sans},
  instrAsset: {color: p.brandText, fontWeight: '700', fontFamily: FONT.sansBold},
  instrMeta: {fontSize: 13, color: p.sub, textAlign: 'center', fontFamily: FONT.sans, paddingVertical: 2, fontVariant: ['tabular-nums']},
  instrCustody: {fontSize: 12, color: p.sub2, textAlign: 'center', marginTop: 10, lineHeight: 17, fontFamily: FONT.sans},
  sheetAddr: {fontSize: 13, color: p.ink, fontFamily: FONT.mono, textAlign: 'center', marginTop: 4, marginBottom: 8, letterSpacing: 0.2},
  depositCopy: {alignSelf: 'stretch', marginTop: 12},
  depositStatus: {marginTop: 24, alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 12, padding: 16},
  depositStatusTitle: {fontSize: 13, fontWeight: '600', color: p.sub2, marginBottom: 6, fontFamily: FONT.sans},
  // "Don't have any yet?" - one provider's published cost (FundingRoutes). Three stacked lines
  // rather than a row, because a name + a cost breakdown + a source domain do not fit side by side
  // at phone width without truncating exactly the part that makes the figure checkable.
  // The Receive tab's "which asset's address am I looking at" switch (AssetSwitchRow). A quiet
  // chip rather than a button: it names the current asset and opens the picker, and it sits under
  // the request/address toggle on BOTH rails' Receive surfaces.
  assetSwitchWrap: {alignSelf: 'stretch', alignItems: 'center', marginBottom: 10},
  assetSwitchBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: p.card},
  assetSwitchText: {fontSize: 16, color: p.ink, fontFamily: FONT.sans},
  fundingProviderRow: {alignSelf: 'stretch', marginTop: 10},
  // The one interactive provider row's name + external-link glyph share a line (the affordance
  // cue); the inert rows keep the plain stacked name.
  fundingProviderHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
  fundingProviderName: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  fundingProviderCost: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, marginTop: 2, fontVariant: ['tabular-nums']},
  // The source domain: `sub` and not `sub2`, deliberately. It is the line that makes every figure
  // above it checkable, so it must clear AA like body text rather than sit in the section-label
  // tier (`sub2` measures 2.30–3.96:1 - see OPEN_ISSUES X17b).
  fundingProviderSource: {fontSize: 12, color: p.sub, fontFamily: FONT.mono, marginTop: 2},
  depositStatusMain: {fontSize: 16, fontWeight: '700', color: p.ink, marginBottom: 4, fontFamily: FONT.sansBold},
  depositStatusRow: {fontSize: 13, color: p.sub, fontFamily: FONT.sans},
  // Manual "Check now" - secondary (outline brand), debounced + spinner while in-flight.
  checkBtn: {marginTop: 16, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: p.brandText, alignItems: 'center', justifyContent: 'center', height: 46, backgroundColor: p.card},
  checkBtnText: {color: p.brandText, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  // Testnet show/hide toggle at the bottom of the Balances sheet - a subtle secondary affordance
  // (never the primary action). Muted text; full-width 44pt touch target.
  testnetToggle: {marginTop: 18, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingVertical: 8},
  testnetToggleText: {color: p.sub, fontWeight: '600', fontSize: 16, fontFamily: FONT.sansMedium},
  // Withdraw sheet form fields.
  inputLabel: {fontSize: 13, fontWeight: '600', color: p.sub, alignSelf: 'flex-start', marginTop: 18, marginBottom: 6, fontFamily: FONT.sansMedium},
  withdrawAddrInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 8, height: 56, paddingHorizontal: 16, fontSize: 15, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  // The destination NICKNAME field: same box, sans — a person's label is prose, not an opaque string.
  withdrawNameInput: {alignSelf: 'stretch', backgroundColor: p.field, borderRadius: 8, height: 56, paddingHorizontal: 16, fontSize: 15, color: p.ink, fontFamily: FONT.sans, borderWidth: 1, borderColor: p.line2},
  savedAddrChip: {alignSelf: 'flex-start', backgroundColor: p.panel2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, minHeight: 44, justifyContent: 'center'},
  savedAddrText: {fontSize: 13, color: p.brandText, fontFamily: FONT.mono},
  // `minWidth: 0` is load-bearing at the ONE call site that puts this field in a row - SendSheet's
  // `amtRow`, where it is given `flex: 1` beside the Max button. Without it the field's intrinsic
  // <input> width wins under CSS `min-width: auto` and pushes Max 28.7px off the right edge
  // (measured, and asserted by e2e flow 146). A no-op where the field is stacked in a column.
  withdrawAmtInput: {alignSelf: 'stretch', minWidth: 0, backgroundColor: p.field, borderRadius: 8, height: 56, paddingHorizontal: 16, fontSize: 24, fontWeight: '700', color: p.ink, borderWidth: 1, borderColor: p.line2, fontFamily: FONT.sansBold, letterSpacing: -0.4, fontVariant: ['tabular-nums']},
  // --- unified send-to-address field (AddressField + SendSheet) ---------------------------------
  // The destination input is MULTILINE and wraps: an IC principal is 63 characters and an ICRC-1
  // account with a subaccount is longer still, so a single 56pt line would hide the tail - and the
  // tail is exactly what a user checks against the wallet they copied it from. minHeight keeps an
  // empty field the same size as the amount field beside it.
  addrRow: {alignSelf: 'stretch', flexDirection: 'row', alignItems: 'stretch', gap: 8},
  addrInput: {flex: 1, backgroundColor: p.field, borderRadius: 8, minHeight: 56, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, lineHeight: 21, color: p.ink, fontFamily: FONT.mono, borderWidth: 1, borderColor: p.line2},
  addrScanBtn: {width: 56, minHeight: 56, borderRadius: 8, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  // The route disclosure line - neutral/informational, distinct from warnNote (amber) and err (red).
  routeNote: {fontSize: 13, color: p.sub, alignSelf: 'flex-start', marginTop: 8, lineHeight: 18, fontFamily: FONT.sans},
  savedList: {alignSelf: 'stretch', marginTop: 14},
  savedRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  savedAddrLabel: {fontSize: 13, fontWeight: '600', color: p.ink, fontFamily: FONT.sansMedium},
  savedForget: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  // Address-book route (2026-09-14): the text column of one saved row (label over elided address,
  // sharing width with the rename/remove controls) and the inline rename input that replaces the
  // label while a rename is in flight - both reuse the saved-list visual language, no new one.
  savedAddrCol: {flex: 1, justifyContent: 'center'},
  renameInput: {flex: 1, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: p.line2, backgroundColor: p.field, color: p.ink, fontSize: 16, fontFamily: FONT.sans},
  // Amount row with the inline Max button.
  amtRow: {alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8},
  maxBtn: {paddingHorizontal: 16, minHeight: 56, borderRadius: 8, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  maxBtnText: {fontSize: 16, fontWeight: '700', color: p.brandText, fontFamily: FONT.sansBold},
  // Review card rows: label left, value right, so amount/fee/total align down the right edge.
  reviewRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6, gap: 12},
  reviewRowLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans},
  reviewRowValue: {fontSize: 13, color: p.ink, fontFamily: FONT.sans, fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right'},
  reviewCard: {alignSelf: 'stretch', marginTop: 20, backgroundColor: p.card, borderRadius: 12, padding: 16},
  reviewLabel: {fontSize: 13, fontWeight: '600', color: p.sub2, marginBottom: 8, fontFamily: FONT.sans},
  // 'Needs setup' pill on a currency row - an INLINE annotation on the title line (founder
  // 2026-10-05 density rework: no second badge row), sitting right of the name.
  assetBadge: {alignSelf: 'center', marginLeft: 6, paddingVertical: 1, paddingHorizontal: 6, borderRadius: 4, backgroundColor: withAlpha(p.warn, p.wash), borderWidth: 1, borderColor: withAlpha(p.warn, 0.35), fontSize: 10, fontWeight: '600', color: p.warn, fontFamily: FONT.sans, overflow: 'hidden'},
  // 'Main' pill on the currency row that IS the home currency. Same inline-pill geometry as
  // `assetBadge`, brand-tinted rather than warn-tinted: this one marks the account the wallet opens
  // with, which is a statement of fact, not a warning about setup.
  assetBadgeMain: {alignSelf: 'center', marginLeft: 6, paddingVertical: 1, paddingHorizontal: 6, borderRadius: 4, backgroundColor: withAlpha(p.brandText, p.wash), borderWidth: 1, borderColor: withAlpha(p.brandText, 0.35), fontSize: 10, fontWeight: '600', color: p.brandText, fontFamily: FONT.sans, overflow: 'hidden'},
  // ─── Walkthrough (Trip Ready J1, 2026-08-22) ────────────────────────────────────────────────
  // The first-run 3-scene pager + its Settings replay. A left-aligned label/title/body block
  // over a plain 20-radius illustration panel, then a footer with progress dots + the primary
  // Next. Brand stays reserved for Next and the active dot (discipline unchanged).
  walkRoot: {flex: 1, backgroundColor: p.bg},
  // Chrome (founder ask 2026-08-24): the education surfaces share the app's standard sheet
  // header - S.sheetHead + S.sheetTitle + the 44pt flat S.sheetClose top-right - exactly the
  // SettingsSheet grammar, instead of a bespoke wordmark/Skip bar. The boxed affordance is
  // close in the Walkthrough replay and skip/explore on first-run + Rehearsal.
  walkBackBtn: {minHeight: 44, paddingHorizontal: 12, justifyContent: 'center'},
  walkBackText: {color: p.sub, fontSize: 16, fontWeight: '600', fontFamily: FONT.sansMedium},
  // Text block - LEFT-aligned (the editorial reading; centered stacks read as generic onboarding,
  // which the spec bans). 20dp side margins = the sheet rhythm (sheetHead/sheetCenter use 20).
  walkBody: {paddingHorizontal: 20, paddingTop: 8},
  // Practice request phase only: its content (title + balance + practice card) is short and
  // otherwise dies ~40% down the screen, leaving the lower half dead before the pinned footer.
  // flexGrow (NOT flex:1 - see `onboard` for why flex would disable scrolling) lets the block
  // fill the frame when short and still scroll when tall; justifyContent centers the short case.
  // Composed ONTO walkBody by Practice's request branch, so the walkthrough, passport, and the
  // practice review/outcome/blocked branches keep their layouts byte-identical.
  walkBodyCenter: {flexGrow: 1, justifyContent: 'center'},
  walkEyebrow: {fontSize: 13, fontWeight: '600', color: p.sub2, fontFamily: FONT.sans},
  walkTitle: {fontSize: 29, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.7, lineHeight: 33, marginTop: 12},
  walkText: {fontSize: 16, color: p.sub, lineHeight: 23, marginTop: 12, fontFamily: FONT.sans},
  // The illustration stage - a plain raised panel, fixed aspect so every scene's illustration
  // occupies the same stage (visual continuity across the pager).
  walkStage: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 12, overflow: 'hidden', marginTop: 26, aspectRatio: 1.32},
  // Corner marker on the panel - a quiet scene index, top-right.
  // zIndex keeps it above the scene illustration (scene 1's breathing arcs cross the corner and,
  // as later siblings, would otherwise paint over the tag).
  walkStageTag: {position: 'absolute', top: 12, right: 16, zIndex: 1, fontSize: 11, fontWeight: '600', color: p.brandText, fontFamily: FONT.sans, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, opacity: 0.9},
  walkFooter: {paddingHorizontal: 20, paddingBottom: 12, paddingTop: 16},
  // Dots row: relative so the Back link can sit absolutely at the left while the dots center.
  walkNavRow: {position: 'relative', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 12, minHeight: 34},
  walkDot: {height: 6, borderRadius: 3, backgroundColor: p.line},
  walkDotOn: {backgroundColor: p.brand},
  // The campaign send-off strip (final scene): fine rules flank the line.
  walkCampaign: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16, marginTop: 2},
  walkCampaignRule: {flex: 1, height: 1, backgroundColor: p.line},
  walkCampaignText: {fontSize: 12, fontWeight: '600', color: p.sub, fontFamily: FONT.sans},
  // Scene 3 illustration - the request card with ONE exact asset + ghost rows that stay put.
  walkReqCard: {alignSelf: 'stretch', backgroundColor: p.card, borderRadius: 12, padding: 14},
  walkReqEyebrow: {fontSize: 12, fontWeight: '600', color: p.sub2, fontFamily: FONT.sans},
  walkAssetRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, marginTop: 6},
  walkAssetChip: {width: 34, height: 34, borderRadius: 8, borderWidth: 1, borderColor: p.glyphBorder, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  walkAssetChipText: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  walkAssetName: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  walkAssetSub: {fontSize: 11, color: p.sub2, marginTop: 2, fontFamily: FONT.sans},
  walkAssetAmt: {fontSize: 16, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, marginLeft: 'auto', fontVariant: ['tabular-nums']},
  // The brand "reviewed" badge (in-scene accent; confirmed-success green stays reserved for
  // actual settlement states).
  walkStampBadge: {width: 26, height: 26, borderRadius: 13, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', marginLeft: 10},

  // ─── Trip Ready J2B (2026-08-22): recovery ritual, rehearsal, first-use coaching ──────────
  // The backup screen's ownership line - the ritual sentence ABOVE the warning. Slightly larger
  // than the warning, ink (not warn-tinted): the moment reads as ownership first, risk second.
  backupRitualNote: {fontSize: 16, color: p.ink, textAlign: 'center', marginTop: 8, marginBottom: 0, paddingHorizontal: 8, lineHeight: 22, fontFamily: FONT.sansMedium},
  // The RECOVERY SAVED chip (the post-faucet beat): a quiet brandText ring, sentence-case sans.
  stampChip: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: p.brandText, backgroundColor: 'transparent'},
  stampChipText: {color: p.brandText, fontFamily: FONT.sans, fontSize: 13, fontWeight: '600'},
  // The RECOVERY SAVED beat (UX hardening 2026-08-23 made it full-bleed; was: a tiny chip on
  // ~96% blank page, which read as a crash flash). Ballast makes it the FIRST Settlement
  // Field: full-bleed `brand`, `brandInk` type - the money-moved register from minute one.
  inkBeat: {flex: 1, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36},
  inkStamp: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 8, borderWidth: 1.5, borderColor: p.brandInk},
  inkStampText: {color: p.brandInk, fontFamily: FONT.sans, fontSize: 16, fontWeight: '600'},
  inkBeatLine: {color: p.brandInk, fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: 34, lineHeight: 22, fontFamily: FONT.sansMedium},
  inkBeatSub: {color: p.brandInk, fontSize: 13, textAlign: 'center', marginTop: 8, fontFamily: FONT.sans},
  // Rehearsal, re-paged to ONE screen (UX hardening 2026-08-23): scroll container + three
  // badge/line rows in the walkthrough's tag grammar (brandText sans tag) - the old
  // auto-advance rail died with the pager.
  walkScroll: {flex: 1},
  rehStep: {marginTop: 18},
  rehBadge: {alignSelf: 'flex-start', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 7},
  rehBadgeText: {color: p.brandText, fontSize: 12, fontWeight: '600', fontFamily: FONT.sans},
  rehStepTitle: {color: p.ink, fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold},
  rehStepBody: {color: p.sub, fontSize: 16, lineHeight: 22, marginTop: 4, fontFamily: FONT.sans},
  // CoachTip - the one-time contextual card. A quiet panel (not card: it sits ON the surface,
  // quieter than the QR card); icon chip echoes walkAssetChip so
  // the coaching voice matches the walkthrough's. NEVER fixed/overlay - inline, so it can never
  // block the primary action.
  coachCard: {alignSelf: 'stretch', backgroundColor: p.panel, borderRadius: 12, padding: 12, marginTop: 14},
  coachRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  coachIcon: {width: 30, height: 30, borderRadius: 8, borderWidth: 1, borderColor: p.glyphBorder, backgroundColor: p.panel2, alignItems: 'center', justifyContent: 'center'},
  coachText: {flex: 1, minWidth: 0},
  coachTitle: {fontSize: 13, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold},
  coachBody: {fontSize: 12.5, color: p.sub, lineHeight: 17.5, marginTop: 2, fontFamily: FONT.sans},
  coachDismiss: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -4},

  // ── The Settlement Field (brief Part I + VI.1) ──────────────────────────────────────────
  // Every surface on which value is in motion renders full-bleed in the brand fill with
  // inverted ink: the confirmed intent, signing/in-flight legs, the done state, the NFC
  // takeover. One flooded color per money event. A flat saturated instrument: no shadows, no
  // gradient, `brand2` hairline separators. Additive keys; components opt in by name.
  fieldRoot: {flexGrow: 1, backgroundColor: p.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32},
  fieldTitle: {fontSize: 32, fontWeight: '700', color: p.brandInk, fontFamily: FONT.sansBold, letterSpacing: -0.5, textAlign: 'center', fontVariant: ['tabular-nums']},
  fieldBody: {fontSize: 16, color: p.brandInk, fontFamily: FONT.sans, textAlign: 'center', lineHeight: 22, marginTop: 8},
  fieldRule: {alignSelf: 'stretch', height: 1, backgroundColor: p.brand2, marginVertical: 18},
  fieldAction: {alignSelf: 'stretch', minHeight: 52, borderRadius: 8, borderWidth: 1, borderColor: withAlpha(p.brandInk, 0.45), alignItems: 'center', justifyContent: 'center', marginTop: 16},
  fieldActionText: {color: p.brandInk, fontSize: 16, fontWeight: '700', fontFamily: FONT.sansBold},

  // ── The convert intent sheet (brief Part V) ─────────────────────────────────────────────
  // The sheet surface the two-tap convert renders in: the route's content column wears the
  // sheet chrome (R_CARD 12 top corners, card surface, LIFT_SM), everything inside stays
  // mist-quiet. Chips are R_CTRL wells; the CTA is S.primary bottom-anchored.
  sheetRoot: {flex: 1, alignSelf: 'stretch', backgroundColor: p.card, borderTopLeftRadius: 12, borderTopRightRadius: 12, paddingHorizontal: 20, paddingTop: 8, ...LIFT_SM},
  sheetGrabber: {alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: p.line, marginBottom: 12},
  sheetSectionLabel: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, marginTop: 16, marginBottom: 8},
  // The target line: ONE tappable row naming the currency the conversion lands in (the
  // optional decision). A 44-tall pill row so the touch floor holds without extra chrome.
  targetLine: {flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, alignSelf: 'flex-start'},
  targetLineName: {fontSize: 16, color: p.ink, fontFamily: FONT.sansMedium, flexShrink: 1},
  // Sibling currency chips: small pills in one wrap row (999/h44), 6px gaps, the active
  // currency absent (it IS the line).
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  chip: {paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, borderColor: p.line2, backgroundColor: p.field, minHeight: 44, alignItems: 'center', justifyContent: 'center'},
  chipOn: {borderColor: p.brand, backgroundColor: p.brand},
  chipText: {fontSize: 13, color: p.ink, fontFamily: FONT.sansMedium},
  chipTextOn: {color: p.brandInk, fontFamily: FONT.sansBold},
  // The preset row (25% / 50% / Max) rides under the amount field: same pill grammar, 8px top.
  presetRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  // The review card is the sheet's whole body: what moves, what lands, whose numbers they are.
  intentCard: {backgroundColor: p.panel2, borderRadius: 12, padding: 16, alignSelf: 'stretch', marginTop: 16},
  reviewReceiveRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, alignSelf: 'stretch', marginTop: 10},
  reviewReceiveAmount: {fontSize: 24, fontWeight: '700', color: p.ink, fontFamily: FONT.sansBold, letterSpacing: -0.4, textAlign: 'right', flexShrink: 1, fontVariant: ['tabular-nums']},
  // The mechanical venue-pick disclosure + attribution: quiet meta lines under the figure.
  reviewMeta: {fontSize: 12, color: p.sub2, fontFamily: FONT.sans, marginTop: 8},
  // The quote-moved note at re-arm: warn is the traffic-light for "look again", on its own line.
  movedNote: {fontSize: 13, color: p.warn, lineHeight: 20, marginTop: 8, fontFamily: FONT.sansMedium},
  // The Other-venues expander row: a quiet full-width disclosure control (the Details grammar).
  venuesToggle: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch', minHeight: 44, marginTop: 12},
  venuesToggleText: {fontSize: 13, color: p.sub, fontFamily: FONT.sans, flexShrink: 1},
  venuesList: {alignSelf: 'stretch', marginTop: 4},
  // Settlement Field in-flight tracker rows: brandInk text, brand2 separators, no shadows.
  fieldLegRow: {alignSelf: 'stretch', paddingVertical: 12, borderTopWidth: 1, borderTopColor: p.brand2},
  fieldLegLabel: {fontSize: 16, color: p.brandInk, fontFamily: FONT.sans, lineHeight: 22},
  fieldLegState: {fontSize: 13, color: p.brandInk, fontFamily: FONT.sans, opacity: 0.85, marginTop: 4},
  fieldTx: {fontSize: 12, color: p.brandInk, fontFamily: FONT.mono, textAlign: 'center', lineHeight: 18, marginTop: 8},
  fieldHeaderTitle: {flex: 1, fontSize: 22, fontWeight: '700', color: p.brandInk, fontFamily: FONT.sansBold, letterSpacing: -0.3},
  fieldLegs: {alignSelf: 'stretch', marginTop: 16},
  fieldLegStateBad: {fontSize: 13, color: p.brandInk, fontFamily: FONT.sansBold, opacity: 1, marginTop: 4, fontWeight: '700'},
  // The stateful leg checklist (2026-10-04 composed-truth fix): done rows recede behind a
  // done marker, the ACTIVE row is the one emphasized row, pending rows stay muted. Tokens
  // only - the components keep the strings. Receding is OPACITY on the approved ink (the
  // stylesheet closure test admits no off-token colours).
  fieldLegLabelDone: {fontSize: 16, color: p.brandInk, opacity: 0.55, fontFamily: FONT.sans, lineHeight: 22},
  fieldLegStateDone: {fontSize: 13, color: p.brandInk, opacity: 0.55, fontFamily: FONT.sans, marginTop: 4},
  fieldLegLabelActive: {fontSize: 16, color: p.brandInk, fontFamily: FONT.sansMedium, lineHeight: 22},
  fieldLegStateActive: {fontSize: 13, color: p.brandInk, fontFamily: FONT.sansMedium, marginTop: 4},
  fieldLegLabelPending: {fontSize: 16, color: p.brandInk, opacity: 0.7, fontFamily: FONT.sans, lineHeight: 22},
  // The composed tracker's verbatim venue deposit address (mono, brandInk, wraps left-aligned).
  fieldPrincipal: {fontSize: 12, color: p.brandInk, fontFamily: FONT.mono, lineHeight: 18, marginTop: 4, marginBottom: 8},
  });
}

// ─── Live theme machinery ────────────────────────────────────────────────────────────────────
// S is a MUTABLE holder: initialized from the OS-resolved palette at module load, then swapped
// in place by `applyPalette`. This works through every bundler interop because we only ever
// Object.assign onto the SAME exported object - we never reassign the binding:
//   • Metro/Hermes (native): `import {S}` compiles to a CJS property access on module.exports -
//     in-place mutation is exactly what every use-site reads.
//   • vite/rollup ESM (web bundle): `S` is a live binding to the same object; mutation of the
//     object is visible regardless of binding semantics.
//   • jest: same CJS interop as Metro.
// StyleSheet.create in RN 0.86 is an identity function that (in DEV only) Object.freezes each
// INNER style object but NOT the returned registry - so replacing S's KEYS via Object.assign is
// always legal. Verified by __tests__/palette.test.ts and the flow-84 dark e2e (real browser).

/** The live stylesheet. Read `S.x` at render time; treat the object as opaque + immutable
 *  outside `applyPalette`. */
export const S = buildStyles(LIGHT);

/**
 * The amount-input font for the TYPED text (2026-10-02 founder defect): a long amount must
 * stay fully visible in the field, so the size steps down by content length - 32px through
 * 9 characters, 24px through 19, 18px beyond. Deterministic and pure (Android's
 * TextInput has no reliable adjustFontSizeToFit); pinned by convertAmountSizing.test.ts.
 */
export function amountFontFor(text: string): TextStyle {
  const len = text.trim().length;
  if (len <= 9) return S.amountFontLg;
  if (len <= 19) return S.amountFontMd;
  return S.amountFontSm;
}

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

/** The palette for a surface that INVERTS against the current theme - the `p.ink`-painted beats
 *  (RECOVERY SAVED, TRIP READY). Same rule `buildStyles` applies to their styles; components that
 *  render an icon onto one of those surfaces read their colour from here. Call it at RENDER time:
 *  the answer changes with the theme. */
export function inverseC(): Palette {
  return darkNow ? LIGHT : DARK;
}

// Resolve the OS theme BEFORE first render. This runs at styles.ts module load - before App's
// first render in every entry (native index.js, web entry.tsx, jest imports) - so the initial
// S/C already carry the right theme.
applyPalette(initialSchemeIsDark() ? DARK : LIGHT);
