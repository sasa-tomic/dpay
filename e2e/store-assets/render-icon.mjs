// Renders the 512×512 Play Store icon — a ∂ (partial differential) in brand green
// on a dark background with a subtle radial glow.
//
// Uses PIL (not headless chrome) because DejaVu Serif regular is the ONLY system
// font that renders the ∂ glyph (U+2202) recognizably — verified via vision.
// Browser CSS text-rendering produces an ambiguous "a" shape from the same font.
//
// Output → .dev/store-assets/icon-512.png
// Run: node e2e/store-assets/render-icon.mjs

import { execSync } from 'node:child_process';

const PY = `
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 512, 512
BG = (10, 12, 17)        # #0a0c11
BRAND = (255, 90, 31)    # #FF5A1F

# Background with subtle radial glow
img = Image.new('RGBA', (W, H), (*BG, 255))
glow_bg = Image.new('RGBA', (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_bg)
cx, cy = W // 2, int(H * 0.38)
for r in range(260, 0, -3):
    a = int(30 * (1 - r / 260) ** 2)
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*BRAND, a))
img = Image.alpha_composite(img, glow_bg.filter(ImageFilter.GaussianBlur(30)))

# DejaVu Serif REGULAR renders U+2202 most recognizably
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 340)

# Measure + center
tmp = Image.new('RGBA', (W, H), (0, 0, 0, 0))
td = ImageDraw.Draw(tmp)
bbox = td.textbbox((0, 0), '\\u2202', font=font)
sw, sh = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (W - sw) // 2 - bbox[0]
y = (H - sh) // 2 - bbox[1] + 15

# Soft glow behind symbol
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).text((x, y), '\\u2202', font=font, fill=(*BRAND, 70))
glow = glow.filter(ImageFilter.GaussianBlur(8))
img = Image.alpha_composite(img, glow)

# Sharp symbol
sym = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(sym).text((x, y), '\\u2202', font=font, fill=BRAND)
img = Image.alpha_composite(img, sym)

img.convert('RGB').save('.dev/store-assets/icon-512.png', 'PNG')
print('done')
`;

execSync(`python3 -c '${PY.replace(/'/g, "'\\''")}'`, { stdio: 'inherit', cwd: process.cwd() });
console.log('✓ icon-512.png (512×512, ∂)');
