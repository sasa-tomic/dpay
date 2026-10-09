#!/usr/bin/env bash
# Camera-preview device gate — REAL pixels, ZERO mocks.
#
# Drives the REAL installed APK (org.kalaj.dpay) on the REAL emulator through the IC (DEMO) and
# SOL Pay scan screens (Home ▸ accounts route → asset row), then asserts that REAL camera pixels
# from the emulated camera HAL (virtual scene) are visible inside the scan box:
#   PASS ⟺ per-channel stddev ≥ 10 AND mean luminance ≥ 60 over the box crop.
# Measured on dpay_api36: healthy virtual-scene feed = std 79–84, lum ~194; collapsed/flat box =
# std 0.00, lum ~7.7; permission-placeholder branch = std 2.5, lum ~7.7 (the luminance guard is
# what kills that false-positive — unique-color count alone cannot discriminate).
#
# This catches the class of bug the browser e2e is structurally blind to (web camera shim renders
# the placeholder branch, which has intrinsic width): a scan-screen layout change that collapses
# the camera preview to 0×0 (e.g. an unstyled, content-sized wrapper around <QrScanner/>).
#
# SOL leg note: the SOL RPC endpoint is made unreachable for the run so the fund-first gate
# (known-zero mainnet SOL would replace the scanner with the FundFirstPanel) takes its
# documented FAIL-OPEN path and renders the scanner — see the override-seed block below.
#
# Exit codes: 0 = green on both screens; 1 = camera preview not rendering (the regression);
# 2 = UI navigation/anchor failure (app UI changed — fix the script's anchors); 3 = device/app
# environment failure (no device, no self-check).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PKG=org.kalaj.dpay
ACT=org.kalaj.dpay/com.dpay.MainActivity
ART="$(mktemp -d /tmp/opencode/campreview.XXXXXX)"
# The SOL-leg override seed (see the block that sets SOL_SEEDED): the key the app itself owns,
# the DB it lives in, the unreachable endpoint that forces the fail-open path, and the prior
# value to restore in the EXIT trap. Prior '' = no row (delete on restore).
SOL_RPC_KEY='dpay.solanaRpc.v1'
SOL_RPC_DB="/data/data/$PKG/databases/AsyncStorage"
SOL_OVERRIDE_URL='https://127.0.0.1:9/'
SOL_OVERRIDE_PRIOR=''
SOL_SEEDED=""
cleanup() {
  # restore the SOL RPC operator override this gate seeded, if it did (idempotent). force-stop
  # first: the app holds the DB open (WAL), and a write under a live app process could be lost
  # or clobbered by the app's own next AsyncStorage flush.
  if [ -n "$SOL_SEEDED" ]; then
    $ADB shell am force-stop "$PKG" >/dev/null 2>&1 || true
    if [ -n "$SOL_OVERRIDE_PRIOR" ]; then
      $ADB shell "sqlite3 $SOL_RPC_DB \"insert or replace into Storage(key,value) values('$SOL_RPC_KEY','$SOL_OVERRIDE_PRIOR')\"" >/dev/null 2>&1 || true
    else
      $ADB shell "sqlite3 $SOL_RPC_DB \"delete from Storage where key='$SOL_RPC_KEY'\"" >/dev/null 2>&1 || true
    fi
  fi
  echo "   artifacts: $ART" >&2
}
trap cleanup EXIT

export ANDROID_HOME="${ANDROID_HOME:-/home/sat/Android/Sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

ADB=adb
if [ -n "${ANDROID_SERIAL:-}" ]; then ADB="adb -s $ANDROID_SERIAL"; fi

echo "== require a booted device =="
$ADB wait-for-device
BOOTED="$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
[ "$BOOTED" = "1" ] || { echo "FAIL: no fully-booted device (sys.boot_completed=$BOOTED)"; exit 3; }
echo "   device: ${ANDROID_SERIAL:-$($ADB devices | awk 'NR==2{print $1}')} (via $ADB)"

echo "== require the app installed + camera permission granted =="
# NOTE: drain adb output BEFORE grep -q — under `set -o pipefail`, grep -q exiting at its first
# match EPIPEs a still-writing `adb shell` (a physical phone's 228+-package list; a big logcat
# buffer), failing the pipeline despite the match. The emulator's small buffers never trip it.
PKGS="$($ADB shell pm list packages 2>/dev/null | tr -d '\r')"
grep -q "^package:$PKG$" <<<"$PKGS" \
  || { echo "FAIL: $PKG not installed (run: just app)"; exit 3; }
$ADB shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null || true

# ---- SOL-RPC override seed (fund-first gate → documented fail-open path) -------------
# Since the zero-funds UX (2026-08-16), a wallet with KNOWN-zero mainnet SOL renders the
# FundFirstPanel IN PLACE OF the SOL Pay scanner (solPayGate 'sol-zero') — correct product
# behavior, but it leaves this gate no scan box to measure. The app state that renders the
# scanner with SOL unreachable is the FAIL-OPEN path (RPC error → gate 'none'; e2e flow 79
# step 4). This gate exercises exactly that. R2 (2026-09) removed the baked RPC literal —
# SOL RPC now rides the relay proxy — so the old network-layer blackhole (iptables-REJECT the
# RPC host's IPs, disjoint from the relay) has no host of its own to block without cutting
# the relay itself. Instead the gate seeds the app's OWN operator override (precedence #1 in
# config/constants.ts#solanaRpcUrls, the escape hatch of record) with an unreachable endpoint
# straight into the on-device AsyncStorage DB (root sqlite3 on the emulator): 127.0.0.1:9
# refuses instantly, needs no DNS, passes the app's https/mainnet validation, and leaves the
# relay — which now also carries the SOL path — fully live, so the IC leg + faucet stay up
# and the camera path stays 100% real. The prior value (if any) is restored by the EXIT trap.
echo "== seed the SOL RPC operator override (fail-open path; known-zero would show the fund panel) =="
$ADB root >/dev/null 2>&1; $ADB wait-for-device
# the key must still be the app's own literal (single source of truth; refuses silently drifted gates)
grep -q "SOLANA_RPC_STORAGE_KEY = '$SOL_RPC_KEY'" app/config/constants.ts \
  || { echo "FAIL: '$SOL_RPC_KEY' is no longer the SOLANA_RPC_STORAGE_KEY literal in app/config/constants.ts — revisit this gate"; exit 3; }
$ADB shell am force-stop "$PKG"
DB_OK="$($ADB shell "test -f $SOL_RPC_DB && echo yes" 2>/dev/null | tr -d '\r')"
[ "$DB_OK" = "yes" ] || { echo "FAIL: no AsyncStorage DB at $SOL_RPC_DB (run: just app, launch once)"; exit 3; }
SOL_OVERRIDE_PRIOR="$($ADB shell "sqlite3 $SOL_RPC_DB \"select ifnull(value,'') from Storage where key='$SOL_RPC_KEY'\"" 2>/dev/null | tr -d '\r\n')"
$ADB shell "sqlite3 $SOL_RPC_DB \"insert or replace into Storage(key,value) values('$SOL_RPC_KEY','$SOL_OVERRIDE_URL')\"" >/dev/null
SEEDED_VAL="$($ADB shell "sqlite3 $SOL_RPC_DB \"select value from Storage where key='$SOL_RPC_KEY'\"" 2>/dev/null | tr -d '\r\n')"
[ "$SEEDED_VAL" = "$SOL_OVERRIDE_URL" ] || { echo "FAIL: could not seed $SOL_RPC_KEY into $SOL_RPC_DB"; exit 3; }
SOL_SEEDED=1
echo "   seeded $SOL_RPC_KEY → $SOL_OVERRIDE_URL (RPC refuses instantly → gate 'none')"

echo "== (re)launch + wait for the on-device self-check =="
$ADB shell am force-stop "$PKG"
$ADB logcat -c 2>/dev/null || true
$ADB shell am start -n "$ACT" >/dev/null
SELFCHECK=""
for _ in $(seq 1 30); do
  LOGCAT_DUMP="$($ADB logcat -d -s ReactNativeJS:V 2>/dev/null)"   # drain before grep -q (pipefail/EPIPE — see PKGS note)
  if grep -q 'DPAY_SELFCHECK PASS' <<<"$LOGCAT_DUMP"; then SELFCHECK=1; break; fi
  sleep 1
done
[ -n "$SELFCHECK" ] || { echo "FAIL: DPAY_SELFCHECK PASS not seen within 30s"; exit 3; }
echo "   DPAY_SELFCHECK PASS"

# ---- helpers ---------------------------------------------------------------

# anr_wait_tap: probe $ART/ui.xml for a system "…isn't responding" ANR dialog covering the app
# (headless emulator under load throws these over ANY app — observed 4× during ensure_wallet, where
# it wedged the gate with a bogus exit-2 'anchor not found'). Prints:
#   ""             no ANR dialog
#   "TAP x y"      center of the dialog's Wait button — Wait keeps the app alive (NEVER 'Close app')
#   "NONE <title>" dialog present but no findable Wait button (caller fails honestly, naming it)
anr_wait_tap() {
  python3 - "$ART/ui.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
try:
    nodes = list(ET.parse(sys.argv[1]).getroot().iter('node'))
except Exception:
    sys.exit(0)  # unparseable → empty probe; the caller's dump-validity retry owns that failure
def center(n):
    a, b = n.get('bounds').strip('[]').split('][')
    x0, y0 = (int(v) for v in a.split(','))
    x1, y1 = (int(v) for v in b.split(','))
    return (x0 + x1) // 2, (y0 + y1) // 2
title = ''
for n in nodes:
    t = n.get('text') or ''
    if 'responding' in t and ("isn" in t or "is not" in t):
        title = title or t
if not title:
    sys.exit(0)
# dismiss with 'Wait' only: text-exact first (cannot hit 'Close app'), then the ANR wait id,
# then generic button2 (= the negative 'Wait' button on AOSP ANR dialogs).
for n in nodes:
    if (n.get('text') or '').strip().lower() == 'wait':
        print('TAP %d %d' % center(n)); sys.exit(0)
for rid in ('android:id/aerr_wait', 'android:id/button2'):
    for n in nodes:
        if n.get('resource-id') == rid:
            print('TAP %d %d' % center(n)); sys.exit(0)
print('NONE ' + title)
PY
}

# dump_ui: fresh uiautomator XML at $ART/ui.xml (retries — dump occasionally misses idle state).
# ANR guard: after every good dump, probe for a covering ANR dialog, dismiss it via Wait (max 3
# dismissals per call — self-limiting), and re-dump. More than 3 in one call, or a dialog with no
# Wait button, is an environment failure (exit 3, dialog named) — never misreported as an app
# navigation (exit 2) or camera (exit 1) regression.
dump_ui() {
  local dismisses=0
  for _ in 1 2 3 4 5 6; do
    if $ADB shell uiautomator dump /sdcard/campreview-ui.xml >/dev/null 2>&1; then
      $ADB shell cat /sdcard/campreview-ui.xml 2>/dev/null | tr -d '\r' > "$ART/ui.xml"
      if [ -s "$ART/ui.xml" ] && grep -q "</hierarchy>" "$ART/ui.xml"; then
        local anr; anr="$(anr_wait_tap)"
        if [ -z "$anr" ]; then
          return 0
        fi
        case "$anr" in
          TAP\ *)
            dismisses=$((dismisses + 1))
            if [ "$dismisses" -gt 3 ]; then
              echo "FAIL env: an ANR dialog still covers the app after 3 'Wait' dismissals; ui dump: $ART/ui.xml" >&2
              exit 3
            fi
            echo "   ANR dialog on top — tapping Wait (${anr#TAP }) [$dismisses/3]" >&2
            $ADB shell input tap ${anr#TAP }
            ;;
          *)
            echo "FAIL env: ANR dialog '${anr#NONE }' covers the app with no Wait button to dismiss; ui dump: $ART/ui.xml" >&2
            exit 3
            ;;
        esac
      fi
    fi
    sleep 1
  done
  return 1
}

# rid_text <resource-id>: the text of the first node carrying resource-id ("" when absent)
rid_text() {
  python3 - "$ART/ui.xml" "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
for n in ET.parse(sys.argv[1]).getroot().iter('node'):
    if n.get('resource-id') == sys.argv[2]:
        print(n.get('text') or '')
        break
PY
}

# tap_rid <resource-id>: tap the center of the first node carrying resource-id
tap_rid() {
  local rid="$1"
  local xy="" attempt
  # One bounded retry: onboarding transitions can retire an anchor between the caller's dump
  # and ours (race window ~1s). Returning 1 (not exit) lets ensure_wallet's `|| true` absorb
  # a vanished anchor while `set -e` keeps direct callers fail-loud.
  for attempt in 1 2; do
    dump_ui || { echo "FAIL nav: uiautomator dump failed"; exit 2; }
    xy="$(python3 - "$ART/ui.xml" "$rid" <<'PY'
import sys, xml.etree.ElementTree as ET
xml, rid = sys.argv[1], sys.argv[2]
for node in ET.parse(xml).getroot().iter('node'):
    if node.get('resource-id') == rid:
        a, b = node.get('bounds').strip('[]').split('][')
        x0, y0 = (int(v) for v in a.split(','))
        x1, y1 = (int(v) for v in b.split(','))
        print((x0 + x1) // 2, (y0 + y1) // 2)
        break
PY
)"
    [ -n "$xy" ] && break
    [ "$attempt" = 2 ] || sleep 1
  done
  [ -n "$xy" ] || { echo "FAIL nav: anchor '$rid' not found; ui dump: $ART/ui.xml"; return 1; }
  $ADB shell input tap $xy
}

# capture <png-path>: screencap to <png-path>
capture() { $ADB exec-out screencap -p > "$1"; }

# region_of <ic|sol>: resolve the camera-box rect from the current UI dump.
#   Preferred: resource-id 'scan-cam-box' (QrScanner root View).
#   Fallback: anchor on the hint TEXT node above the box (never the sol-pay-scan container —
#   its height is 73px when collapsed but ~1100px when healthy, so container-bottom would sample
#   BELOW the box post-fix → false RED). Box: x 42..W-42, y text_bottom+8 .. +996, clamped.
region_of() {
  python3 - "$ART/ui.xml" "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
xml, screen = sys.argv[1], sys.argv[2]
root = ET.parse(xml).getroot()
nodes = list(root.iter('node'))
W, H = 1080, 2400
m = nodes[0].get('bounds').strip('[]').split('][')
W, H = int(m[1].split(',')[0]), int(m[1].split(',')[1])
def bounds(n):
    a, b = n.get('bounds').strip('[]').split('][')
    x0, y0 = (int(v) for v in a.split(','))
    x1, y1 = (int(v) for v in b.split(','))
    return x0, y0, x1, y1
for n in nodes:
    if n.get('resource-id') == 'scan-cam-box':
        x0, y0, x1, y1 = bounds(n)
        print(x0, y0, min(x1, W - 42), min(y1, H - 60)); sys.exit(0)
anchor = 'Scan the QR code to pay' if screen == 'ic' else 'Scan the merchant'
for n in nodes:
    if anchor in (n.get('text') or ''):
        _, y0, _, y1 = bounds(n)
        print(42, y1 + 8, W - 42, min(y1 + 8 + 996, H - 60)); sys.exit(0)
sys.exit(1)
PY
}

# metrics <png> <x0> <y0> <x1> <y1>: print "maxstd meanlum uniq" over the crop
metrics() {
  python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import sys
from PIL import Image
import numpy as np
img = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float64)
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
crop = img[y0:y1, x0:x1]
std = crop.reshape(-1, 3).std(axis=0).max()
lum = (0.299 * crop[:, :, 0] + 0.587 * crop[:, :, 1] + 0.114 * crop[:, :, 2]).mean()
uniq = len(np.unique(crop.reshape(-1, 3).astype(np.uint8) // 8, axis=0))
print(f"{std:.2f} {lum:.1f} {uniq}")
PY
}

# check_screen <label> <asset-rid> <ic|sol>: navigate Home ▸ accounts → asset → assert live pixels.
# (2026-09-08 home surface: the wallet LANDS on Home — `btn-home-accounts` opens the accounts
# ROUTE; the old `balance` chip tap only worked pre-home-surface, when the balances list was
# the landing itself. The tab bar is outside the mode switch, so tab-home → accounts works
# from wherever the previous screen left the wallet.)
check_screen() {
  local label="$1" rid="$2" which="$3"
  tap_rid tab-home
  sleep 1
  tap_rid btn-home-accounts
  sleep 2
  # Prime: a wallet whose selected asset is ALREADY the target (DEMO is the IC default) would
  # no-op the target tap, and the label-change check below could never observe a transition.
  # Select a DIFFERENT row first — so the target tap always has an observable before-label.
  # Anchors (2026-10-09, after the Oct 5 convert-rework list): BOTH legs navigate by CURRENCY
  # rows (`btn-accounts-currency-CHF` / `btn-accounts-currency-SOL`) — they select reliably and
  # sit in-viewport. The old `asset-sol` row is gone; the `asset-demo` row still exists but sits
  # at the list bottom (off-viewport, degenerate bounds) and its tap does not select, so it is
  # retired from this flow too.
  local primer="$([ "$rid" = btn-accounts-currency-CHF ] && echo btn-accounts-currency-SOL || echo btn-accounts-currency-CHF)"
  for _ in 1 2 3 4 5; do
    dump_ui || { sleep 1; continue; }
    grep -q "resource-id=\"$primer\"" "$ART/ui.xml" && break
    $ADB shell input swipe 540 1700 540 700 300 || true
    sleep 1
  done
  tap_rid "$primer" || true
  sleep 2
  # A row select RETURNS TO HOME (the Oct 5 rework) — re-enter the accounts route before the
  # target scroll-and-tap loop, which can only find its anchor there.
  tap_rid tab-home
  sleep 1
  tap_rid btn-home-accounts
  sleep 2
  # The accounts list is longer than one viewport — the target row (e.g. USDC · Solana) can sit
  # below the uiautomator fold. Scroll-and-retry until the row anchor is in the dumped viewport,
  # then tap and VERIFY the header label changed (a row select always switches the active asset;
  # a label that didn't change means the tap missed — re-scroll and tap again).
  local sel_ok=""
  for attempt in 1 2 3; do
    local pre_label=""
    for _ in 1 2 3 4 5; do
      dump_ui || { sleep 1; continue; }
      pre_label="$(rid_text active-asset-label)"
      if grep -q "resource-id=\"$rid\"" "$ART/ui.xml"; then break; fi
      $ADB shell input swipe 540 1700 540 700 300 || true
      sleep 1
    done
    grep -q "resource-id=\"$rid\"" "$ART/ui.xml" || { echo "FAIL nav: anchor '$rid' not found (scrolled); ui dump: $ART/ui.xml"; exit 1; }
    tap_rid "$rid"
    sleep 2
    # A row select RETURNS TO HOME (the Oct 5 rework) and Home carries no active-asset-label
    # node (verified in the run-5 dump) — re-enter the accounts route before reading the label.
    tap_rid tab-home
    sleep 1
    tap_rid btn-home-accounts
    sleep 2
    dump_ui || true
    local post_label; post_label="$(rid_text active-asset-label)"
    echo "   row select attempt $attempt: '$pre_label' → '$post_label'"
    if [ -n "$post_label" ] && [ "$post_label" != "$pre_label" ]; then sel_ok=1; break; fi
  done
  [ -n "$sel_ok" ] || { echo "FAIL nav: row select did not take (label stayed '$(rid_text active-asset-label)'); ui dump: $ART/ui.xml"; exit 1; }
  # Post-S3 (Balances modal retired): selecting an asset row keeps the wallet on the Home tab —
  # land the Pay surface explicitly before resolving the camera box.
  tap_rid tab-pay
  sleep 2
  # Auto-armed pay tab (2026-10-09): the scan surface has NO gate press — the camera is live the
  # moment the tab opens, so the second settle gives the HAL stream time to paint before the
  # box anchor resolves below.
  sleep 2
  local best="0 0 0" region="" attempt_png=""
  for i in 1 2 3 4; do
    dump_ui || { echo "FAIL nav: uiautomator dump failed"; exit 2; }
    if ! region="$(region_of "$which")"; then
      echo "FAIL nav: no camera-box anchor (scan-cam-box / hint text) on $label screen; ui dump: $ART/ui.xml"
      exit 2
    fi
    local png="$ART/$label-$i.png"
    capture "$png"
    local m; m="$(metrics "$png" $region)"
    best="$(python3 -c "b='$best'.split(); m='$m'.split(); print(' '.join(str(max(float(b[i]), float(m[i]))) for i in range(3)))")"
    attempt_png="$png"
    read -r std lum _ <<<"$m"
    if python3 -c "import sys; sys.exit(0 if ($std >= 10 and $lum >= 60) else 1)"; then
      echo "PASS [$label] maxstd=$std mean_lum=$lum region=($region) png=$attempt_png"
      return 0
    fi
    sleep 1
  done
  read -r std lum uniq <<<"$best"
  echo "FAIL [$label] camera preview not rendering: maxstd=$std (<10) mean_lum=$lum (<60) uniq=$uniq region=($region) png=$ART/$label-*.png"
  grep -q 'resource-id="sol-pay-scan"' "$ART/ui.xml" && [ "$which" = sol ] && \
    python3 - "$ART/ui.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
for n in ET.parse(sys.argv[1]).getroot().iter('node'):
    if n.get('resource-id') == 'sol-pay-scan':
        b = n.get('bounds').strip('[]').split('][')
        y0, y1 = int(b[0].split(',')[1]), int(b[1].split(',')[1])
        if y1 - y0 < 200:
            print(f"   hint: scan container collapsed (h={y1 - y0}px) — is the QrScanner wrapper unstyled/content-sized?")
        break
PY
  exit 1
}

# ensure_wallet: fresh emulator data (read-only AVD) lands on Onboarding — create the demo
# wallet so the navigation below has its anchors. Idempotent: an existing wallet skips this
# (Onboarding never renders). Drives the full onboarding progression (create → 24-word backup
# checkbox → continue → optional faucet-fallback continue). Wallet-present anchor is the
# bottom tab bar (`tab-home`, outside the mode switch since 2026-09-08): the old `balance`
# anchor only renders on non-Home modes now, and Home is the landing mode — a fresh wallet
# would sit on Home forever waiting for an anchor that never comes.
ensure_wallet() {
  dump_ui || { echo "FAIL nav: uiautomator dump failed"; exit 2; }
  if grep -q 'resource-id="tab-home"' "$ART/ui.xml"; then
    echo "   wallet present"
    return 0
  fi
  echo "   no wallet (fresh emulator data) — creating demo wallet"
  local ok=""
  for _ in $(seq 1 60); do
    dump_ui || { sleep 1; continue; }
    if grep -q 'resource-id="tab-home"' "$ART/ui.xml"; then ok=1; break; fi
    local step
    step="$(python3 - "$ART/ui.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
nodes = list(ET.parse(sys.argv[1]).getroot().iter('node'))
rids = {n.get('resource-id'): n for n in nodes if n.get('resource-id')}
# only ever tap the backup checkbox while UNTICKED (avoids toggle loops); tapping the
# Continue button while still disabled is a harmless no-op, so no clickable check needed.
# The 24-word grid fills the viewport first — while the words are visible but the
# checkbox is not, scroll down to reveal the checkbox + Continue (uiautomator only dumps
# the visible viewport, so absent rids mean off-screen, not absent).
if 'mnemonic-backup-checkbox' in rids:
    cb = rids['mnemonic-backup-checkbox']
    if cb.get('checked') != 'true':
        print('mnemonic-backup-checkbox')
    else:
        print('btn-mnemonic-continue')
elif 'mnemonic-word-0' in rids:
    print('SCROLL')
elif 'btn-home-currency-back' in rids:
    # tapping a currency card also EXPANDS its per-rail detail panel (EUR landing, 2026-09-06),
    # which pushes Continue below the uiautomator viewport; collapse it (selection is kept) so
    # btn-home-currency-continue returns to the visible viewport.
    print('btn-home-currency-back')
elif 'home-currency-USD' in rids:
    # home-currency picker (2026-09 onboarding): radio card — only tap while UNCHECKED
    # (avoids toggle loops); Continue while still disabled is a harmless no-op.
    cur = rids['home-currency-USD']
    if cur.get('checked') != 'true':
        print('home-currency-USD')
    else:
        print('btn-home-currency-continue')
elif 'btn-create' in rids:
    print('btn-create')
elif 'btn-onboard-continue' in rids:
    print('btn-onboard-continue')
elif 'btn-walkthrough-next' in rids:
    # post-creation "How dpay works" tour (flows 88/89): auto-opens on a fresh wallet and
    # blocks the Wallet surface; its Next is also the final "Get started" (same testID).
    print('btn-walkthrough-next')
elif 'btn-rehearsal-next' in rids:
    # post-creation payment rehearsal coach (flow 87): same fresh-wallet gate; its Next is
    # also the final "Try with demo funds" (same testID).
    print('btn-rehearsal-next')
PY
)"
    if [ "$step" = "SCROLL" ]; then
      # swipe up (bottom-center → mid-center) to reveal the checkbox/continue under the word grid
      $ADB shell input swipe 540 1900 540 800 300 || true
    elif [ -n "$step" ]; then
      echo "   onboarding: tap $step"
      tap_rid "$step" || true
    fi
    sleep 1
  done
  [ -n "$ok" ] || { echo "FAIL nav: wallet creation did not reach the Wallet surface (no 'tab-home' anchor); ui dump: $ART/ui.xml"; exit 2; }
  echo "   demo wallet created"
}
ensure_wallet

echo "== IC (DEMO asset) Pay scan screen — positive control =="
check_screen demo btn-accounts-currency-CHF ic

echo "== SOL Pay scan screen — the reported regression =="
check_screen sol btn-accounts-currency-SOL sol

echo "== camera-preview gate GREEN on both rails =="
