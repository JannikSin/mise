"""Badged icon set for the SANDBOX build (Mise NEXT), written OUTSIDE the shipped
tree at tools/icons-next/. tools/sandbox-deploy.ps1 copies these three files
over icons/icon-192.png, icons/icon-512.png and icons/apple-touch-icon.png in
the DEPLOY COPY ONLY, so the phone shows a visibly different icon for the
sandbox while paths, the SW SHELL list and the deploy allowlist stay untouched
(Tribunal plan gate, Historian 2 / Red Team 10 / Engineer N4, 2026-09-07).

Run:  python tools/icons-next.py
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "icons"
OUT = ROOT / "tools" / "icons-next"
OUT.mkdir(parents=True, exist_ok=True)

ORANGE = (255, 149, 0, 255)  # unmistakable against the app's near-black ground


def badge(name: str) -> None:
    im = Image.open(SRC / name).convert("RGBA")
    w, h = im.size
    # warm tint over the whole icon so the two tiles never read as twins
    tint = Image.new("RGBA", im.size, (255, 149, 0, 70))
    im = Image.alpha_composite(im, tint)
    d = ImageDraw.Draw(im)
    # a solid corner band with NEXT on it
    band_h = max(18, h // 5)
    d.rectangle([0, h - band_h, w, h], fill=ORANGE)
    text = "NEXT"
    size = max(10, band_h - 6)
    try:
        font = ImageFont.truetype("arialbd.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    box = d.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(((w - tw) / 2 - box[0], h - band_h + (band_h - th) / 2 - box[1]), text, fill=(12, 15, 17, 255), font=font)
    im.save(OUT / name, optimize=True)
    print("wrote", OUT / name, im.size)


for n in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"):
    badge(n)
