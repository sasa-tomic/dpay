#!/usr/bin/env python3
"""Generate the web wallet's WOFF2 fonts from the Android TTFs, and PROVE no glyph was lost.

ONE font source in this repo: `app/android/app/src/main/res/font/*.ttf` (what the APK serves).
`e2e/web/fonts/*.woff2` is derived from it here — the web build used to carry byte-identical TTF
copies, which was both a duplicate and 338 KB of uncompressed wire (OPEN_ISSUES X12: every one of
them measured `encodedBodySize === decodedBodySize`).

Two transforms, in this order:

1. **Subset** to the codepoints this app can actually paint (see `keep_set`): ASCII, the full
   Latin-1 Supplement + Latin Extended-A + Latin Extended Additional (so a European or Vietnamese
   name renders in-font), combining marks, General Punctuation, the Currency Symbols block, the
   Letterlike block, and every non-ASCII codepoint that literally occurs in `app/**` or
   `crates/dpay-relay/src/**`. Layout features (GSUB/GPOS/kerning) and name records are kept, so
   metrics are unchanged for every glyph that survives — the rendering of kept text is identical.

2. **WOFF2** (brotli-compressed inside the container). The relay must NOT compress these again:
   see `COMPRESSIBLE` in e2e/vite.config.js.

The GATE (`verify`, run on every invocation and by `just fonts`) is an EQUIVALENCE, not a guess:
for every codepoint in the audit set, coverage in the subset must EQUAL coverage in the source
font. A codepoint the source never had must still be absent; a codepoint the source had must
still be present. Anything else fails LOUD and writes nothing. (This repo has a history here:
`Ξ` U+039E is absent from all four faces and reaches the user through system fallback. `◎`
U+25CE was in that class until 2026-09-14, when the SOL glyph became the in-font `•` U+2022 —
already inside the kept 0x2000-0x2070 range and never present in any TTF cmap, so that swap
changed neither keep_set nor the committed woff2 output.)

Run: `just fonts` (or `python3 scripts/subset-web-fonts.py`). Needs fontTools + brotli; it is NOT
on the inner loop — the generated .woff2 files are committed, exactly as the .ttf files were.
"""
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "app/android/app/src/main/res/font"
OUT_DIR = ROOT / "e2e/web/fonts"
FACES = ["plex_mono_500", "space_grotesk_500", "space_grotesk_600", "space_grotesk_700"]

# Source trees whose text can reach a glyph: the whole app (every i18n locale lives here) and the
# relay's compiled catalog/checkout strings (server-supplied display text).
SCAN = [(ROOT / "app", (".ts", ".tsx")), (ROOT / "crates/dpay-relay/src", (".rs",))]
SCAN_SKIP = {"node_modules", "android", "ios", ".e2e-dist", "build", "shots"}


def source_codepoints() -> set:
    """Every codepoint that literally occurs in the scanned sources (a superset of the UI strings)."""
    found = set()
    for root, exts in SCAN:
        for path in root.rglob("*"):
            if any(part in SCAN_SKIP for part in path.relative_to(root).parts):
                continue
            if path.is_file() and path.suffix in exts:
                found.update(ord(ch) for ch in path.read_text(encoding="utf-8", errors="strict"))
    return {cp for cp in found if cp >= 0x20}


def keep_set(src_cps: set) -> set:
    return (
        set(range(0x20, 0x7F))       # ASCII printable
        | set(range(0xA0, 0x180))    # Latin-1 Supplement + Latin Extended-A (de/fr/es + names)
        | set(range(0x300, 0x370))   # Combining Diacritical Marks (a decomposed/NFD name)
        | set(range(0x1E00, 0x1F00))  # Latin Extended Additional (Vietnamese names)
        | set(range(0x2000, 0x2070))  # General Punctuation (– — … ' " • ‰ narrow spaces)
        | set(range(0x20A0, 0x20C0))  # Currency Symbols (₿ € ₣ …)
        | set(range(0x2100, 0x2150))  # Letterlike (™ № Ω)
        | {cp for cp in src_cps if cp >= 0xA0}  # everything the source actually writes
    )


def audit_set(src_cps: set, keep: set) -> set:
    """What `verify` checks. The keep set PLUS the non-ASCII source codepoints deliberately left
    out of it — so a codepoint dropped by mistake cannot hide."""
    return keep | {cp for cp in src_cps if cp >= 0xA0}


def main() -> int:
    if not SRC_DIR.is_dir():
        sys.exit(f"font source {SRC_DIR} missing — it is the APK's res/font directory (tracked)")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    src_cps = source_codepoints()
    keep = keep_set(src_cps)
    audit = audit_set(src_cps, keep)
    print(f"source codepoints: {len(src_cps)} (non-ASCII {len({c for c in src_cps if c >= 0xA0})})")
    print(f"keep set: {len(keep)} codepoints · audit set: {len(audit)}")

    failures = []
    total_src = total_out = 0
    for face in FACES:
        src = SRC_DIR / f"{face}.ttf"
        out = OUT_DIR / f"{face}.woff2"
        if not src.is_file():
            sys.exit(f"missing {src}")

        original_cmap = set(TTFont(str(src), lazy=True).getBestCmap())

        font = TTFont(str(src))
        opts = Options()
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.notdef_outline = True
        sub = Subsetter(options=opts)
        sub.populate(unicodes=keep)
        sub.subset(font)
        font.flavor = "woff2"

        subset_cmap = set(font.getBestCmap())
        # THE GATE: identical coverage over the audit set. Not "the glyphs I wanted are there" —
        # "coverage did not change", which is the only claim that cannot regress silently.
        lost = sorted((original_cmap & audit) - subset_cmap)
        gained = sorted(subset_cmap - original_cmap)
        if lost or gained:
            failures.append((face, lost, gained))

        font.save(str(out))
        font.close()
        s_bytes, o_bytes = src.stat().st_size, out.stat().st_size
        total_src += s_bytes
        total_out += o_bytes
        absent = sorted(cp for cp in audit if cp not in original_cmap and cp in {c for c in src_cps if c >= 0xA0})
        print(
            f"{face}: {s_bytes:>7} B ttf → {o_bytes:>6} B woff2 ({o_bytes / s_bytes:.0%})  "
            f"cmap {len(original_cmap)} → {len(subset_cmap)}  "
            f"(source codepoints this face never had, unchanged: {len(absent)})"
        )

    if failures:
        for face, lost, gained in failures:
            print(f"FAIL {face}: lost={[f'U+{c:04X}' for c in lost]} gained={[f'U+{c:04X}' for c in gained]}")
        sys.exit("coverage changed — nothing was written that a screen can trust; fix keep_set")

    print(f"TOTAL: {total_src} B → {total_out} B ({total_out / total_src:.0%}), saved {total_src - total_out} B")
    print("coverage gate: PASS — every audited codepoint has the same presence as in the source TTF")
    return 0


if __name__ == "__main__":
    sys.exit(main())
