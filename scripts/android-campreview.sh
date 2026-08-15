#!/usr/bin/env bash
# Camera-preview device gate — REAL pixels, ZERO mocks.
#
# Drives the REAL installed APK (org.kalaj.dpay) on the REAL emulator through the IC (DEMO) and
# SOL Pay scan screens (Balances → asset row), then asserts that REAL camera pixels from the
# emulated camera HAL (virtual scene) are visible inside the scan box:
#   PASS ⟺ per-channel stddev ≥ 10 AND mean luminance ≥ 60 over the box crop.
# Measured on dpay_api36: healthy virtual-scene feed = std 79–84, lum ~194; collapsed/flat box =
# std 0.00, lum ~7.7; permission-placeholder branch = std 2.5, lum ~7.7 (the luminance guard is
# what kills that false-positive — unique-color count alone cannot discriminate).
#
# This catches the class of bug the browser e2e is structurally blind to (web camera shim renders
# the placeholder branch, which has intrinsic width): a scan-screen layout change that collapses
# the camera preview to 0×0 (e.g. an unstyled, content-sized wrapper around <QrScanner/>).
#
# Exit codes: 0 = green on both screens; 1 = camera preview not rendering (the regression);
# 2 = UI navigation/anchor failure (app UI changed — fix the script's anchors); 3 = device/app
# environment failure (no device, no self-check).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PKG=org.kalaj.dpay
ACT=org.kalaj.dpay/com.dpay.MainActivity
ART="$(mktemp -d /tmp/opencode/campreview.XXXXXX)"
trap 'echo "   artifacts: $ART" >&2' EXIT

export ANDROID_HOME="${ANDROID_HOME:-/home/sat/Android/Sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

ADB=adb
if [ -n "${ANDROID_SERIAL:-}" ]; then ADB="adb -s $ANDROID_SERIAL"; fi

echo "== require a booted device =="
$ADB wait-for-device
BOOTED="$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
[ "$BOOTED" = "1" ] || { echo "FAIL: no fully-booted device (sys.boot_completed=$BOOTED)"; exit 3; }
echo "   device: $($ADB devices | awk 'NR==2{print $1}')"

echo "== require the app installed + camera permission granted =="
$ADB shell pm list packages 2>/dev/null | tr -d '\r' | grep -q "^package:$PKG$" \
  || { echo "FAIL: $PKG not installed (run: just app)"; exit 3; }
$ADB shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null || true

echo "== (re)launch + wait for the on-device self-check =="
$ADB shell am force-stop "$PKG"
$ADB logcat -c 2>/dev/null || true
$ADB shell am start -n "$ACT" >/dev/null
SELFCHECK=""
for _ in $(seq 1 30); do
  if $ADB logcat -d -s ReactNativeJS:V 2>/dev/null | grep -q 'DPAY_SELFCHECK PASS'; then SELFCHECK=1; break; fi
  sleep 1
done
[ -n "$SELFCHECK" ] || { echo "FAIL: DPAY_SELFCHECK PASS not seen within 30s"; exit 3; }
echo "   DPAY_SELFCHECK PASS"

# ---- helpers ---------------------------------------------------------------

# dump_ui: fresh uiautomator XML at $ART/ui.xml (retries — dump occasionally misses idle state)
dump_ui() {
  for _ in 1 2 3; do
    if $ADB shell uiautomator dump /sdcard/campreview-ui.xml >/dev/null 2>&1; then
      $ADB shell cat /sdcard/campreview-ui.xml 2>/dev/null | tr -d '\r' > "$ART/ui.xml"
      [ -s "$ART/ui.xml" ] && grep -q "</hierarchy>" "$ART/ui.xml" && return 0
    fi
    sleep 1
  done
  return 1
}

# tap_rid <resource-id>: tap the center of the first node carrying resource-id
tap_rid() {
  local rid="$1"
  dump_ui || { echo "FAIL nav: uiautomator dump failed"; exit 2; }
  local xy
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
  [ -n "$xy" ] || { echo "FAIL nav: anchor '$rid' not found; ui dump: $ART/ui.xml"; exit 2; }
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

# check_screen <label> <asset-rid> <ic|sol>: navigate Balances → asset → assert live pixels
check_screen() {
  local label="$1" rid="$2" which="$3"
  tap_rid balance
  sleep 2
  tap_rid "$rid"
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
# wallet so the Balances navigation below has its `balance` anchor. Idempotent: an existing
# wallet skips this (Onboarding never renders). Drives the full onboarding progression
# (create → 24-word backup checkbox → continue → optional faucet-fallback continue).
ensure_wallet() {
  dump_ui || { echo "FAIL nav: uiautomator dump failed"; exit 2; }
  if grep -q 'resource-id="balance"' "$ART/ui.xml"; then
    echo "   wallet present"
    return 0
  fi
  echo "   no wallet (fresh emulator data) — creating demo wallet"
  local ok=""
  for _ in $(seq 1 60); do
    dump_ui || { sleep 1; continue; }
    if grep -q 'resource-id="balance"' "$ART/ui.xml"; then ok=1; break; fi
    local step
    step="$(python3 - "$ART/ui.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
nodes = list(ET.parse(sys.argv[1]).getroot().iter('node'))
rids = {n.get('resource-id'): n for n in nodes if n.get('resource-id')}
# only ever tap the backup checkbox while UNTICKED (avoids toggle loops); tapping the
# Continue button while still disabled is a harmless no-op, so no clickable check needed.
if 'mnemonic-backup-checkbox' in rids:
    cb = rids['mnemonic-backup-checkbox']
    if cb.get('checked') != 'true':
        print('mnemonic-backup-checkbox')
    else:
        print('btn-mnemonic-continue')
elif 'btn-create' in rids:
    print('btn-create')
elif 'btn-onboard-continue' in rids:
    print('btn-onboard-continue')
PY
)"
    if [ -n "$step" ]; then
      echo "   onboarding: tap $step"
      tap_rid "$step" || true
    fi
    sleep 1
  done
  [ -n "$ok" ] || { echo "FAIL nav: wallet creation did not reach the Wallet surface (no 'balance' anchor); ui dump: $ART/ui.xml"; exit 2; }
  echo "   demo wallet created"
}
ensure_wallet

echo "== IC (DEMO asset) Pay scan screen — positive control =="
check_screen demo asset-demo-select ic

echo "== SOL Pay scan screen — the reported regression =="
check_screen sol asset-sol-select sol

echo "== camera-preview gate GREEN on both rails =="
